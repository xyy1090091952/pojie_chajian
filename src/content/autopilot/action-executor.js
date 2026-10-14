/**
 * 托管·动作执行器（把"决策"真正变成页面上的点击）
 * ------------------------------------------------------------
 * 职责（单一）：收到一个决策 {action, amount}，在页面上找到对应按钮并点击；
 *   若是加注，先把金额填进输入框再点"加注"。只负责"手"，不负责"脑"。
 *
 * 拟人化 & 安全：
 *   - 点击前随机等待一小段时间（像真人思考），区间由 AUTOPILOT 配置。
 *   - 找不到按钮就放弃本次（返回失败），绝不乱点。
 *
 * 和项目一致的分层：规则（怎么认按钮）来自 constants.js；
 *   执行器只按规则找、按决策点，规则与逻辑解耦。
 */

import {
  POKER_ACTION,
  POKER_ACTION_NAMES,
  ACTION_BUTTON_RULES,
  BET_INPUT_RULES,
  NEXT_HAND_BUTTON_RULES,
  AUTOPILOT,
} from '../../common/constants.js';
import { findActionButton, findBetInput, isActionable } from './dom-locator.js';

/** 返回 [min, max] 区间内的随机整数毫秒数（拟人化延迟用） */
function randomDelay() {
  const min = AUTOPILOT.ACTION_DELAY_MIN_MS;
  const max = AUTOPILOT.ACTION_DELAY_MAX_MS;
  return Math.floor(min + Math.random() * Math.max(0, max - min));
}

/** 一个"等待 ms 毫秒"的 Promise，便于用 await 写顺序逻辑 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 轮询等待某个条件成立（最多等 timeoutMs 毫秒），用来等"点开后才出现的元素"。
 *   为什么需要它：River 的加注金额输入框是【点一下加注按钮才弹出】的浮层(.raise-popover)，
 *   弹出有一点点动画/异步延迟，直接找会扑空。这里每隔 intervalMs 轮询一次，
 *   一旦 getter 返回"真值"就立刻返回它；超时还没有就返回 null（交给上层降级）。
 * @param {() => (Element|null)} getter 每次轮询执行、返回目标元素或 null 的函数
 * @param {number} [timeoutMs=1200] 最长等待毫秒
 * @param {number} [intervalMs=80]  轮询间隔毫秒
 * @returns {Promise<Element|null>}
 */
async function waitFor(getter, timeoutMs = 1200, intervalMs = 80) {
  const deadline = Date.now() + timeoutMs;
  // 先立刻试一次（可能本来就在，省得白等一轮）
  let el = getter();
  if (el) return el;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    el = getter();
    if (el) return el;
  }
  return null;
}

/**
 * 给输入框"像真人一样"赋值：先聚焦，设置 value，再派发 input/change 事件。
 *   很多前端框架（React/Vue）只认事件，不派发事件它不会更新内部状态。
 * @param {HTMLInputElement} input
 * @param {number} value
 * @returns {boolean} 是否"确认填进去了"——读回 input.value 和目标值一致才算成功。
 *   为什么要读回确认：如果控件是滑块(range)或受控组件没接受我们的值，
 *   value 不会等于目标值，这时返回 false，上层会据此降级，绝不盲目点"加注"。
 */
function setInputValue(input, value) {
  input.focus();
  // 用原生 setter 赋值，确保 React 这类框架能感知到变化
  const proto = Object.getPrototypeOf(input);
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) {
    desc.set.call(input, String(value));
  } else {
    input.value = String(value);
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  // 读回确认：相等才算真正填成功（滑块被 min/max/step 夹过值会不等 => 返回 false 走降级）。
  return String(input.value) === String(value);
}

/**
 * 读取一个数值型 HTML 属性（min/max/step）。读不到或非数字返回 null。
 * @param {Element|null} el
 * @param {string} name 属性名
 * @returns {number|null}
 */
function readNumAttr(el, name) {
  if (!el) return null;
  const n = parseFloat(el.getAttribute(name));
  return Number.isFinite(n) ? n : null;
}

/**
 * 把目标金额"夹"成一个站点一定接受的合法值（避免"低于最低下注/超过筹码"被拒、卡住）。
 * ------------------------------------------------------------
 * 合法范围优先使用决策对象里的 minRaiseTo / maxRaiseTo：
 *   它们来自牌桌实时数据 view.actions，是服务器明确认可的真实范围。
 *   文字框自身的 min/max/step 只作为兼容其它站点的备用数据。
 *
 * 重要：River 的滑块 min=0、max=107 是“档位索引”，不是筹码值，绝不能拿来夹金额。
 * @param {HTMLInputElement} input 文字金额框（填值用）
 * @param {object} decision 决策对象，包含服务器下发的合法加注范围
 * @param {number} value 策略想要的目标金额
 * @returns {number} 夹到合法区间、对齐步长后的金额
 */
function clampToInputConstraints(input, decision, value) {
  let v = Number(value);
  if (!Number.isFinite(v)) return value;

  // 边界优先级：服务器实时数据 > 文字框自身属性。
  const decisionMin = Number(decision?.minRaiseTo);
  const decisionMax = Number(decision?.maxRaiseTo);
  const minAttr =
    Number.isFinite(decisionMin) && decisionMin > 0 ? decisionMin : readNumAttr(input, 'min');
  const maxAttr =
    Number.isFinite(decisionMax) && decisionMax > 0 ? decisionMax : readNumAttr(input, 'max');
  const stepAttr = readNumAttr(input, 'step');

  // 先夹上限(不超过全下)，再夹下限(不低于最小合法加注)。
  //   顺序先 max 后 min：即便站点把 min 设得等于/高于 max(短筹码只能全下)，
  //   结果也会落在 min 上，是站点允许的合法值。
  if (Number.isFinite(maxAttr)) v = Math.min(v, maxAttr);
  if (Number.isFinite(minAttr)) v = Math.max(v, minAttr);

  // 对齐 step(从 min 起跳)，避免出现 2.5 这类站点不接受的值。
  if (Number.isFinite(stepAttr) && stepAttr > 0) {
    const base = Number.isFinite(minAttr) ? minAttr : 0;
    v = base + Math.round((v - base) / stepAttr) * stepAttr;
    if (Number.isFinite(maxAttr)) v = Math.min(v, maxAttr); // 对齐后可能略超上限，再收一次
    if (Number.isFinite(minAttr)) v = Math.max(v, minAttr);
  }

  // 筹码通常是整数：没有 step 或 step 为整数时取整，避免小数被拒。
  if (!Number.isFinite(stepAttr) || Number.isInteger(stepAttr)) v = Math.round(v);
  return v;
}

/**
 * 模拟一次真实点击：派发 mousedown/mouseup/click，兼容只认鼠标事件的站点。
 * @param {Element} el
 */
function humanClick(el) {
  const opts = { bubbles: true, cancelable: true, view: window };
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.click(); // 原生 click 覆盖大多数情况
}

/**
 * 【对外主函数】执行一个决策动作。
 * @param {object} decision {action, amount, reason, ...}（background 决策引擎产出）
 * @returns {Promise<{ok:boolean, action?:string, amount?:number, label?:string, reason:string}>}
 *   ok=true 表示成功点了；ok=false 带 reason 说明为何没点（如没找到按钮）。
 */
export async function executeDecision(decision) {
  if (!decision || !decision.action) {
    return { ok: false, reason: '没有有效决策，跳过。' };
  }

  const action = decision.action;
  const rule = ACTION_BUTTON_RULES[action];
  if (!rule) {
    return { ok: false, reason: `未知动作「${action}」，跳过。` };
  }

  // 1) 先找到动作按钮；找不到就不动（宁可不点也不乱点）。
  const btn = findActionButton(rule);
  if (!btn) {
    return { ok: false, reason: `页面上没找到「${POKER_ACTION_NAMES[action] || action}」按钮，跳过。` };
  }

  // 2) 拟人化等待：像真人思考一会儿再出手。
  await sleep(randomDelay());

  // 3) 等待后按钮可能已失效（局面变了），再确认一次可点。
  if (!isActionable(btn)) {
    return { ok: false, reason: '准备点击时按钮已失效（局面可能已变），跳过。' };
  }

  // 4) 若是加注：River 的金额输入框是"点开加注按钮才弹出的浮层"，所以必须【两段式】：
  //    ① 点一下加注按钮 → 展开"下注操作条"浮层(.raise-popover)
  //    ② 等金额输入框出现 → 把金额"确认填进去"（读回校验，防滑块/受控组件没吃到值）
  //    ③ 再点一次加注按钮 → 真正提交
  //    任一步没落实，就【放弃加注、降级到更安全动作】，绝不盲点（核心防误全下安全阀）。
  if (action === POKER_ACTION.RAISE && decision.amount > 0) {
    return await executeRaise(btn, decision);
  }

  // 5) 非加注动作（弃牌/过牌/跟注）：直接点击即可。
  humanClick(btn);

  return {
    ok: true,
    action,
    amount: Number(decision.amount) || 0,
    label: POKER_ACTION_NAMES[action] || action,
    reason: decision.reason || '',
  };
}

/**
 * 执行"加注"的两段式流程（独立成函数，便于复用/测试，也让主流程更清爽）。
 *   背景：River 的加注金额输入框在"下注操作条"浮层里，而浮层要点一下加注按钮才弹出。
 *   因此不能像以前那样"直接找框填值再点按钮"，必须先展开再填再提交。
 * @param {Element} raiseBtn 已找到并确认可点的加注按钮（.raise-trigger）
 * @param {object} decision  决策对象，至少含 amount（目标加注到的金额）
 * @returns {Promise<{ok:boolean, action?:string, amount?:number, label?:string, reason:string}>}
 */
async function executeRaise(raiseBtn, decision) {
  // ① 如果操作条还没展开（aria-expanded 不是 "true"），先点一下把它展开。
  //    有的实现点一次就展开、再点一次才提交；所以这里只在"未展开"时才点，避免误触发提交。
  const expanded = raiseBtn.getAttribute('aria-expanded') === 'true';
  if (!expanded) {
    humanClick(raiseBtn);
  }

  // ② 等"金额输入框"出现（浮层弹出有一点点异步/动画延迟，用轮询等它）。
  const input = await waitFor(() => findBetInput(BET_INPUT_RULES), 1500, 80);
  if (!input) {
    // 浮层没弹出或没找到框 => 不冒险，降级。
    return fallbackToSafeAction('展开加注操作条后仍未找到金额输入框，为避免误全下已降级。');
  }

  // ③ 把金额按"合法范围"夹成一定被接受的值，再确认填进去。
  //    合法范围来自服务器实时数据 minRaiseTo/maxRaiseTo，不读取 River 的索引滑块。
  //    这一步专治"低于最低下注(如 17<20)/超过筹码"被站点拒收、卡在那里的问题。
  const legalAmount = clampToInputConstraints(input, decision, decision.amount);
  const filled = setInputValue(input, legalAmount);
  if (!filled) {
    return fallbackToSafeAction(
      '加注金额未能确认填入（可能是滑块/受控组件），为避免误全下已降级。'
    );
  }
  await sleep(200); // 给框架一点时间消化输入，并让提交按钮刷新成最新金额

  // ④ 再次确认加注按钮仍可点（填完值后按钮通常会从"展开"变成"点击提交"）。
  //    重新按规则找一次按钮，防止填值过程中原引用失效。
  const submitBtn = findActionButton(ACTION_BUTTON_RULES[POKER_ACTION.RAISE]) || raiseBtn;
  if (!isActionable(submitBtn)) {
    return fallbackToSafeAction('准备提交加注时按钮已失效（局面可能已变），为稳妥已降级。');
  }

  // ⑤ 点击提交，真正完成加注。
  humanClick(submitBtn);

  return {
    ok: true,
    action: POKER_ACTION.RAISE,
    amount: legalAmount, // 上报"实际填进去的合法金额"，保证面板显示和真实下注一致
    label: POKER_ACTION_NAMES[POKER_ACTION.RAISE],
    reason: decision.reason || '',
  };
}

/**
 * 加注金额无法落实时的「安全降级」：绝不盲目点加注（防误 all in）。
 *   优先尝试"过牌"（免费、最安全）；没有过牌按钮再尝试"弃牌"（最多损失已投入筹码）；
 *   两者都找不到就什么都不做，交回控制权，等下一轮重新决策。
 * @param {string} why 触发降级的原因（写进返回 reason，便于日志排查）
 * @returns {{ok:boolean, action?:string, label?:string, reason:string}}
 */
function fallbackToSafeAction(why) {
  // 过牌最安全：不花钱、不弃牌。
  const checkBtn = findActionButton(ACTION_BUTTON_RULES[POKER_ACTION.CHECK]);
  if (checkBtn && isActionable(checkBtn)) {
    humanClick(checkBtn);
    return { ok: true, action: POKER_ACTION.CHECK, label: POKER_ACTION_NAMES[POKER_ACTION.CHECK], reason: `${why} 已改为过牌。` };
  }
  // 没法过牌（面前有下注要跟）=> 弃牌，至少不会把筹码全送进去。
  const foldBtn = findActionButton(ACTION_BUTTON_RULES[POKER_ACTION.FOLD]);
  if (foldBtn && isActionable(foldBtn)) {
    humanClick(foldBtn);
    return { ok: true, action: POKER_ACTION.FOLD, label: POKER_ACTION_NAMES[POKER_ACTION.FOLD], reason: `${why} 已改为弃牌。` };
  }
  // 实在找不到安全按钮：什么都不点，交回控制权。
  return { ok: false, reason: `${why} 且未找到可用的过牌/弃牌按钮，本次不操作。` };
}

/**
 * 【对外】尝试点击"开始下一手 / 开局"按钮（房主专用）。
 *   和出牌动作分开，是因为它不依赖"轮到我"、也不需要决策——
 *   只要页面上出现了可点的"开始"按钮，就替房主点一下进下一局。
 *
 * 为什么同样加拟人化延迟：避免一出现按钮就瞬间点击，像机器人。
 * @returns {Promise<{ok:boolean, reason:string}>}
 *   ok=true 表示点了；ok=false 表示没找到按钮（通常意味着不是房主、或还不能开始）。
 */
export async function clickNextHand() {
  // 1) 先找"开始下一手"按钮；找不到就什么都不做（非房主/未到可开始状态都属正常）。
  const btn = findActionButton(NEXT_HAND_BUTTON_RULES);
  if (!btn) {
    return { ok: false, reason: '未发现可点的"开始下一手"按钮。' };
  }

  // 2) 拟人化等待后再点。
  await sleep(randomDelay());

  // 3) 等待后再确认一次仍可点（局间状态可能变化）。
  if (!isActionable(btn)) {
    return { ok: false, reason: '"开始下一手"按钮已失效，跳过。' };
  }

  // 4) 点击！
  humanClick(btn);
  return { ok: true, reason: '已自动开始下一手。' };
}
