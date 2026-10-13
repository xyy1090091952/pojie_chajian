/**
 * 全局常量模块
 * ------------------------------------------------------------
 * 作用：把插件里"写死的字符串/规则"集中到一处（常量化），
 *       这样后面任何地方要改规则，只改这里一个文件即可，
 *       避免散落在各处导致不一致。
 *
 * 说明：这个文件是 ES Module，会被 background 和 panel 用 import 引入。
 *       （注意：inject/interceptor.js 因为运行在页面环境里、不能用 import，
 *        所以它内部复制了下面 CHANNEL.PAGE_SOURCE 这个字符串，两边必须一致。）
 */

// 插件对外显示的名字
export const EXTENSION_NAME = '德州数据审计器';

// ============ 通信通道相关常量 ============
// 数据流向：页面(interceptor) --postMessage--> content --sendMessage--> background --port--> panel
export const CHANNEL = {
  // 页面脚本发给 content 脚本时，用这个 source 做标记（防止和页面自己的消息混淆）
  PAGE_SOURCE: 'DH_AUDIT_PAGE',
  // panel 和 background 之间长连接的名字
  PORT_NAME: 'DH_AUDIT_PANEL',
};

// content -> background 的消息类型
export const RUNTIME_MESSAGE = {
  CAPTURE: 'CAPTURE', // 抓到一条新的网络数据
};

// background <-> panel 的消息类型
export const PANEL_MESSAGE = {
  GET_SNAPSHOT: 'GET_SNAPSHOT', // panel 打开时，向后台要一份当前全部数据
  SNAPSHOT: 'SNAPSHOT', // 后台回传的全部数据
  NEW_RECORD: 'NEW_RECORD', // 后台广播：来了一条新数据
  CLEAR: 'CLEAR', // 清空
};

// 数据方向（是客户端发出去的，还是服务器发下来的）
// 测泄露时，我们最关心 INBOUND（服务器 -> 客户端）里有没有别人的牌。
export const DIRECTION = {
  INBOUND: 'inbound', // 服务器 -> 浏览器（收到）
  OUTBOUND: 'outbound', // 浏览器 -> 服务器（发出）
};

// 数据传输方式
export const TRANSPORT = {
  WEBSOCKET: 'websocket',
  FETCH: 'fetch',
  XHR: 'xhr',
  SSE: 'sse', // 服务器推送事件（EventSource）—— River 游戏的主数据通道
};

// ============ 运行参数 ============
export const CONFIG = {
  // 最多保存多少条消息（环形缓冲，超过就丢最老的，防止内存无限增长）
  MAX_MESSAGES: 2000,
};

// ============ 扑克牌识别规则 ============
// 牌面点数（T = 10）。有的服务器用 "10"，有的用 "T"，这里都兼容。
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

// 花色字母 -> 中文名 + 符号 + 颜色，用于界面展示
export const SUITS = {
  s: { name: '黑桃', symbol: '♠', color: '#222' },
  h: { name: '红心', symbol: '♥', color: '#d33' },
  d: { name: '方块', symbol: '♦', color: '#d33' },
  c: { name: '梅花', symbol: '♣', color: '#222' },
};

// 一张牌的字符串正则：点数(2-9 / 10 / T J Q K A) + 花色(s h d c)，大小写都认。
// 例：As Kd Th 10c 2s
export const CARD_REGEX = /^(10|[2-9]|[tjqka])([shdc])$/i;

// 字段名关键词 -> 分类。遍历服务器数据时，一旦某个 key 名字里包含这些词，
// 就把它的值重点当作"牌"来解析，并打上对应标签。
// 这是启发式判断（靠经验猜），不同游戏字段名可能不同，可按需在这里加词。
export const KEY_HINTS = [
  // 注意：River 这款游戏里，每个玩家的底牌放在 "cards" 字段，所以把 cards/card 归到底牌。
  { category: 'hole', label: '底牌', keywords: ['hole', 'pocket', 'hand', 'holecard', 'privatecard', 'cards', 'card'] },
  { category: 'board', label: '公共牌', keywords: ['board', 'community', 'flop', 'turn', 'river', 'publiccard'] },
  { category: 'deck', label: '牌堆/未发牌', keywords: ['deck', 'remain', 'undealt', 'burn', 'stock'] },
];
