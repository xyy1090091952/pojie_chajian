/**
 * 后台服务（service worker，MV3）
 * ------------------------------------------------------------
 * 职责（单一）：全局数据中枢。
 *   1) 接收所有 content 脚本转发来的抓包数据，交给数据层存起来（并解析牌）。
 *   2) 维护与 panel 面板的长连接，实时把新数据推给面板。
 *   3) 响应面板的"要快照 / 清空"等请求。
 *
 * 它是 ES Module（manifest 里 "type":"module"），所以可以 import 数据层。
 */

import { CHANNEL, RUNTIME_MESSAGE, PANEL_MESSAGE } from '../common/constants.js';
import { addRecord, getAll, clear } from '../data/message-store.js';
import { extractGameState } from '../data/game-state.js';
import { decide } from '../data/decision-engine.js';

// 当前连接着的面板端口集合（面板可能开多个，用 Set 管理）
const panelPorts = new Set();

// 让"点击插件图标"直接打开侧边栏面板（Chrome 114+ 支持）
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

// —— 1) 接收 content 脚本转发来的消息 ——
// 注意：GET_DECISION 需要【异步回传】结果，所以这个监听器里凡是要回传的分支，
//       都要 return true，告诉 Chrome "sendResponse 稍后才调用，别提前关闭通道"。
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
      const decision = computeDecision(message.config || {});
      sendResponse(decision);
      return true; // 已（同步）回传，这里 computeDecision 是同步的，返回 true 更稳妥
    }

    // 1.3 托管"打算做"的预告（动手之前）：转成面板消息，显示在"接下来"区域
    case RUNTIME_MESSAGE.AUTOPILOT_PLAN: {
      broadcast({ type: PANEL_MESSAGE.AUTOPILOT_PLAN, plan: message.plan });
      return false;
    }

    // 1.4 托管执行了一个动作：转成面板消息，显示"最近动作"
    case RUNTIME_MESSAGE.AUTOPILOT_ACTED: {
      broadcast({ type: PANEL_MESSAGE.AUTOPILOT_ACTION, acted: message.acted });
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
 * @param {object} config {tier, opponentStyle}
 * @returns {object} 决策引擎的标准结果 {ok, action, amount, reason, tier, equity}
 */
function computeDecision(config) {
  const records = getAll(); // 全部抓包记录（既用于抽当前局面，也用于边打边记对手档案）
  const ctx = extractGameState(records); // 抽出"最新一帧"的局面
  // 把 records 一并透传给决策引擎：它会据此构建"对手档案"，在你用默认档
  //   且观察可靠时自动按观察到的桌面风格打（拿不到可靠数据则退回手选画像）。
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
        // 面板刚打开，给它一份当前全部数据
        port.postMessage({ type: PANEL_MESSAGE.SNAPSHOT, records: getAll() });
        break;
      case PANEL_MESSAGE.CLEAR:
        clear();
        // 通知所有面板一起清空，保证各面板显示一致（数据一致性）
        broadcast({ type: PANEL_MESSAGE.SNAPSHOT, records: [] });
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
