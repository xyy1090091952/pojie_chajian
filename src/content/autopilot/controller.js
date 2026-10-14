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
 */

import {
  AUTOPILOT,
  STORAGE_KEYS,
  TURN_INDICATOR_RULES,
  RUNTIME_MESSAGE,
  POKER_ACTION_NAMES,
  DEFAULT_STRATEGY_TIER,
  DEFAULT_OPPONENT_STYLE,
  DEFAULT_AGGRESSION_PROFILE,
  DEFAULT_VALUE_BET_PROFILE,
} from '../../common/constants.js';
import { isMyTurn } from './turn-detector.js';
import { executeDecision, clickNextHand } from './action-executor.js';

// ============ 本地运行状态（集中管理，避免散落全局变量） ============
const state = {
  enabled: AUTOPILOT.DEFAULT_ENABLED, // 托管总开关
  tier: DEFAULT_STRATEGY_TIER, // 策略档位
  opponentStyle: DEFAULT_OPPONENT_STYLE, // 对手牌力风格（影响决策胜率）
  aggressionProfile: DEFAULT_AGGRESSION_PROFILE, // 整体打法倾向
  valueBetProfile: DEFAULT_VALUE_BET_PROFILE, // 大牌价值下注力度
  autoNextHand: AUTOPILOT.AUTO_NEXT_HAND, // 房主：是否自动开始下一手
  timer: null, // 轮询定时器句柄
  busy: false, // 正在处理一次行动（防止重入）
  lastActionAt: 0, // 上次成功"出牌"的时间戳（配合冷却时间防重复点）
  lastNextHandAt: 0, // 上次成功点"开始下一手"的时间戳（单独冷却，避免局间连点）
};

// ============ 1) 读取 & 监听配置（单一数据源：chrome.storage.local） ============
function loadConfig() {
  chrome.storage.local.get(
    [
      STORAGE_KEYS.AUTOPILOT_ENABLED,
      STORAGE_KEYS.STRATEGY_TIER,
      STORAGE_KEYS.OPPONENT_STYLE,
      STORAGE_KEYS.AGGRESSION_PROFILE,
      STORAGE_KEYS.VALUE_BET_PROFILE,
      STORAGE_KEYS.AUTO_NEXT_HAND,
    ],
    (cfg) => {
      // 用 ?? 兜底：storage 里没存过时用默认值，保证字段永远有效。
      state.enabled = cfg[STORAGE_KEYS.AUTOPILOT_ENABLED] ?? AUTOPILOT.DEFAULT_ENABLED;
      state.tier = cfg[STORAGE_KEYS.STRATEGY_TIER] ?? DEFAULT_STRATEGY_TIER;
      state.opponentStyle = cfg[STORAGE_KEYS.OPPONENT_STYLE] ?? DEFAULT_OPPONENT_STYLE;
      state.aggressionProfile =
        cfg[STORAGE_KEYS.AGGRESSION_PROFILE] ?? DEFAULT_AGGRESSION_PROFILE;
      state.valueBetProfile =
        cfg[STORAGE_KEYS.VALUE_BET_PROFILE] ?? DEFAULT_VALUE_BET_PROFILE;
      state.autoNextHand = cfg[STORAGE_KEYS.AUTO_NEXT_HAND] ?? AUTOPILOT.AUTO_NEXT_HAND;
      syncLoop();
    }
  );
}

// 监听面板对配置的修改：开关一变立即启停，档位/风格/自动开局一变下次就用新值。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (STORAGE_KEYS.AUTOPILOT_ENABLED in changes) {
    state.enabled = changes[STORAGE_KEYS.AUTOPILOT_ENABLED].newValue ?? AUTOPILOT.DEFAULT_ENABLED;
  }
  if (STORAGE_KEYS.STRATEGY_TIER in changes) {
    state.tier = changes[STORAGE_KEYS.STRATEGY_TIER].newValue ?? DEFAULT_STRATEGY_TIER;
  }
  if (STORAGE_KEYS.OPPONENT_STYLE in changes) {
    state.opponentStyle = changes[STORAGE_KEYS.OPPONENT_STYLE].newValue ?? DEFAULT_OPPONENT_STYLE;
  }
  if (STORAGE_KEYS.AGGRESSION_PROFILE in changes) {
    state.aggressionProfile =
      changes[STORAGE_KEYS.AGGRESSION_PROFILE].newValue ?? DEFAULT_AGGRESSION_PROFILE;
  }
  if (STORAGE_KEYS.VALUE_BET_PROFILE in changes) {
    state.valueBetProfile =
      changes[STORAGE_KEYS.VALUE_BET_PROFILE].newValue ?? DEFAULT_VALUE_BET_PROFILE;
  }
  if (STORAGE_KEYS.AUTO_NEXT_HAND in changes) {
    state.autoNextHand = changes[STORAGE_KEYS.AUTO_NEXT_HAND].newValue ?? AUTOPILOT.AUTO_NEXT_HAND;
  }
  syncLoop();
});

// ============ 2) 根据开关启停轮询循环 ============
function syncLoop() {
  if (state.enabled && !state.timer) {
    state.timer = setInterval(tick, AUTOPILOT.TURN_POLL_MS);
  } else if (!state.enabled && state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

// ============ 3) 每个轮询周期做的事 ============
async function tick() {
  // 开关关了 / 正在忙 —— 直接跳过。
  if (!state.enabled || state.busy) return;

  // 没轮到我：这时如果我是房主，页面可能出现"开始下一手"按钮，试着替房主点一下。
  //   注意出牌和开局用【各自独立的冷却】，互不影响。
  if (!isMyTurn(TURN_INDICATOR_RULES)) {
    await maybeStartNextHand();
    return;
  }

  // 轮到我了：出牌动作有自己的冷却，防止同一局面连点。
  if (Date.now() - state.lastActionAt < AUTOPILOT.ACTION_COOLDOWN_MS) return;

  state.busy = true;
  try {
    // 3.1 向后台要一个决策（后台用抓包数据跑胜率 + 策略）。
    const decision = await requestDecision();
    if (!decision || !decision.ok) {
      // 后台说"这手不方便托管"（如数据不足），本轮放弃，等下一轮。
      return;
    }

    // 3.2 【预告】决策已出、但还没动手（executeDecision 里有 1.2~3.5 秒拟人延迟），
    //     先把"接下来打算怎么做"推给面板，让你能提前看到机器人的意图、来得及接管。
    reportPlan(decision);

    // 3.3 执行决策（找按钮、拟人延迟、点击）。
    const result = await executeDecision(decision);

    // 3.4 执行成功才进入冷却 + 上报面板展示"最近动作"。
    if (result.ok) {
      state.lastActionAt = Date.now();
      reportActed(result, decision);
    }
  } catch (e) {
    // 任意异常都不让循环崩溃，吞掉等下一轮
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
    const res = await clickNextHand();
    if (res.ok) {
      state.lastNextHandAt = Date.now();
      // 复用"最近动作"展示通道，让面板也能看到"已自动开始下一手"。
      reportNextHand(res);
    }
  } catch (e) {
    // 吞掉异常，等下一轮
  } finally {
    state.busy = false;
  }
}

// ============ 4) 与后台通信 ============
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
 * 把"接下来打算做什么"预告给面板（在真正点击之前）。
 *   复用和 reportActed 几乎一样的字段结构，但消息类型是 AUTOPILOT_PLAN，
 *   面板会把它显示在单独的"接下来"区域，和"最近动作"区分开。
 * @param {object} decision 决策引擎产出的决策对象 {action, amount, reason, tier, equity,...}
 */
function reportPlan(decision) {
  try {
    chrome.runtime
      .sendMessage({
        type: RUNTIME_MESSAGE.AUTOPILOT_PLAN,
        plan: {
          action: decision.action,
          // 优先用决策自带的中文标签；没有就用动作英文名兜底（面板还会再翻译一次）。
          label: decision.label || POKER_ACTION_NAMES[decision.action] || decision.action,
          amount: Number(decision.amount) || 0,
          reason: decision.reason || '',
          tier: decision.tier,
          equity: decision.equity ? decision.equity.equity : null,
          at: Date.now(),
        },
      })
      .catch(() => {});
  } catch {
    /* 忽略 */
  }
}

/** 把"刚执行的动作"上报后台，后台再转发给面板显示 */
function reportActed(result, decision) {
  try {
    chrome.runtime
      .sendMessage({
        type: RUNTIME_MESSAGE.AUTOPILOT_ACTED,
        acted: {
          action: result.action,
          label: result.label,
          amount: result.amount,
          reason: result.reason,
          tier: decision.tier,
          equity: decision.equity ? decision.equity.equity : null,
          at: Date.now(),
        },
      })
      .catch(() => {});
  } catch {
    /* 忽略 */
  }
}

/** 把"自动开始下一手"也上报面板（复用同一展示通道，口径统一） */
function reportNextHand(res) {
  try {
    chrome.runtime
      .sendMessage({
        type: RUNTIME_MESSAGE.AUTOPILOT_ACTED,
        acted: {
          action: 'next_hand',
          label: '开始下一手',
          amount: 0,
          reason: res.reason || '已自动开始下一手。',
          tier: state.tier,
          equity: null,
          at: Date.now(),
        },
      })
      .catch(() => {});
  } catch {
    /* 忽略 */
  }
}

// ============ 启动 ============
loadConfig();
