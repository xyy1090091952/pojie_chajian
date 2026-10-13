/**
 * 数据层：「当前局面」抽取器（把抓到的原始数据 -> 胜率引擎能用的输入）
 * ------------------------------------------------------------
 * 职责（单一）：从 message-store 存下来的那堆抓包记录里，
 *   找出"最新的一帧牌桌状态"，并抽取胜率计算需要的几样东西：
 *     - hole      你自己的两张底牌
 *     - board     已翻开的公共牌
 *     - opponents 还没弃牌的对手数
 *     - pot       当前底池
 *     - toCall    你需要跟入的筹码
 *
 * 为什么单独成一层（数据管理层抽象）：
 *   服务端的字段名、数据结构可能变。把"认字段"的脏活都关在这一个文件里，
 *   上层引擎和界面就只认一个干净的 ctx 对象，服务端换字段只改这里。
 *
 * 容错原则：
 *   不同游戏/版本字段名未必一样，这里对常见字段名都做了兼容尝试；
 *   取不到就返回 ok:false + 原因，宁可不算也不乱算（数据一致性）。
 */

import { parseCards } from './card-parser.js';
import { DIRECTION } from '../common/constants.js';

// 可能承载"整桌状态"的字段名候选（服务端把牌桌状态常放在 view/state/table/game 里）
const VIEW_KEYS = ['view', 'state', 'table', 'game', 'gameState', 'data', 'payload'];
// 玩家列表可能的字段名
const PLAYERS_KEYS = ['players', 'seats', 'playerList', 'users'];
// 公共牌可能的字段名
const BOARD_KEYS = ['board', 'community', 'communityCards', 'publicCards', 'flop'];
// 底池可能的字段名
const POT_KEYS = ['pot', 'totalPot', 'mainPot', 'potSize'];
// "我是谁"可能的字段名（服务端会告诉你当前视角属于哪个座位/玩家）
const VIEWER_KEYS = ['viewerId', 'heroId', 'myId', 'selfId', 'userId', 'seatId', 'playerId'];
// 玩家是否弃牌可能的字段名（值为真表示已弃牌）
const FOLDED_KEYS = ['folded', 'isFolded', 'fold', 'hasFolded'];
// 玩家本手已下注、当前最高下注——用于推算"还要跟多少"
const BET_KEYS = ['bet', 'betAmount', 'currentBet', 'wager', 'street_bet', 'roundBet'];
const PLAYER_CARDS_KEYS = ['cards', 'hole', 'holeCards', 'hand', 'pocket'];

/** 在对象里按一组候选 key 取第一个存在的值 */
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

/**
 * 从一条记录的 payload 里，尽量找出"牌桌状态对象"。
 * 有的服务端直接把状态放最外层，有的包在 view/state 里，都试一遍。
 */
function extractView(payload) {
  if (!payload || typeof payload !== 'object') return null;
  // 先看外层本身像不像牌桌状态（有 players 就认为是）
  if (pick(payload, PLAYERS_KEYS)) return payload;
  // 再看常见的嵌套字段
  for (const k of VIEW_KEYS) {
    const sub = payload[k];
    if (sub && typeof sub === 'object' && pick(sub, PLAYERS_KEYS)) return sub;
  }
  return null;
}

/**
 * 判断"这条玩家数据是不是我"。
 * 依据：服务端只会把【你自己】的两张真实底牌下发给你，别人的 cards 是空的。
 *   所以"cards 里能解析出 >=2 张牌"的那个玩家，基本就是你本人。
 *   如果 view 里明确给了 viewerId，也用它来二次确认。
 */
function isHero(player, viewerId) {
  // 优先用明确的身份字段
  if (viewerId != null) {
    const pid = pick(player, VIEWER_KEYS) ?? player.id ?? player.seat ?? player.uid;
    if (pid != null && String(pid) === String(viewerId)) return true;
  }
  // 兜底：谁手里有真实的两张牌，谁就是我
  const raw = pick(player, PLAYER_CARDS_KEYS);
  if (Array.isArray(raw)) {
    const cards = parseCards(raw);
    if (cards.length >= 2) return true;
  }
  return false;
}

/** 把玩家的 cards 字段解析成牌字符串数组，如 ["9h","8d"] */
function readPlayerHole(player) {
  const raw = pick(player, PLAYER_CARDS_KEYS);
  if (!raw) return [];
  return parseCards(raw).map((c) => c.raw);
}

/**
 * 【对外主函数】从全部抓包记录里，抽取"最新一帧"的局面上下文。
 * @param {Array} records message-store 里的全部记录（panel 的 state.records）
 * @returns {{ok:boolean, reason?:string, hole?, board?, opponents?, pot?, toCall?, signature?}}
 *   signature 是"局面指纹"，内容没变时界面可跳过重复计算（防抖去重）。
 */
export function extractGameState(records) {
  if (!Array.isArray(records) || records.length === 0) {
    return { ok: false, reason: '还没抓到任何牌桌数据' };
  }

  // 从最新往回找：第一条能解析出"牌桌状态"的服务器下发记录就用它
  let view = null;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    // 只认服务器下发的实时数据（SSE/WS/fetch 都可能）
    if (r.direction !== DIRECTION.INBOUND) continue;
    const v = extractView(r.payload);
    if (v) {
      view = v;
      break;
    }
  }
  if (!view) {
    return { ok: false, reason: '尚未识别到牌桌状态（请在牌局进行中打开）' };
  }

  // —— 玩家列表 ——
  const players = pick(view, PLAYERS_KEYS);
  if (!Array.isArray(players) || players.length === 0) {
    return { ok: false, reason: '牌桌数据里没有玩家列表' };
  }

  const viewerId = pick(view, VIEWER_KEYS);

  // —— 找到我自己、拿底牌 ——
  let hole = [];
  for (const p of players) {
    if (isHero(p, viewerId)) {
      hole = readPlayerHole(p);
      break;
    }
  }
  if (hole.length < 2) {
    return { ok: false, reason: '还没拿到你的两张底牌（可能本手未入座或未发牌）' };
  }

  // —— 公共牌 ——
  const rawBoard = pick(view, BOARD_KEYS);
  const board = Array.isArray(rawBoard) ? parseCards(rawBoard).map((c) => c.raw) : [];

  // —— 存活对手数：没弃牌、且不是我 ——
  let opponents = 0;
  for (const p of players) {
    if (isHero(p, viewerId)) continue; // 跳过我自己
    const folded = pick(p, FOLDED_KEYS);
    if (folded === true) continue; // 已弃牌不算
    opponents++;
  }

  // —— 底池 ——
  const pot = Number(pick(view, POT_KEYS)) || 0;

  // —— 待跟注：全场最高下注 - 我已下注（取不到就当 0）——
  const toCall = computeToCall(players, viewerId);

  // 局面指纹：底牌+公共牌+对手数+底池+待跟注，任一变化才需重算
  const signature = [hole.join(','), board.join(','), opponents, pot, toCall].join('|');

  return { ok: true, hole, board, opponents, pot, toCall, signature };
}

/**
 * 推算"我还需要跟多少注"：
 *   = 全场所有人里的最高下注额 - 我当前已下注额。
 *   取不到下注字段时返回 0（界面会显示"无需跟注/数据不足"）。
 */
function computeToCall(players, viewerId) {
  let maxBet = 0;
  let myBet = 0;
  let foundBetField = false;

  for (const p of players) {
    const bet = Number(pick(p, BET_KEYS));
    if (!Number.isNaN(bet) && pick(p, BET_KEYS) !== undefined) {
      foundBetField = true;
      if (bet > maxBet) maxBet = bet;
      if (isHero(p, viewerId)) myBet = bet;
    }
  }
  if (!foundBetField) return 0; // 没有下注字段，无法推算
  return Math.max(0, maxBet - myBet);
}

// 导出常量集合，方便以后在别处（如调试）引用同一套字段名
export const STATE_FIELD_KEYS = {
  VIEW_KEYS,
  PLAYERS_KEYS,
  BOARD_KEYS,
  POT_KEYS,
  VIEWER_KEYS,
  FOLDED_KEYS,
  BET_KEYS,
  PLAYER_CARDS_KEYS,
};
