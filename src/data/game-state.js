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
// 玩家"剩余筹码"可能的字段名（⚠️ 待核对真实数据再精确）：
//   不同服务端叫法不一，这里把常见写法都试一遍。抽不到就返回 null，绝不编一个假数值。
//   用途：给加注额"封顶"，避免中等牌被打成接近全下（防误 all in 的策略层保险）。
const STACK_KEYS = ['stack', 'chips', 'balance', 'remain', 'remaining', 'stackSize', 'chipCount', 'money'];
// 盲注结构可能直接放在牌桌对象，也可能包在 blinds/limits/config 里。
// 只读取明确的大盲字段，不用“小盲×2”等方式猜测，避免错误放宽入池条件。
const BIG_BLIND_KEYS = ['bigBlind', 'bigBlindAmount', 'big_blind', 'bbAmount', 'blindSize'];
const BLIND_CONTAINER_KEYS = ['blinds', 'blind', 'limits', 'stakes', 'config'];
// 玩家"位置"相关字段候选（⚠️ 待核对真实数据再精确）：
//   有的服务端在玩家对象上直接给位置标签（如 'BTN'/'CO'/'UTG'/'SB'/'BB'），
//   有的只给一个"庄家按钮在哪个座位"的标记，由前端自己推算。两种都兼容尝试。
const POSITION_KEYS = ['position', 'pos', 'seatPosition', 'posName', 'positionName'];
// 标记"这是庄家(按钮位)"的字段候选（值为真表示该玩家是庄）。
const DEALER_KEYS = ['dealer', 'isDealer', 'button', 'isButton', 'btn'];

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
 * 把服务端五花八门的"位置写法"归一化成三档：'early' | 'middle' | 'late'。
 *   —— 策略层只关心"早/中/晚位"这个粗粒度，不关心具体是 UTG 还是 CO。
 *   —— 认不出来就返回 null（宁可没有，也不编一个误导决策）。
 * @param {string} raw 原始位置标签（可能是 'BTN'/'SB'/'UTG'/'CO'/中文/数字等）
 * @returns {'early'|'middle'|'late'|null}
 */
function normalizePosition(raw) {
  if (raw == null) return null;
  const t = String(raw).trim().toLowerCase();
  if (!t) return null;

  // 晚位：按钮(BTN)、cutoff(CO)、庄家、后面、late
  if (/(btn|button|^co$|cutoff|dealer|late|后|庄)/.test(t)) return 'late';
  // 早位：枪口(UTG)、大/小盲(SB/BB，翻后行动早)、early、前面
  if (/(utg|^sb$|^bb$|small ?blind|big ?blind|blind|early|前|枪)/.test(t)) return 'early';
  // 中位：MP / middle / 中
  if (/(^mp$|middle|^mid|中)/.test(t)) return 'middle';

  return null; // 认不出：不猜
}

/**
 * 【防御式】尽量抽取"我自己的位置"（早/中/晚位）。
 *   拿不到可靠数据时返回 null —— 这是刻意的：没有真实位置数据就不编，
 *   策略层拿到 null 会自动退回"不看位置"的原逻辑，绝不基于假数据决策。
 *
 * 支持两种数据形态：
 *   1) 玩家对象上直接带位置标签（position/pos/...）→ 归一化返回。
 *   2) 只有"谁是庄家"的标记：若我自己被标为庄家 → 'late'；否则信息不足 → null
 *      （不去推算其它人具体位置，避免不准）。
 * @param {object} heroPlayer 已识别出的"我"的玩家对象
 * @returns {'early'|'middle'|'late'|null}
 */
function extractHeroPosition(heroPlayer) {
  if (!heroPlayer || typeof heroPlayer !== 'object') return null;

  // 形态 1：直接给了位置标签
  const posRaw = pick(heroPlayer, POSITION_KEYS);
  const normalized = normalizePosition(posRaw);
  if (normalized) return normalized;

  // 形态 2：只给了"是不是庄家"
  const dealer = pick(heroPlayer, DEALER_KEYS);
  if (dealer === true) return 'late';

  // 其它情况：信息不足，不猜
  return null;
}

/**
 * 【防御式】抽取"我的剩余筹码"。
 *   抽不到 / 不是正数时返回 null —— 和位置一样，没有真实数据就不编，
 *   策略层拿到 null 会退回"不按筹码封顶"的保守倍数逻辑，绝不基于假筹码决策。
 * @param {object} heroPlayer 已识别出的"我"的玩家对象
 * @returns {number|null} 正数筹码；拿不到返回 null
 */
function extractHeroStack(heroPlayer) {
  if (!heroPlayer || typeof heroPlayer !== 'object') return null;
  const raw = pick(heroPlayer, STACK_KEYS);
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null; // 0/负/NaN 都当"没拿到"
  return n;
}

/**
 * 【防御式】抽取本桌大盲金额。
 *   只接受服务端明确给出的正数；拿不到返回 null，不根据底池或玩家下注额猜测。
 * @param {object} view 当前牌桌状态
 * @returns {number|null}
 */
function extractBigBlind(view) {
  const direct = Number(pick(view, BIG_BLIND_KEYS));
  if (Number.isFinite(direct) && direct > 0) return direct;

  for (const key of BLIND_CONTAINER_KEYS) {
    const container = view?.[key];
    if (!container || typeof container !== 'object') continue;
    const nested = Number(pick(container, BIG_BLIND_KEYS));
    if (Number.isFinite(nested) && nested > 0) return nested;
  }
  return null;
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
  let heroPlayer = null; // 记住"我"的玩家对象，后面抽位置要用
  for (const p of players) {
    if (isHero(p, viewerId)) {
      hole = readPlayerHole(p);
      heroPlayer = p;
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

  // —— 我的位置（早/中/晚位）：防御式抽取，拿不到为 null，策略会据此退回原逻辑 ——
  const position = extractHeroPosition(heroPlayer);

  // —— 我的剩余筹码：防御式抽取，拿不到为 null，策略会退回保守封顶（防误全下）——
  const stack = extractHeroStack(heroPlayer);

  // —— 大盲金额：用于翻牌前判断“只跟一个盲注是否便宜”，拿不到为 null ——
  const bigBlind = extractBigBlind(view);

  // 局面指纹：关键数据任一变化才需重算。
  const signature = [
    hole.join(','), board.join(','), opponents, pot, toCall,
    position || '-', stack ?? '-', bigBlind ?? '-',
  ].join('|');

  return { ok: true, hole, board, opponents, pot, toCall, position, stack, bigBlind, signature };
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
  STACK_KEYS,
  BIG_BLIND_KEYS,
  BLIND_CONTAINER_KEYS,
  POSITION_KEYS,
  DEALER_KEYS,
};
