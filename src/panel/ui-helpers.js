/**
 * 面板·显示小工具（纯函数，不碰状态、不碰 chrome API）
 * ------------------------------------------------------------
 * 把"数据 -> 显示文字/HTML"的翻译集中在这里，面板各区域共用同一套口径：
 *   比如"加注至 40 / 全下 600 / 跟注 20"，建议区、预告、历史显示得一模一样。
 */

import {
  POKER_ACTION,
  POKER_ACTION_NAMES,
  NEXT_HAND_ACTION,
  SUITS,
  STREET_NAMES,
} from '../common/constants.js';

/** 防 XSS：把抓来的数据里的特殊字符转义后再拼进 HTML */
export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 把一个动作翻译成一句短文字。
 * @param {{action:string, amount?:number, allIn?:boolean, toCall?:number}} info
 * @returns {string} 例："加注至 40"、"下注 26"、"全下 600"、"跟注 20"、"过牌"
 */
export function actionText(info) {
  if (!info || !info.action) return '—';
  // 跟注没带金额时，用"要跟的钱"补上（面板建议区的决策对象只带 toCall）
  const amount = Number(info.amount) || (info.action === POKER_ACTION.CALL ? Number(info.toCall) || 0 : 0);
  if (info.action === NEXT_HAND_ACTION) return '开始下一手';
  if (info.action === POKER_ACTION.RAISE) {
    if (info.allIn) return amount > 0 ? `全下 ${amount}` : '全下';
    if (amount <= 0) return POKER_ACTION_NAMES[POKER_ACTION.RAISE];
    // 面前有注 = 加注至；没人下注 = 下注
    return (Number(info.toCall) || 0) > 0 ? `加注至 ${amount}` : `下注 ${amount}`;
  }
  if (info.action === POKER_ACTION.CALL) {
    const prefix = info.allIn ? '跟注全下' : '跟注';
    return amount > 0 ? `${prefix} ${amount}` : prefix;
  }
  return POKER_ACTION_NAMES[info.action] || info.action;
}

/** 动作 -> 配色 class（弃牌红、过牌灰、跟注蓝、加注橙、全下紫、开局绿） */
export function actionClass(info) {
  if (!info || !info.action) return 'act';
  if (info.allIn) return 'act act--allin';
  return `act act--${info.action}`;
}

/** 渲染一个动作徽标（HTML 字符串） */
export function actionBadge(info, extraClass = '') {
  return `<span class="${actionClass(info)} ${extraClass}">${escapeHtml(actionText(info))}</span>`;
}

/** 把点数数字转成显示字符：11->J 12->Q 13->K 14->A，其余原样 */
function displayRank(r) {
  const map = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
  return map[r] || String(r);
}

/**
 * 把牌字符串数组（如 ["9h","8d"]）渲染成白色扑克牌小块。
 * @param {string[]} cards
 * @param {(raw:string)=>({r:number,s:string}|null)} parse 解析函数（poker-engine 的 parseCard）
 */
export function renderCards(cards, parse) {
  return cards
    .map((raw) => {
      const c = parse(raw);
      if (!c) return '';
      const meta = SUITS[c.s] || { symbol: '?', color: '#222' };
      return `<span class="pcard" style="color:${meta.color}">${displayRank(c.r)}${meta.symbol}</span>`;
    })
    .join('');
}

/** 胜率配色：>=60% 绿、>=35% 黄、否则红 */
export function winColor(win) {
  if (win >= 60) return '#3ddc84';
  if (win >= 35) return '#ffc857';
  return '#ff6b6b';
}

/** 时间戳 -> "12:03:05" */
export function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 毫秒时长 -> "25 分钟" / "1 小时 5 分钟" */
export function formatDuration(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

/** 带正负号的数字："+120" / "-35" / "0" */
export function formatSigned(n) {
  if (!Number.isFinite(n)) return '—';
  if (n > 0) return `+${n}`;
  return String(n);
}

/** 公共牌张数 -> 街道名 */
export function streetName(boardLength) {
  return STREET_NAMES[boardLength] || '—';
}
