/**
 * 数据层：扑克牌解析器
 * ------------------------------------------------------------
 * 职责（单一）：输入一条已解析成对象/字符串的消息，输出"从中识别到的牌"。
 *   - 不负责网络、不负责界面，只做"数据 -> 牌"的纯计算，方便单独复用/测试。
 *
 * 思路（讲人话）：
 *   1) 服务器消息通常是 JSON。我们把它整个"深度遍历"一遍。
 *   2) 看到字段名里带 hole/board/flop... 的（见 KEY_HINTS），
 *      就重点把它的值解析成牌，并打上"底牌/公共牌"等标签。
 *   3) 同时也兜底扫描所有看起来像 "As" "Kd" 这样的牌字符串。
 *   4) 把结果去重后返回。
 */

import { CARD_REGEX, SUITS, KEY_HINTS } from '../common/constants.js';

/**
 * 把单个值标准化成一张"牌对象"，识别不了就返回 null。
 * 支持两种常见格式：
 *   - 字符串： "As" / "10h" / "Td"
 *   - 对象：   { rank: 'A', suit: 's' } 或 { value: 14, suit: 'h' } 等
 * @returns {{raw:string, rank:string, suit:string, display:string, color:string}|null}
 */
function normalizeCard(value) {
  // —— 情况 A：字符串形式 ——
  if (typeof value === 'string') {
    const text = value.trim();
    const m = text.match(CARD_REGEX);
    if (!m) return null;
    // m[1] 是点数（可能是 "10" 或字母），m[2] 是花色字母
    let rank = m[1].toUpperCase();
    if (rank === '10') rank = 'T'; // 统一成 T，界面再决定怎么显示
    const suit = m[2].toLowerCase();
    return buildCard(text, rank, suit);
  }

  // —— 情况 B：对象形式 ——
  if (value && typeof value === 'object') {
    const rank = pickRank(value);
    const suit = pickSuit(value);
    if (rank && suit) {
      return buildCard(`${rank}${suit}`, rank, suit);
    }
  }

  return null;
}

// 从对象里尽量提取"点数"
function pickRank(obj) {
  const r = obj.rank ?? obj.value ?? obj.r ?? obj.num;
  if (r == null) return null;
  const map = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }; // 数字点数的常见映射
  if (typeof r === 'number') {
    if (map[r]) return map[r];
    if (r >= 2 && r <= 9) return String(r);
    if (r === 10) return 'T';
    return null;
  }
  const s = String(r).toUpperCase();
  return s === '10' ? 'T' : s;
}

// 从对象里尽量提取"花色"
function pickSuit(obj) {
  const raw = obj.suit ?? obj.s ?? obj.color;
  if (raw == null) return null;
  const s = String(raw).toLowerCase();
  // 兼容中文/英文/首字母
  if (['s', 'spade', 'spades', '黑桃', '♠'].includes(s)) return 's';
  if (['h', 'heart', 'hearts', '红心', '红桃', '♥'].includes(s)) return 'h';
  if (['d', 'diamond', 'diamonds', '方块', '方片', '♦'].includes(s)) return 'd';
  if (['c', 'club', 'clubs', '梅花', '♣'].includes(s)) return 'c';
  return null;
}

// 组装统一的牌对象（含用于界面展示的符号/颜色）
function buildCard(raw, rank, suit) {
  const meta = SUITS[suit] || { symbol: '?', color: '#888' };
  const displayRank = rank === 'T' ? '10' : rank; // 界面上把 T 显示成 10 更直观
  return {
    raw,
    rank,
    suit,
    display: `${displayRank}${meta.symbol}`,
    color: meta.color,
  };
}

/**
 * 根据字段名（key）匹配 KEY_HINTS，返回它的分类信息；匹配不到返回兜底。
 */
function classifyByKey(key) {
  const lower = String(key).toLowerCase();
  for (const hint of KEY_HINTS) {
    if (hint.keywords.some((kw) => lower.includes(kw))) {
      return { category: hint.category, label: hint.label };
    }
  }
  return { category: 'unknown', label: '疑似牌' };
}

/**
 * 深度遍历任意数据，收集所有能识别出的牌。
 * @param {*} node        当前遍历到的节点
 * @param {string} keyName 这个节点在父对象里的字段名（用于分类）
 * @param {Array} out      收集结果的数组
 */
function walk(node, keyName, out) {
  // 1) 当前节点本身就是一张牌？
  const card = normalizeCard(node);
  if (card) {
    const { category, label } = classifyByKey(keyName);
    out.push({ ...card, category, label, fromKey: keyName });
    return; // 已经是一张牌，不用再往下钻
  }

  // 2) 是数组：逐个元素继续遍历（沿用父字段名做分类，比如 holeCards:[...]）
  if (Array.isArray(node)) {
    node.forEach((item) => walk(item, keyName, out));
    return;
  }

  // 3) 是对象：逐个字段继续遍历（字段名用自己的 key）
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      walk(v, k, out);
    }
  }
}

/**
 * 对外主函数：从一条消息数据里解析出所有牌（已按 raw+category 去重）。
 * @param {*} data 已经 JSON.parse 过的对象，或原始字符串
 * @returns {Array} 牌对象数组
 */
export function parseCards(data) {
  const out = [];

  if (typeof data === 'string') {
    // 字符串消息：先试试整体是不是 JSON，是就按对象走；不是就在文本里扫牌
    try {
      walk(JSON.parse(data), '', out);
    } catch {
      scanLooseText(data, out);
    }
  } else {
    walk(data, '', out);
  }

  // 去重：同一张牌 + 同一分类只保留一条
  const seen = new Set();
  return out.filter((c) => {
    const id = `${c.raw}|${c.category}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * 兜底：在一段纯文本里用"按空格/逗号切词"的方式扫牌。
 * 用于那些不是 JSON 的奇怪协议。
 */
function scanLooseText(text, out) {
  const tokens = text.split(/[\s,"'\[\]{}:]+/); // 按常见分隔符切开
  tokens.forEach((tok) => {
    const card = normalizeCard(tok);
    if (card) out.push({ ...card, category: 'unknown', label: '疑似牌', fromKey: '' });
  });
}
