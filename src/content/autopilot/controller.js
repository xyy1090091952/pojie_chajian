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
  DEFAULT_STRATEGY_TIER,
  DEFAULT_OPPONENT_STYLE,
} from '../../common/constants.js';
import { isMyTurn } from './turn-detector.js';
import { executeDecision } from './action-executor.js';

// ============ 本地运行状态（集中管理，避免散落全局变量） ============
const state = {
  enabled: AUTOPILOT.DEFAULT_ENABLED, // 托管总开关
  tier: DEFAULT_STRATEGY_TIER, // 策略档位
  opponentStyle: DEFAULT_OPPONENT_STYLE, // 对手牌力风格（影响决策胜率）
  timer: null, // 轮询定时器句柄
  busy: false, // 正在处理一次行动（防止重入）
  lastActionAt: 0, // 上次成功行动的时间戳（配合冷却时间防重复点）
};

// ============ 1) 读取 & 监听配置（单一数据源：chrome.storage.local） ============
function loadConfig() {
  chrome.storage.local.get(
    [STORAGE_KEYS.AUTOPILOT_ENABLED, STORAGE_KEYS.STRATEGY_TIER, STORAGE_KEYS.OPPONENT_STYLE],
    (cfg) => {
      // 用 ?? 兜底：storage 里没存过时用默认值，保证字段永远有效。
      state.enabled = cfg[STORAGE_KEYS.AUTOPILOT_ENABLED] ?? AUTOPILOT.DEFAULT_ENABLED;
      state.tier = cfg[STORAGE_KEYS.STRATEGY_TIER] ?? DEFAULT_STRATEGY_TIER;
      state.opponentStyle = cfg[STORAGE_KEYS.OPPONENT_STYLE] ?? DEFAULT_OPPONENT_STYLE;
      syncLoop();
    }
  );
}

// 监听面板对配置的修改：开关一变立即启停，档位/风格一变下次决策就用新值。
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
  // 开关关了 / 正在忙 / 还在冷却期 —— 都直接跳过，保证不重复点。
  if (!state.enabled || state.busy) return;
  if (Date.now() - state.lastActionAt < AUTOPILOT.ACTION_COOLDOWN_MS) return;

  // 没轮到我，什么都不做。
  if (!isMyTurn(TURN_INDICATOR_RULES)) return;

  state.busy = true;
  try {
    // 3.1 向后台要一个决策（后台用抓包数据跑胜率 + 策略）。
    const decision = await requestDecision();
    if (!decision || !decision.ok) {
      // 后台说"这手不方便托管"（如数据不足），本轮放弃，等下一轮。
      return;
    }

    // 3.2 执行决策（找按钮、拟人延迟、点击）。
    const result = await executeDecision(decision);

    // 3.3 执行成功才进入冷却 + 上报面板展示"最近动作"。
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

// ============ 4) 与后台通信 ============
/** 向后台请求一次决策，返回决策对象（Promise 化，便于 await） */
function requestDecision() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        {
          type: RUNTIME_MESSAGE.GET_DECISION,
          config: { tier: state.tier, opponentStyle: state.opponentStyle },
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

// ============ 启动 ============
loadConfig();
