/**
 * 托管·控制器（内容世界的"总指挥"）
 * ------------------------------------------------------------
 * 职责（单一）：把各模块串成一个闭环，但自己不含任何扑克逻辑。
 *   循环：读配置 → 轮询"轮到我了吗" → 轮到了就问后台要决策 → 执行 → 上报。
 *
 * 为什么逻辑放这里、而决策放后台（background）：
 *   - 牌局数据都在后台（抓包都汇总在那），决策引擎也在后台，数据离计算最近；
 *   - 内容世界只做"眼睛(看轮次)+手(点按钮)"，职责清爽，便于维护。
 *
 * 状态来源（单一数据源原则）：
 *   开关/档位/对手风格都存在 chrome.storage.local，面板写、这里读；
 *   并监听 storage 变化，用户在面板一开关，这里立刻生效，状态始终一致。
 *
 * 上报给后台的三类消息（后台汇总成"托管会话"，再整体推给面板）：
 *   - AUTOPILOT_STATUS：运行状态（关闭/等待/思考/已出手/跳过+原因）
 *   - AUTOPILOT_PLAN  ：决策已出、还没点（拟人延迟中）的"预告"
 *   - AUTOPILOT_ACTED ：真正点下去的动作（进历史、进统计）
 */

import {
  AUTOPILOT,
  AUTOPILOT_STATUS,
  AUTOPILOT_CONFIG_FIELDS,
  TURN_INDICATOR_RULES,
  RUNTIME_MESSAGE,
  POKER_ACTION,
  POKER_ACTION_NAMES,
  DEFAULT_STRATEGY_TIER,
  DEFAULT_OPPONENT_STYLE,
  DEFAULT_AGGRESSION_PROFILE,
  DEFAULT_VALUE_BET_PROFILE,
  DEFAULT_PREFLOP_ENTRY_PROFILE,
  NEXT_HAND_ACTION,
} from '../../common/constants.js';
import { isMyTurn } from './turn-detector.js';
import { executeDecision, clickNextHand } from './action-executor.js';
// 后台保活：托管开启时播放静音，防止浏览器把"后台标签"的轮询定时器降速（详见 keep-alive.js）。
import { startKeepAlive, stopKeepAlive } from './keep-alive.js';

// 配置项对照表（字段 -> storage 键 -> 默认值）统一放在 constants.js，面板和这里共用
const CONFIG_FIELDS = AUTOPILOT_CONFIG_FIELDS;

// ============ 本地运行状态（集中管理，避免散落全局变量） ============
const state = {
  enabled: AUTOPILOT.DEFAULT_ENABLED, // 托管总开关
  tier: DEFAULT_STRATEGY_TIER, // 策略档位
  opponentStyle: DEFAULT_OPPONENT_STYLE, // 对手类型（auto=自动识别，或手选风格）
  aggressionProfile: DEFAULT_AGGRESSION_PROFILE, // 整体打法倾向
  valueBetProfile: DEFAULT_VALUE_BET_PROFILE, // 大牌价值下注力度
  preflopEntryProfile: DEFAULT_PREFLOP_ENTRY_PROFILE, // 翻牌前入池意愿（便宜时差牌要不要看翻牌）
  autoNextHand: AUTOPILOT.AUTO_NEXT_HAND, // 房主：是否自动开始下一手
  timer: null, // 轮询定时器句柄
  busy: false, // 正在处理一次行动（防止重入）
  lastActionAt: 0, // 上次成功"出牌"的时间戳（配合冷却时间防重复点）
  lastNextHandAt: 0, // 上次成功点"开始下一手"的时间戳（单独冷却，避免局间连点）
  lastSignature: '', // 上次出手时的"局面指纹"：局面没变就不再出手（防重复）
  lastSignatureAt: 0, // 上次按该指纹出手的时间
  lastStatusKey: '', // 上次上报的状态（相同就不重复发，避免轮询刷屏）
  seenTable: false, // 这个页面/iframe 是否出现过牌桌动作区（只有它才上报状态，避免多个 iframe 互相覆盖）
};

// ============ 1) 读取 & 监听配置（单一数据源：chrome.storage.local） ============
function loadConfig() {
  chrome.storage.local.get(
    CONFIG_FIELDS.map((c) => c.key),
    (cfg) => {
      // 用 ?? 兜底：storage 里没存过时用默认值，保证字段永远有效。
      for (const { field, key, fallback } of CONFIG_FIELDS) {
        state[field] = cfg[key] ?? fallback;
      }
      syncLoop();
    }
  );
}

// 监听面板对配置的修改：开关一变立即启停，档位/风格/自动开局一变下次就用新值。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const { field, key, fallback } of CONFIG_FIELDS) {
    if (key in changes) state[field] = changes[key].newValue ?? fallback;
  }
  syncLoop();
});

// ============ 2) 根据开关启停轮询循环 ============
//   "已关闭/已开启"的状态由后台监听 storage 直接更新（见 service-worker），这里只管启停循环。
function syncLoop() {
  if (state.enabled && !state.timer) {
    state.lastStatusKey = ''; // 重新开启后允许再次上报"等待中"
    state.timer = setInterval(tick, AUTOPILOT.TURN_POLL_MS);
    startKeepAlive(); // 开启托管：播放静音，防止后台标签把轮询降速
  } else if (!state.enabled && state.timer) {
    clearInterval(state.timer);
    state.timer = null;
    stopKeepAlive(); // 关闭托管：停掉静音，释放资源（标签上的小喇叭随之消失）
  }
}

/** 这个页面/iframe 里有没有牌桌动作区（有过一次就记住） */
function frameHasTable() {
  if (state.seenTable) return true;
  state.seenTable = (TURN_INDICATOR_RULES.actionZoneSelectors || []).some((sel) => {
    try {
      return !!document.querySelector(sel);
    } catch {
      return false;
    }
  });
  return state.seenTable;
}

/** 同一局面在重试窗口内已经出过手 => 不再出手（等牌桌数据更新） */
function alreadyActedOn(signature) {
  if (!signature || signature !== state.lastSignature) return false;
  return Date.now() - state.lastSignatureAt < AUTOPILOT.SAME_STATE_RETRY_MS;
}

// 执行层在拟人等待结束后会问一句"还要不要点"：托管被关了就不点（预告期间随时可以叫停）
const EXEC_OPTIONS = { isCancelled: () => !state.enabled };

// ============ 3) 每个轮询周期做的事 ============
async function tick() {
  // 开关关了 / 正在忙 —— 直接跳过。
  if (!state.enabled || state.busy) return;

  // 没轮到我：这时如果我是房主，页面可能出现"开始下一手"按钮，试着替房主点一下。
  //   注意出牌和开局用【各自独立的冷却】，互不影响。
  if (!isMyTurn(TURN_INDICATOR_RULES)) {
    // 刚出完手时保持"已出手"状态，其余时候显示"等待轮到你"
    if (frameHasTable() && state.lastStatusKey.split('|')[0] !== AUTOPILOT_STATUS.ACTED) {
      reportStatus(AUTOPILOT_STATUS.WAITING);
    }
    await maybeStartNextHand();
    return;
  }
  state.seenTable = true; // 轮到我了，说明牌桌就在这个页面里

  // 轮到我了：出牌动作有自己的冷却，防止同一局面连点。
  if (Date.now() - state.lastActionAt < AUTOPILOT.ACTION_COOLDOWN_MS) return;

  state.busy = true;
  try {
    // 3.1 向后台要一个决策（后台用抓包数据跑胜率 + 策略）。
    const decision = await requestDecision();
    if (!decision || !decision.ok) {
      // 后台说"这手不方便托管"（如数据不足），本轮放弃，等下一轮。
      reportStatus(AUTOPILOT_STATUS.SKIPPED, (decision && decision.reason) || '后台暂时没有回应。');
      return;
    }

    // 3.2 防重复：局面指纹和上次出手时一样，说明牌桌数据还没刷新（或点击还在路上），先别动。
    if (alreadyActedOn(decision.signature)) return;

    // 3.3 【预告】决策已出、但还没动手（executeDecision 里有 1.2~3.5 秒拟人延迟），
    //     先把"接下来打算怎么做"推给面板，让你能提前看到机器人的意图、来得及接管。
    reportStatus(AUTOPILOT_STATUS.THINKING);
    reportPlan(decision);

    // 3.4 执行决策（找按钮、拟人延迟、点击）。等待期间关掉托管会被取消。
    const result = await executeDecision(decision, EXEC_OPTIONS);
    reportPlan(null); // 无论成败，预告都结束了
    if (result.cancelled) return; // 你中途叫停了：什么都不记，状态由后台显示"已关闭"

    // 3.5 执行成功才进入冷却 + 记住局面指纹 + 上报"最近动作"。
    if (result.ok) {
      state.lastActionAt = Date.now();
      state.lastSignature = decision.signature || '';
      state.lastSignatureAt = state.lastActionAt;
      reportActed(result, decision);
      reportStatus(AUTOPILOT_STATUS.ACTED);
    } else {
      reportStatus(AUTOPILOT_STATUS.SKIPPED, result.reason);
    }
  } catch (e) {
    // 任意异常都不让循环崩溃，等下一轮
    reportStatus(AUTOPILOT_STATUS.SKIPPED, `执行出错：${e && e.message ? e.message : e}`);
  } finally {
    state.busy = false;
  }
}

/**
 * 房主专用：没轮到我出牌时，尝试点击"开始下一手"按钮。
 *   - 受 autoNextHand 开关管辖（面板可关）；
 *   - 用单独的 NEXT_HAND_COOLDOWN_MS 冷却，避免局间状态抖动导致连点；
 *   - 非房主/还不能开始时，executor 找不到按钮会返回 ok=false，这里静默跳过。
 */
async function maybeStartNextHand() {
  if (!state.autoNextHand) return;
  if (Date.now() - state.lastNextHandAt < AUTOPILOT.NEXT_HAND_COOLDOWN_MS) return;

  state.busy = true;
  try {
    const res = await clickNextHand(EXEC_OPTIONS);
    if (res.ok) {
      state.lastNextHandAt = Date.now();
      // 复用"最近动作"展示通道，让面板也能看到"已自动开始下一手"。
      reportNextHand(res);
      reportStatus(AUTOPILOT_STATUS.WAITING);
    }
  } catch (e) {
    // 吞掉异常，等下一轮
  } finally {
    state.busy = false;
  }
}

// ============ 4) 与后台通信 ============
/** 发一条消息给后台（统一吞掉"后台没就绪"之类的错误，不影响托管循环） */
function send(message) {
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch {
    /* 扩展刚重载时 chrome.runtime 可能失效，忽略 */
  }
}

/** 向后台请求一次决策，返回决策对象（Promise 化，便于 await） */
function requestDecision() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        {
          type: RUNTIME_MESSAGE.GET_DECISION,
          config: {
            tier: state.tier,
            opponentStyle: state.opponentStyle,
            aggressionProfile: state.aggressionProfile,
            valueBetProfile: state.valueBetProfile,
            preflopEntryProfile: state.preflopEntryProfile,
          },
        },
        (resp) => {
          // lastError 要读一下，否则控制台会报"未处理的回调错误"
          void chrome.runtime.lastError;
          resolve(resp || null);
        }
      );
    } catch {
      resolve(null); // service worker 没就绪时兜底
    }
  });
}

/**
 * 上报运行状态。状态和说明都没变时不重复发（轮询每 0.8 秒一次，避免刷屏）。
 * @param {string} status AUTOPILOT_STATUS 之一
 * @param {string} [detail] 补充说明（如跳过原因）
 */
function reportStatus(status, detail = '') {
  if (!state.seenTable) return; // 没有牌桌的 iframe 不发言，免得覆盖真正牌桌页面的状态
  const key = `${status}|${detail}`;
  if (key === state.lastStatusKey) return;
  state.lastStatusKey = key;
  send({ type: RUNTIME_MESSAGE.AUTOPILOT_STATUS, status, detail, at: Date.now() });
}

/**
 * 把"接下来打算做什么"预告给面板（在真正点击之前）；传 null 表示清空预告。
 * @param {object|null} decision 决策引擎产出的决策对象
 */
function reportPlan(decision) {
  send({
    type: RUNTIME_MESSAGE.AUTOPILOT_PLAN,
    plan: decision
      ? {
        action: decision.action,
        label: POKER_ACTION_NAMES[decision.action] || decision.action,
        // 跟注显示"要跟的钱"，加注显示"加注至"金额，其余为 0
        amount: decision.action === POKER_ACTION.CALL ? Number(decision.toCall) || 0 : Number(decision.amount) || 0,
        toCall: Number(decision.toCall) || 0, // 面板据此区分"下注"和"加注至"
        allIn: !!decision.allIn,
        reason: decision.reason || '',
        tier: decision.tier,
        equity: decision.equity ? decision.equity.equity : null,
        at: Date.now(),
      }
      : null,
  });
}

/** 把"刚执行的动作"上报后台，后台记进历史和统计，再转发给面板 */
function reportActed(result, decision) {
  send({
    type: RUNTIME_MESSAGE.AUTOPILOT_ACTED,
    acted: {
      action: result.action,
      label: result.label,
      amount: result.amount,
      toCall: Number(decision.toCall) || 0,
      // 执行层可能把动作改掉（如弃牌改过牌），只有最终仍是加注/跟注时才保留"全下"标记
      allIn: !!decision.allIn && result.action === decision.action,
      reason: result.reason,
      tier: decision.tier,
      equity: decision.equity ? decision.equity.equity : null,
      street: decision.street,
      stack: decision.stack, // 出手前的剩余筹码：后台用它推算本场盈亏
      at: Date.now(),
    },
  });
}

/** 把"自动开始下一手"也上报面板（复用同一展示通道，口径统一） */
function reportNextHand(res) {
  send({
    type: RUNTIME_MESSAGE.AUTOPILOT_ACTED,
    acted: {
      action: NEXT_HAND_ACTION,
      label: '开始下一手',
      amount: 0,
      allIn: false,
      reason: res.reason || '已自动开始下一手。',
      tier: state.tier,
      equity: null,
      street: null,
      stack: null,
      at: Date.now(),
    },
  });
}

// ============ 启动 ============
loadConfig();
