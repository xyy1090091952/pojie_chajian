/**
 * 数据层：「下注尺度」统一换算（所有策略共用的唯一出口）
 * ------------------------------------------------------------
 * 为什么要有这一层（讲人话）：
 *   River 的金额框填的是"加注至"——"这一轮我一共下到多少"，不是"再多扔多少"。
 *   以前策略直接算"底池 × 比例"当金额填进去，面对别人下注时就会算小
 *   （例：对手下注 100、底池 200，想反加半池，以前填 100 —— 等于没加）。
 *   现在策略只说"意图"（下半池 / 开池 2.5 个大盲 / 全下），由这里统一换算成正确的"加注至"金额，
 *   再按筹码深度决定"要不要直接全下"、"普通牌最多投多少"，最后夹到服务器给的合法范围里。
 *
 * 意图(sizing)的三种写法：
 *   { kind: 'pot', ratio, strength }   —— 跟注后再加"底池的 ratio 倍"（翻牌后最常用）
 *   { kind: 'preflop', strength }      —— 翻牌前按大盲开池 / 3-bet / 4-bet
 *   { kind: 'allin', strength }        —— 直接全下
 *   { kind: 'raiseTo', value, strength } —— 兼容老写法：直接给"加注至"金额
 * strength（牌力档）决定封顶与能否全下：'normal' 普通 | 'strong' 强牌 | 'monster' 超强牌
 *
 * 纯函数、无副作用，便于单测。
 */

import { SIZING, BLUFF_EV } from '../common/constants.js';

// 牌力档常量：策略层和这里共用同一套字符串，避免拼错。
export const SIZE_STRENGTH = {
  NORMAL: 'normal',
  STRONG: 'strong',
  MONSTER: 'monster',
};

/** 把任意值转成"有限正数"，否则返回 null（防御式：拿不到就当没有，不编数）。 */
function positiveOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 读出换算需要的几个基础量，统一口径（多个函数复用）。
 * @param {object} ctx 局面
 */
function readBase(ctx) {
  const pot = Math.max(0, Number(ctx.pot) || 0);
  const toCall = Math.max(0, Number(ctx.toCall) || 0);
  const heroBet = Math.max(0, Number(ctx.heroBet) || 0);
  // 最高注优先用数据层给的 maxBet；没有就用"我已下 + 要跟"推出来。
  const maxBet = Math.max(Number(ctx.maxBet) || 0, heroBet + toCall);
  const stack = positiveOrNull(ctx.stack); // 我身后剩余筹码（不含本轮已下）
  const bigBlind = positiveOrNull(ctx.bigBlind);
  const minRaiseTo = positiveOrNull(ctx.minRaiseTo);
  const maxRaiseTo = positiveOrNull(ctx.maxRaiseTo);
  // 全下时的"加注至"：服务器给了最大值就用它，否则 = 已下 + 剩余筹码；都没有则未知。
  const allInTo = maxRaiseTo ?? (stack != null ? heroBet + stack : null);
  return { pot, toCall, heroBet, maxBet, stack, bigBlind, minRaiseTo, maxRaiseTo, allInTo };
}

/**
 * 算 SPR（筹码底池比）= 剩余筹码 ÷ 跟注后的底池。拿不到筹码返回 null。
 *   SPR 越小 => 筹码相对底池越浅 => 好牌越该直接全下（剩一点筹码留着没意义）。
 */
export function computeSpr(ctx) {
  const { pot, toCall, stack } = readBase(ctx);
  if (stack == null) return null;
  return stack / Math.max(1, pot + toCall);
}

/**
 * 翻牌前按大盲计算"加注至"金额。
 *   - 没人加注（最高注 ≤ 1 个大盲）：开池 2.5BB，前面每个平跟者 +1BB；
 *   - 面对一次加注：3-bet = 对手加注额 × 3（有位置）/ × 3.5（没位置）；
 *   - 面对 3-bet 以上：4-bet = 对手加注额 × 2.3。
 *   拿不到大盲时退回：有最小加注额就用它 × 1.25，否则按跟注后底池的 3/4 算。
 */
function preflopRaiseTo(base, position) {
  const { pot, toCall, maxBet, bigBlind, minRaiseTo } = base;

  if (bigBlind != null) {
    const unopened = maxBet <= bigBlind * 1.05;
    if (unopened) {
      // 估算平跟人数：底池里超出"大小盲 1.5BB"的部分，大约每 1BB 是一个平跟者。
      //   站点底池若不含本轮下注，这里自然算出 0 个，等于标准开池，不会出错。
      const limpers = Math.min(
        SIZING.MAX_LIMPERS_COUNTED,
        Math.max(0, Math.round((pot - bigBlind * 1.5) / bigBlind))
      );
      return bigBlind * (SIZING.OPEN_RAISE_BB + limpers * SIZING.OPEN_PER_LIMPER_BB);
    }
    if (maxBet >= bigBlind * SIZING.FOURBET_TRIGGER_BB) {
      return maxBet * SIZING.FOURBET_MULT;
    }
    const mult = position === 'late' ? SIZING.THREEBET_IP_MULT : SIZING.THREEBET_OOP_MULT;
    return maxBet * mult;
  }

  // —— 拿不到大盲的兜底 ——
  if (maxBet > 0 && toCall > 0) return maxBet * SIZING.THREEBET_OOP_MULT;
  if (minRaiseTo != null) return minRaiseTo * 1.25;
  return maxBet + 0.75 * (pot + toCall);
}

/**
 * 按意图算出"原始"加注至金额（还没封顶、没夹合法范围）。
 */
function rawRaiseTo(base, sizing, position) {
  switch (sizing.kind) {
    case 'allin':
      return base.allInTo ?? null;
    case 'preflop':
      return preflopRaiseTo(base, position);
    case 'raiseTo':
      return positiveOrNull(sizing.value);
    case 'pot':
    default: {
      // 关键公式：加注至 = 当前最高注 + 比例 ×（底池 + 我要跟的钱）
      //   = "先跟平，再往跟注后的底池里加 ratio 倍"。toCall=0 时就是普通的"下注 ratio 倍底池"。
      const ratio = Number(sizing.ratio) || 0.5;
      return base.maxBet + ratio * (base.pot + base.toCall);
    }
  }
}

/**
 * 【对外】诈唬/半诈唬下注：按"期望收益(EV)"从几个候选尺度里挑最划算的那一个。
 * ------------------------------------------------------------
 * 讲人话：诈唬的唯一目的是"把对手吓到弃牌"。
 *   - 下太小：对手花小钱就跟，吓不走，纯亏；
 *   - 下太大：被跟时自己亏得也多。
 *   所以这里给几个候选比例，用这条公式给每个比例算一个 EV，挑最高的：
 *     EV = P(对手弃牌) × 现在能赢的底池  −  P(对手跟注) × 这次要新投入的筹码
 *   其中"对手弃牌概率"随下注变大而升高（下得越狠越容易吓走），公式会自动在
 *   "吓退效果"和"被跟代价"之间找平衡；EV 打平时优先选更大的尺度（更有压迫力）。
 *
 * 为什么放在数据层而不是策略层：这是"把意图换算成尺度"的纯计算，和 resolveRaiseTo 同属一层，
 *   策略层只负责"决定要不要诈唬"，具体打多大交给这里统一口径，便于单测与复用。
 *
 * @param {object} p
 *   @param {number}   p.pot        当前底池（诈唬成功时赢到的钱，近似用它）
 *   @param {number}   p.heroBet    我本轮已下注额（用来算"新投入 = 加注至 − 已下"）
 *   @param {number}   p.maxBet     当前最高注（算加注至要用）
 *   @param {number}   p.toCall     我还要跟的钱（面对下注时 >0；无人下注时 0）
 *   @param {number}   p.bluffBias  对手"诈唬敏感度"：>1 爱弃牌(诈唬易成功)，<1 爱跟注
 *   @param {number[]} [p.candidates] 候选"占底池比例"（默认用 BLUFF_EV.RATIO_CANDIDATES）
 * @returns {{ratio:number, foldProb:number, ev:number}} 选中的比例 + 估计弃牌率 + 该比例的 EV
 */
export function pickBluffRatioByEV({ pot, heroBet, maxBet, toCall, bluffBias, candidates }) {
  const list = Array.isArray(candidates) && candidates.length ? candidates : BLUFF_EV.RATIO_CANDIDATES;
  const safePot = Math.max(1, Number(pot) || 0); // 防 0 除、也避免底池为 0 时 EV 全 0
  const safeToCall = Math.max(0, Number(toCall) || 0);
  const safeMaxBet = Math.max(0, Number(maxBet) || 0);
  const safeHeroBet = Math.max(0, Number(heroBet) || 0);
  // 对手弃牌基准：紧弱爱弃牌的对手(bluffBias 高)基准更高，夹到合理区间。
  const base = clamp01(BLUFF_EV.FOLD_AT_HALF_POT_BASE * (Number(bluffBias) || 1));

  let best = null;
  for (const ratio of list) {
    // 这个比例换算出的"加注至"与"新投入筹码"（和 rawRaiseTo 的 pot 口径一致）。
    const raiseTo = safeMaxBet + ratio * (safePot + safeToCall);
    const invest = Math.max(0, raiseTo - safeHeroBet); // 这次真正要掏出去的钱
    // 弃牌概率：以"半池"为基准，每比半池大 1 个底池就加 FOLD_SLOPE，夹到上下限。
    const foldProb = clampFold(base + (ratio - 0.5) * BLUFF_EV.FOLD_SLOPE_PER_POT);
    // EV：吓走对手赢下底池 vs 被跟付出 invest。
    const ev = foldProb * safePot - (1 - foldProb) * invest;
    // 取 EV 最大者；EV 几乎相等(差距 < 0.5%底池)时选更大的 ratio（更有压迫力）。
    if (
      !best ||
      ev > best.ev + safePot * 0.005 ||
      (Math.abs(ev - best.ev) <= safePot * 0.005 && ratio > best.ratio)
    ) {
      best = { ratio, foldProb, ev };
    }
  }
  return best || { ratio: list[0], foldProb: base, ev: 0 };
}

/** 把值夹到 [0,1]。 */
function clamp01(v) {
  return Math.min(1, Math.max(0, Number(v) || 0));
}

/** 把弃牌概率夹到配置的上下限。 */
function clampFold(v) {
  return Math.min(BLUFF_EV.FOLD_MAX, Math.max(BLUFF_EV.FOLD_MIN, Number(v) || 0));
}

/**
 * 【对外主函数】把策略意图换算成最终的"加注至"金额。
 * @param {object} ctx 局面（需要 pot/toCall/heroBet/maxBet/stack/bigBlind/minRaiseTo/maxRaiseTo/position/board）
 * @param {object} sizing 意图，见文件头
 * @param {object} [valueBet] 大牌下注配置 {strongStackCap, monsterStackCap}（来自 VALUE_BET_PROFILES）
 * @returns {{ok:boolean, raiseTo?:number, allIn?:boolean, note?:string, reason?:string}}
 *   ok=false 表示"这次没法正常加注"（如普通牌只能全下），上层应降级成跟注/过牌。
 */
export function resolveRaiseTo(ctx, sizing, valueBet = {}) {
  const base = readBase(ctx);
  const intent = sizing && typeof sizing === 'object' ? sizing : { kind: 'pot', ratio: 0.5 };
  const strength = intent.strength || SIZE_STRENGTH.NORMAL;
  const isStrong = strength === SIZE_STRENGTH.STRONG || strength === SIZE_STRENGTH.MONSTER;
  const isMonster = strength === SIZE_STRENGTH.MONSTER;
  const preflop = !Array.isArray(ctx.board) || ctx.board.length === 0;
  const notes = [];

  let raiseTo = rawRaiseTo(base, intent, ctx.position);
  if (raiseTo == null) return { ok: false, reason: '拿不到筹码数据，无法确定全下金额。' };

  // 1) 筹码深度判断：强牌 + 筹码浅（SPR 低）=> 直接全下，别留一点尾巴。
  const spr = computeSpr(ctx);
  if (base.stack != null && base.allInTo != null && intent.kind !== 'allin') {
    const invest = raiseTo - base.heroBet; // 这次要新投入的筹码
    const commitSpr = isMonster ? SIZING.MONSTER_COMMIT_SPR : SIZING.STRONG_COMMIT_SPR;
    if (isStrong && spr != null && spr <= commitSpr && !preflop) {
      raiseTo = base.allInTo;
      notes.push(`筹码底池比 ${spr.toFixed(1)} 偏低，强牌直接全下`);
    } else if (isStrong && invest >= base.stack * SIZING.COMMIT_RATIO) {
      raiseTo = base.allInTo;
      notes.push('这次已要投入大半筹码，干脆全下');
    } else {
      // 2) 封顶：普通牌最多投入 1/3 筹码；强牌/超强牌按"大牌下注"配置放宽。
      const capRatio = isMonster
        ? Number(valueBet.monsterStackCap) || 0.75
        : isStrong
          ? Number(valueBet.strongStackCap) || 0.5
          : SIZING.NORMAL_STACK_CAP;
      const capTo = base.heroBet + base.stack * capRatio;
      if (raiseTo > capTo) {
        raiseTo = capTo;
        notes.push(`封顶到剩余筹码的 ${Math.round(capRatio * 100)}%`);
      }
    }
  } else if (base.stack == null && !preflop && intent.kind !== 'allin') {
    // 拿不到筹码：翻牌后按底池倍数保守封顶（翻牌前按大盲算的尺度本身有界，不再封）。
    const potCap = base.pot * (isStrong ? SIZING.NO_STACK_POT_CAP_STRONG : SIZING.NO_STACK_POT_CAP);
    const capTo = base.maxBet + Math.max(potCap, 1);
    if (potCap > 0 && raiseTo > capTo) {
      raiseTo = capTo;
      notes.push('未拿到筹码数据，按底池保守封顶');
    }
  }

  // 3) 夹到服务器给的合法范围：先不超过最大，再不低于最小。
  if (base.maxRaiseTo != null) raiseTo = Math.min(raiseTo, base.maxRaiseTo);
  if (base.minRaiseTo != null && raiseTo < base.minRaiseTo) {
    raiseTo = base.minRaiseTo;
    notes.push(`抬到最小合法加注 ${base.minRaiseTo}`);
  }
  // 加注至必须严格高于当前最高注，否则就不是加注了。
  if (raiseTo <= base.maxBet) {
    return { ok: false, reason: '算出的金额不高于当前最高注，无法构成加注。' };
  }
  raiseTo = Math.round(raiseTo);

  // 4) 是否全下：等于全下金额（或超出剩余筹码）即视为全下。
  const allIn = base.allInTo != null && raiseTo >= Math.round(base.allInTo);

  // 5) 安全阀：普通牌被迫全下（如短筹码时最小加注就是全下）=> 不加注，交给上层降级。
  //    例外：筹码已经很浅（SPR ≤ 1，跟注后底池已大于剩余筹码），这时全下本来就合理。
  if (allIn && !isStrong && intent.kind !== 'allin' && !(spr != null && spr <= 1)) {
    return { ok: false, reason: '普通牌不值得全下，改为更稳妥的动作。' };
  }

  return { ok: true, raiseTo, allIn, note: notes.join('；') };
}
