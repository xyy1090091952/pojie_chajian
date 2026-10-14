/**
 * 数据层：「对手档案」模块（边打边记 / 对手建模）
 * ------------------------------------------------------------
 * 职责（单一）：从全部抓包记录里，按座位统计每个对手的历史动作倾向，
 *   汇总出一个"这桌整体偏松还是偏紧"的隐含风格，供决策引擎参考。
 *   —— 纯数据层：不碰网络、不碰界面，只做统计，方便单测与复用。
 *
 * 和「群体默认画像」(constants 的 OPPONENT_STYLES) 的关系：
 *   - 群体画像 = 你【手动】选的"这桌大概什么性质"（松/标准/紧），是先验兜底。
 *   - 对手档案 = 机器人【自己观察】出来的真实倾向，是后验学习（边打边学）。
 *   决策引擎的用法：面板"对手类型"选「自动识别」（默认）时，观察样本够多够可靠就用观察结果，
 *   不够就先按"标准"算；你一旦手动选了某种风格，就尊重你的判断，不自作主张。
 *
 * ⚠️ 诚实红线（最重要）：拿不到可靠数据就【返回空档案】，绝不编造。
 *   必须同时满足两个前提才认为"可统计"：
 *     1) 数据流里能稳定拿到"手牌编号"（handId）—— 否则没法区分这是第几手，统计会串味。
 *     2) 数据流里能稳定拿到"我是谁"(viewerId) —— 否则分不清敌我，会把自己也统计进去。
 *   任一前提缺失 => reliable:false + 空 seats，决策引擎据此先按"标准"算。
 */

import { parseCards } from './card-parser.js';
import {
  DIRECTION,
  OPPONENT_STYLES,
  OPPONENT_STYLE_AUTO,
  AUTO_FALLBACK_STYLE,
  getOpponentStyleLabel,
} from '../common/constants.js';
import { STATE_FIELD_KEYS } from './game-state.js';

// ============ 本模块专用阈值与字段候选（集中成常量，便于调参，和逻辑解耦） ============

// 复用 game-state 已对外导出的同一套字段候选名（单一数据源：服务端换字段只改那一处）。
const { VIEW_KEYS, PLAYERS_KEYS, VIEWER_KEYS, FOLDED_KEYS, BET_KEYS, PLAYER_CARDS_KEYS } =
  STATE_FIELD_KEYS;

// "手牌编号"可能的字段名（⚠️ 待核对真实数据再精确）。拿不到就无法跨手统计。
const HAND_ID_KEYS = ['handId', 'handNo', 'handNumber', 'roundId', 'round', 'gameId', 'gameNo', 'handCount'];
// 座位/玩家唯一标识可能的字段名（用来把同一个人在不同帧里认成同一个座位）。
const SEAT_ID_KEYS = ['seatId', 'seat', 'id', 'uid', 'userId', 'playerId'];

// 判定"可靠"的最小累计手数：样本太少（休闲局常见）就别下结论，宁可退回手选画像。
const MIN_HANDS_FOR_RELIABLE = 8;
// 桌面"入池率"分档阈值：平均 VPIP 高于/低于它，判为松/紧桌；中间为标准。
//   VPIP(Voluntarily Put money In Pot) = 主动投钱入池的手数占比，是衡量松紧最常用的指标。
const VPIP_LOOSE_AT = 0.45; // 平均入池率 >= 45% => 偏松（爱玩牌）
const VPIP_TIGHT_AT = 0.22; // 平均入池率 <= 22% => 偏紧（只玩好牌）

/** 在对象里按一组候选 key 取第一个存在的值（和 game-state 的同名小工具一致）。 */
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

/** 从一条记录的 payload 里尽量找出"牌桌状态对象"（和 game-state 同口径）。 */
function extractView(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (pick(payload, PLAYERS_KEYS)) return payload;
  for (const k of VIEW_KEYS) {
    const sub = payload[k];
    if (sub && typeof sub === 'object' && pick(sub, PLAYERS_KEYS)) return sub;
  }
  return null;
}

/** 取某玩家对象的"座位唯一标识"（找不到返回 null，表示这人认不出，跳过不统计）。 */
function seatIdOf(player) {
  const id = pick(player, SEAT_ID_KEYS);
  return id == null ? null : String(id);
}

/** 该玩家手里是否显示了>=2张真牌（hero 几乎每帧都显示；对手通常只在摊牌时显示）。 */
function hasRealHole(player) {
  const raw = pick(player, PLAYER_CARDS_KEYS);
  if (!Array.isArray(raw)) return false;
  return parseCards(raw).length >= 2;
}

/**
 * 【对外主函数】从全部抓包记录构建"对手档案"。
 * @param {Array} records message-store 里的全部记录（{direction,payload,...}）
 * @returns {{
 *   ok:boolean, reliable:boolean, reason:string,
 *   handsSeen:number, tableVpip:(number|null), impliedStyle:(string|null),
 *   seats: Object<string,{hands:number,vpip:number,foldRate:number,showdowns:number}>
 * }}
 *   - reliable:false 时 seats 为空、impliedStyle 为 null —— 调用方应退回手选画像。
 */
export function buildOpponentModel(records) {
  // 统一的"空档案"返回体：任何前提不满足都返回它，保证调用方逻辑简单一致。
  const empty = (reason) => ({
    ok: false,
    reliable: false,
    reason,
    handsSeen: 0,
    tableVpip: null,
    impliedStyle: null,
    seats: {},
  });

  if (!Array.isArray(records) || records.length === 0) {
    return empty('还没有任何抓包记录');
  }

  // —— 第一步：把一手牌的多帧快照"聚合"成每手每座位的一个状态 ——
  //   数据结构：perHand = Map<handId, Map<seatId, {everBet, folded, showed, isHero}>>
  //   同一 (手, 座位) 在不同帧里做 OR 聚合（曾下注过、曾弃牌、曾显示真牌）。
  const perHand = new Map();
  let sawAnyView = false; // 是否至少识别到一帧牌桌状态
  let sawHandId = false; // 是否至少拿到过一次手牌编号（否则无法跨手统计）
  let sawViewerId = false; // 是否至少拿到过一次"我是谁"（否则分不清敌我）

  for (const r of records) {
    // 只认服务器下发的实时状态（和 game-state 一致，避免把自己发出去的请求也算进来）。
    if (r.direction !== DIRECTION.INBOUND) continue;
    const view = extractView(r.payload);
    if (!view) continue;
    sawAnyView = true;

    const players = pick(view, PLAYERS_KEYS);
    if (!Array.isArray(players) || players.length === 0) continue;

    const handId = pick(view, HAND_ID_KEYS);
    if (handId == null) continue; // 没手牌编号：这一帧没法安全归到某一手，跳过
    sawHandId = true;

    const viewerId = pick(view, VIEWER_KEYS);
    if (viewerId != null) sawViewerId = true;
    const viewerKey = viewerId == null ? null : String(viewerId);

    const handKey = String(handId);
    if (!perHand.has(handKey)) perHand.set(handKey, new Map());
    const seatMap = perHand.get(handKey);

    for (const p of players) {
      const seatId = seatIdOf(p);
      if (seatId == null) continue; // 认不出座位：跳过，不乱统计

      // 判定这人是不是"我自己"：用 viewerId 精确匹配座位标识。
      const isHeroById = viewerKey != null && seatId === viewerKey;

      if (!seatMap.has(seatId)) {
        seatMap.set(seatId, { everBet: false, folded: false, showed: false, isHero: false });
      }
      const agg = seatMap.get(seatId);

      // OR 聚合：整手牌里只要出现过该状态，就记为真。
      const bet = Number(pick(p, BET_KEYS));
      if (!Number.isNaN(bet) && bet > 0) agg.everBet = true;
      if (pick(p, FOLDED_KEYS) === true) agg.folded = true;
      if (hasRealHole(p)) agg.showed = true;
      if (isHeroById) agg.isHero = true;
    }
  }

  // —— 前提校验：少任何一个必要条件，就返回空档案（诚实降级）——
  if (!sawAnyView) return empty('尚未识别到牌桌状态');
  if (!sawHandId) return empty('数据流里没有手牌编号，没法跨手统计对手');
  if (!sawViewerId) return empty('数据流里没有本人身份，没法区分敌我');

  // —— 第二步：把"每手每座位"的聚合，累加成"每座位"的长期统计（排除 hero 自己）——
  //   seatStats = Map<seatId, {hands, vpipHands, foldHands, showdowns}>
  const seatStats = new Map();
  let handsSeen = 0; // 真正纳入统计的手数（有编号的那些）

  for (const [, seatMap] of perHand) {
    handsSeen++;
    for (const [seatId, agg] of seatMap) {
      if (agg.isHero) continue; // 只统计对手，不统计自己
      if (!seatStats.has(seatId)) {
        seatStats.set(seatId, { hands: 0, vpipHands: 0, foldHands: 0, showdowns: 0 });
      }
      const s = seatStats.get(seatId);
      s.hands++;
      if (agg.everBet) s.vpipHands++; // 曾主动下注 => 这手"入池"了
      if (agg.folded) s.foldHands++; // 这手弃牌了
      if (agg.showed) s.showdowns++; // 这手摊牌（露过真牌）
    }
  }

  if (seatStats.size === 0 || handsSeen < MIN_HANDS_FOR_RELIABLE) {
    // 有数据但样本不足：返回"有记录但不可靠"，决策引擎仍退回手选画像。
    return {
      ok: true,
      reliable: false,
      reason: `样本偏少（已观察 ${handsSeen} 手，需 ≥ ${MIN_HANDS_FOR_RELIABLE} 手）`,
      handsSeen,
      tableVpip: null,
      impliedStyle: null,
      seats: toSeatsObject(seatStats),
    };
  }

  // —— 第三步：汇总成"桌面入池率"，映射到松/标准/紧 ——
  let vpipSum = 0;
  let counted = 0;
  for (const [, s] of seatStats) {
    if (s.hands <= 0) continue;
    vpipSum += s.vpipHands / s.hands;
    counted++;
  }
  const tableVpip = counted > 0 ? vpipSum / counted : null;

  let impliedStyle = 'normal';
  if (tableVpip != null) {
    if (tableVpip >= VPIP_LOOSE_AT) impliedStyle = 'loose';
    else if (tableVpip <= VPIP_TIGHT_AT) impliedStyle = 'tight';
  }

  return {
    ok: true,
    reliable: true,
    reason: `已观察 ${handsSeen} 手，对手平均入池率约 ${Math.round((tableVpip || 0) * 100)}%，判断这桌偏「${getOpponentStyleLabel(impliedStyle)}」`,
    handsSeen,
    tableVpip,
    impliedStyle,
    seats: toSeatsObject(seatStats),
  };
}

/** 把内部 Map 统计转成普通对象（含算好的比率），方便上层直接读/展示。 */
function toSeatsObject(seatStats) {
  const out = {};
  for (const [seatId, s] of seatStats) {
    const hands = s.hands || 0;
    out[seatId] = {
      hands,
      vpip: hands > 0 ? +(s.vpipHands / hands).toFixed(3) : 0, // 入池率
      foldRate: hands > 0 ? +(s.foldHands / hands).toFixed(3) : 0, // 弃牌率
      showdowns: s.showdowns || 0, // 摊牌次数（露过真牌）
    };
  }
  return out;
}

/**
 * 【共享决策】最终该用哪个"对手画像"？—— 面板和托管共用同一条规则（单一数据源）。
 * ------------------------------------------------------------
 * 为什么要抽出来（讲人话）：
 *   "用手选的还是用自动观察的"这段判断如果面板和决策引擎各写一份，很容易改歪，
 *   导致"面板显示的胜率"和"机器人实际按的画像"对不上。收成一个纯函数，两边都调它，结论永远一致。
 *
 * 规则：
 *   1) 你选了「自动识别」（默认）：观察样本够多够可靠 => 用观察结果；不够 => 先按"标准"算。
 *   2) 你手动选了某种风格（随机/松/标准/紧）=> 永远按你选的算，机器人不插手。
 *   3) 存了一个不认识的值（比如老版本留下的）=> 当成「自动识别」处理，保证不崩。
 *
 * @param {string} chosenStyle 面板"对手类型"下拉的值（auto 或具体风格 id）
 * @param {object|null} model   buildOpponentModel 的结果（可为 null）
 * @returns {{
 *   style:string,           // 最终生效的风格 id（喂给胜率/策略，一定是 OPPONENT_STYLES 里的真实风格）
 *   source:'auto'|'manual', // auto=你选了自动识别，manual=你手动指定
 *   learned:boolean,        // 自动识别时，是否已经用上了观察结果（false=样本不够，暂按标准）
 *   overridden:boolean,     // 同 learned（保留旧字段名，兼容老调用方）
 *   model:(object|null),    // 原样带出档案，方便上层展示
 * }}
 */
export function resolveOpponentStyle(chosenStyle, model) {
  const isManual = OPPONENT_STYLES.some((s) => s.id === chosenStyle) && chosenStyle !== OPPONENT_STYLE_AUTO;
  if (isManual) {
    return { style: chosenStyle, source: 'manual', learned: false, overridden: false, model: model || null };
  }
  const learned = Boolean(model && model.reliable && model.impliedStyle);
  return {
    style: learned ? model.impliedStyle : AUTO_FALLBACK_STYLE,
    source: 'auto',
    learned,
    overridden: learned,
    model: model || null,
  };
}

// 导出常量集合，方便调试/单测时引用同一套阈值与字段名。
export const OPPONENT_MODEL_CONFIG = {
  HAND_ID_KEYS,
  SEAT_ID_KEYS,
  MIN_HANDS_FOR_RELIABLE,
  VPIP_LOOSE_AT,
  VPIP_TIGHT_AT,
};
