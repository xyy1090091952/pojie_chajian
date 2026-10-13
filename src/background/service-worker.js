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

// 当前连接着的面板端口集合（面板可能开多个，用 Set 管理）
const panelPorts = new Set();

// 让"点击插件图标"直接打开侧边栏面板（Chrome 114+ 支持）
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

// —— 1) 接收 content 脚本转发来的抓包数据 ——
chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === RUNTIME_MESSAGE.CAPTURE) {
    // 存入数据层，拿到解析好牌的完整记录
    const record = addRecord(message.record);
    // 实时广播给所有打开的面板
    broadcast({ type: PANEL_MESSAGE.NEW_RECORD, record });
  }
  // 不需要异步回传，返回 false 即可
  return false;
});

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
