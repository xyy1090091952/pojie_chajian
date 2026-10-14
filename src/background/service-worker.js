/**
 * 后台服务（service worker，MV3）
 * ------------------------------------------------------------
 * 职责（单一）：全局数据中枢。
 *   1) 接收所有 content 脚本转发来的抓包数据，交给数据层存起来（并解析牌）。
 *   2) 托管请求决策时，抽局面 + 跑决策引擎，把结果回传。
 *   3) 汇总托管上报的"状态 / 预告 / 动作"，维护一份托管会话，整份推给面板。
 *   4) 维护与 panel 面板的长连接，响应"要快照 / 清空 / 重置统计"等请求。
 *
 * 它是 ES Module（manifest 里 "type":"module"），所以可以 import 数据层。
 */

import {
  CHANNEL,
  RUNTIME_MESSAGE,
  PANEL_MESSAGE,
  AUTOPILOT_SESSION_KEY,
  AUTOPILOT,
  AUTOPILOT_STATUS,
  STORAGE_KEYS,
} from '../common/constants.js';
import { addRecord, getAll, clear } from '../data/message-store.js';
import { extractGameState } from '../data/game-state.js';
import { decide } from '../data/decision-engine.js';
import {
  createSession,
  restoreSession,
  applyStatus,
  applyPlan,
  applyActed,
  resetStats,
} from '../data/autopilot-session.js';

// 当前连接着的面板端口集合（面板可能开多个，用 Set 管理）
const panelPorts = new Set();

// 托管会话（状态/预告/历史/统计）。启动时先给一份空的，再从 session 存储里恢复。
let session = createSession();
const sessionStore = chrome.storage && chrome.storage.session;
const sessionReady = sessionStore
  ? sessionStore
    .get(AUTOPILOT_SESSION_KEY)
    .then((saved) => {
      session = restoreSession(saved && saved[AUTOPILOT_SESSION_KEY]);
    })
    .catch(() => {})
  : Promise.resolve();

// 让"点击插件图标"直接打开侧边栏面板（Chrome 114+ 支持）
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

/**
 * 修改托管会话的统一入口：等恢复完成 → 改数据 → 存一份 → 广播给所有面板。
 *   所有改会话的地方都走这里，保证"存的、推的、看到的"永远是同一份（数据一致性）。
 * @param {(s:object)=>void} mutate 修改函数
 */
function updateSession(mutate) {
  sessionReady.then(() => {
    mutate(session);
    if (sessionStore) sessionStore.set({ [AUTOPILOT_SESSION_KEY]: session }).catch(() => {});
    broadcast({ type: PANEL_MESSAGE.AUTOPILOT_STATE, session });
  });
}

/**
 * 按"托管总开关"同步会话状态：关 => 托管已关闭（并清空预告）；开 => 等待轮到你。
 *   开关存在 chrome.storage.local（面板写），后台直接听它，
 *   这样即使牌桌页面还没加载，面板顶部的状态也永远和开关一致。
 * @param {boolean} enabled
 */
function syncEnabledStatus(enabled) {
  updateSession((s) => {
    if (!enabled) {
      applyStatus(s, { status: AUTOPILOT_STATUS.OFF });
    } else if (s.status === AUTOPILOT_STATUS.OFF) {
      // 只有从"关闭"切到"开启"时才改成等待；已经在思考/出手中的状态不去覆盖
      applyStatus(s, { status: AUTOPILOT_STATUS.WAITING });
    }
  });
}

// 启动时读一次开关（后台可能刚被唤醒，存储里的会话状态可能已过时）
chrome.storage.local.get(STORAGE_KEYS.AUTOPILOT_ENABLED, (cfg) => {
  syncEnabledStatus(Boolean(cfg[STORAGE_KEYS.AUTOPILOT_ENABLED] ?? AUTOPILOT.DEFAULT_ENABLED));
});

// 之后开关一变就同步
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(STORAGE_KEYS.AUTOPILOT_ENABLED in changes)) return;
  syncEnabledStatus(Boolean(changes[STORAGE_KEYS.AUTOPILOT_ENABLED].newValue));
});

// —— 1) 接收 content 脚本转发来的消息 ——
// 注意：GET_DECISION 需要回传结果，回传的分支 return true，告诉 Chrome "sendResponse 可能稍后才调用"。
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return false;

  switch (message.type) {
    // 1.1 抓到一条新网络数据：存起来 + 广播给面板
    case RUNTIME_MESSAGE.CAPTURE: {
      const record = addRecord(message.record);
      broadcast({ type: PANEL_MESSAGE.NEW_RECORD, record });
      return false; // 无需回传
    }

    // 1.2 托管请求决策：用当前全部数据抽局面 + 跑策略，把决策回传给内容脚本
    case RUNTIME_MESSAGE.GET_DECISION: {
      sendResponse(computeDecision(message.config || {}));
      return true;
    }

    // 1.3 托管运行状态变化（等待/思考/已出手/跳过）
    //     托管已关闭时忽略"迟到"的状态，避免关掉后又被改回"等待中"。
    case RUNTIME_MESSAGE.AUTOPILOT_STATUS: {
      updateSession((s) => {
        if (s.status !== AUTOPILOT_STATUS.OFF) applyStatus(s, message);
      });
      return false;
    }

    // 1.4 托管"打算做"的预告（动手之前；plan 为 null 表示预告结束）
    case RUNTIME_MESSAGE.AUTOPILOT_PLAN: {
      updateSession((s) => {
        if (s.status !== AUTOPILOT_STATUS.OFF || !message.plan) applyPlan(s, message.plan);
      });
      return false;
    }

    // 1.5 托管执行了一个动作：记进历史和统计
    case RUNTIME_MESSAGE.AUTOPILOT_ACTED: {
      updateSession((s) => applyActed(s, message.acted));
      return false;
    }

    default:
      return false;
  }
});

/**
 * 用"当前全部抓包数据"算一次托管决策。
 *   数据管理层抽象：这里只负责"取数据 → 抽局面 → 交给决策引擎"，
 *   具体怎么决策由 decision-engine 按档位路由，背景脚本不含扑克逻辑。
 * @param {object} config {tier, opponentStyle, aggressionProfile, valueBetProfile, preflopEntryProfile}
 * @returns {object} 决策引擎的标准结果
 */
function computeDecision(config) {
  const records = getAll(); // 全部抓包记录（既用于抽当前局面，也用于边打边记对手档案）
  const ctx = extractGameState(records); // 抽出"最新一帧"的局面
  return decide(ctx, { ...config, records });
}

// —— 2) 维护与面板的长连接 ——
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== CHANNEL.PORT_NAME) return;

  panelPorts.add(port);

  // 面板发来的指令
  port.onMessage.addListener((msg) => {
    if (!msg) return;
    switch (msg.type) {
      case PANEL_MESSAGE.GET_SNAPSHOT:
        // 面板刚打开：给它一份当前全部数据 + 托管会话
        port.postMessage({ type: PANEL_MESSAGE.SNAPSHOT, records: getAll() });
        sessionReady.then(() => {
          try {
            port.postMessage({ type: PANEL_MESSAGE.AUTOPILOT_STATE, session });
          } catch {
            /* 面板可能刚关闭 */
          }
        });
        break;
      case PANEL_MESSAGE.CLEAR:
        clear();
        // 通知所有面板一起清空，保证各面板显示一致（数据一致性）
        broadcast({ type: PANEL_MESSAGE.SNAPSHOT, records: [] });
        break;
      case PANEL_MESSAGE.RESET_STATS:
        updateSession((s) => resetStats(s));
        break;
      default:
        break;
    }
  });

  // 面板关闭时移除端口，避免给已关闭的端口发消息报错
  port.onDisconnect.addListener(() => {
    panelPorts.delete(port);
  });
});

/** 向所有在线面板广播一条消息 */
function broadcast(payload) {
  for (const port of panelPorts) {
    try {
      port.postMessage(payload);
    } catch {
      // 端口可能刚断开，忽略
      panelPorts.delete(port);
    }
  }
}
