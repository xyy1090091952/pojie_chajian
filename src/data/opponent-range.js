/**
 * 数据层：「对手范围收窄」（按对手的下注行为，估计他手里大概是什么牌）
 * ------------------------------------------------------------
 * 讲人话：
 *   胜率是假设"对手手里是前 X% 的起手牌"算出来的。但对手的行为本身就是信息——
 *   翻牌前加注、3-bet、翻牌后下大注 / 加注的人，手里普遍比"平均"更强。
 *   如果不考虑这一点，机器人就会高估自己的胜率、被大注一推就乱跟（最常见的漏钱点）。
 *
 *   ① 翻牌前：只能看起手牌，所以把 X 乘一个 <1 的系数（加注 ×0.55、3-bet ×0.3）。
 *   ② 翻牌后：光看起手牌会严重失真。
 *      例：公共牌 J J 8 3 2，对手河牌下大注。按"前 50% 起手牌"算，里面一大半是 AK、AQ、KQ 这种
 *      没中的高牌，机器人以为自己的 5 5 能赢它们 —— 但现实中这些牌河牌几乎不会下大注。
 *      所以改为：看对手每一手可能的牌"在这副公共牌上中了什么"，给一个"会这样下注的可能性"权重，
 *      模拟发牌时按权重抽：成手（三条J、更大的对子）多抽，空气牌少抽；注越大、越是"加注"，空气越少。
 *
 * 纯函数：输入局面 + 基础百分比，输出收窄后的范围 + 一句中文说明。
 */

import { RANGE_NARROWING, SIZING } from '../common/constants.js';
import { classifyMade, drawStrength, DRAW } from './hand-class.js';
import { detectDraws, parseCard } from './poker-engine.js';

// 听牌档 -> 权重表里的 key（成手档的 key 直接就是 MADE 的值，如 'top_pair'）。
const DRAW_WEIGHT_KEY = { [DRAW.STRONG]: 'drawStrong', [DRAW.WEAK]: 'drawWeak' };
// 权重表里"空气牌"的 key（河牌诈唬折扣只打在它上面）。
const BLUFF_KEY = 'none';

/** 把字符串牌统一转成 {r,s}，并去掉解析失败的。 */
function toCards(list) {
  return (list || []).map((c) => (typeof c === 'string' ? parseCard(c) : c)).filter(Boolean);
}

/** 两张牌的唯一指纹（与顺序无关），用来缓存"这手牌的权重"，同一手牌只算一次。 */
function comboKey(a, b) {
  const x = `${a.r}${a.s}`;
  const y = `${b.r}${b.s}`;
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

/**
 * 河牌诈唬更少：把权重表里"空气牌"的权重再打个折，返回新表（不改原常量，保证数据不被污染）。
 */
function applyRiverDiscount(weights, isRiver) {
  if (!isRiver) return weights;
  return { ...weights, [BLUFF_KEY]: weights[BLUFF_KEY] * RANGE_NARROWING.RIVER_BLUFF_FACTOR };
}

/**
 * 造一个"手牌权重函数"：给对手的两张底牌，返回 0~1 的"他会这样下注的可能性"。
 *   规则：看这手牌在【当前公共牌】上的成手分级（与策略层同一套，见 hand-class.js），
 *   有听牌时取"成手权重"和"听牌权重"里更大的那个。结果按手牌缓存，蒙特卡洛里反复用也不慢。
 * @param {Array<{r,s}>} board   当前已翻开的公共牌（3~5 张）
 * @param {object}       weights 权重表（见 constants.js 的 RANGE_NARROWING）
 * @returns {(a:{r,s}, b:{r,s}) => number}
 */
export function makeHandWeigher(board, weights) {
  const isRiver = board.length >= 5;
  const cache = new Map();
  return (a, b) => {
    const key = comboKey(a, b);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;

    const made = classifyMade([a, b], board);
    let w = weights[made] ?? 1;
    if (!isRiver) {
      const drawKey = DRAW_WEIGHT_KEY[drawStrength(detectDraws([a, b, ...board]))];
      if (drawKey) w = Math.max(w, weights[drawKey] ?? 0);
    }
    cache.set(key, w);
    return w;
  };
}

/**
 * 翻牌后：根据"对手是下注还是加注、注有多大"，选出下注者和其他对手的权重表。
 * @returns {{label:string, bettor:object, others:object}}
 */
function pickPostflopWeights(ctx, ratio, isRiver) {
  const heroBet = Number(ctx.heroBet) || 0;
  // 我这一轮已经下过注、还要再跟 => 对手是在我下注后又"加注"，信号最强。
  const raised = heroBet > 0;
  const tier =
    RANGE_NARROWING.POSTFLOP_BET_TIERS.find((t) => ratio <= t.maxRatio) ||
    RANGE_NARROWING.POSTFLOP_BET_TIERS[RANGE_NARROWING.POSTFLOP_BET_TIERS.length - 1];
  const source = raised ? RANGE_NARROWING.POSTFLOP_RAISE : tier;
  return {
    label: raised ? '在我下注后加注' : `下${tier.label}`,
    bettor: applyRiverDiscount(source.weights, isRiver),
    others: applyRiverDiscount(RANGE_NARROWING.POSTFLOP_CALLER_WEIGHTS, isRiver),
  };
}

/**
 * @param {object} ctx 局面（用 board/pot/toCall/maxBet/heroBet/bigBlind）
 * @param {number} basePercent 对手风格对应的基础范围（如 标准=50）
 * @returns {{percent:number, factor:number, note:string, weighers:null|{bettor:Function, others:Function}}}
 *   percent：对手起手牌范围（前 X%）；factor=1 表示起手牌范围没收窄；
 *   weighers：翻牌后面对下注时的"手牌权重函数"（下注者一个、其他对手一个），交给胜率引擎按权重抽牌；
 *   note：用于面板/理由展示（没收窄时为空串）。
 */
export function narrowOpponentPercent(ctx, basePercent) {
  const base = Number(basePercent) || 100;
  const toCall = Math.max(0, Number(ctx?.toCall) || 0);
  const board = toCards(ctx?.board);
  const unchanged = { percent: base, factor: 1, note: '', weighers: null };

  // 没人下注（可以免费过牌）：对手没有表现出强度，不收窄。
  if (toCall <= 0) return unchanged;

  // —— 翻牌前：只有"加注"才说明强度；只跟大盲（平跟/盲注）不算。——
  if (board.length === 0) {
    const bigBlind = Number(ctx.bigBlind);
    const maxBet = Number(ctx.maxBet) || 0;
    if (!(bigBlind > 0)) return unchanged; // 拿不到大盲，判断不了是不是加注，不乱收窄
    let factor;
    let label;
    if (maxBet >= bigBlind * SIZING.FOURBET_TRIGGER_BB) {
      factor = RANGE_NARROWING.PREFLOP_3BET_FACTOR;
      label = '对手翻牌前再加注(3-bet)';
    } else if (maxBet > bigBlind * 1.05) {
      factor = RANGE_NARROWING.PREFLOP_RAISE_FACTOR;
      label = '对手翻牌前加注';
    } else {
      return unchanged;
    }
    const percent = Math.max(RANGE_NARROWING.MIN_PERCENT, Math.round(base * factor));
    if (percent >= base) return unchanged;
    return { percent, factor, note: `${label}，按其前 ${percent}% 的牌估算胜率`, weighers: null };
  }

  // 公共牌数据异常（不足 3 张）时不做牌面相关的估算，避免乱算。
  if (board.length < 3) return unchanged;

  // —— 翻牌后：起手牌范围不变，改为按"这手牌在当前公共牌上会不会这样下注"加权。——
  const pot = Math.max(1, Number(ctx.pot) || 0);
  const isRiver = board.length >= 5;
  const picked = pickPostflopWeights(ctx, toCall / pot, isRiver);
  const street = isRiver ? '河牌' : '';
  return {
    percent: base,
    factor: 1,
    note: `对手${street}${picked.label}，按"会这样下注的牌"（成手为主、少量诈唬）估算胜率`,
    weighers: {
      bettor: makeHandWeigher(board, picked.bettor),
      others: makeHandWeigher(board, picked.others),
    },
  };
}
