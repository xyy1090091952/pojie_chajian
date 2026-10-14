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

  // 4) 若是加注，必须先把金额"确认填进"输入框，才允许点加注按钮。
  //    这是防「误 all in」的核心安全阀：很多站点的加注滑块默认停在最大值，
  //    若我们没找到输入框、或值没真正填进去（滑块/受控组件），直接点加注就会全下。
  //    所以这里一旦金额没落实，就【放弃加注，降级到更安全的动作】，绝不盲点。
  if (action === POKER_ACTION.RAISE && decision.amount > 0) {
    const input = findBetInput(BET_INPUT_RULES);
    const filled = input ? setInputValue(input, decision.amount) : false;
    if (!filled) {
      // 金额没落实 => 不冒险加注，退回安全动作（优先过牌，其次弃牌）。
      return fallbackToSafeAction(
        input ? '加注金额未能确认填入（可能是滑块/受控组件），为避免误全下已降级。'
              : '未找到加注金额输入框，为避免误全下已降级。'
      );
    }
    await sleep(200); // 给框架一点时间消化输入
  }

  // 5) 点击！
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
