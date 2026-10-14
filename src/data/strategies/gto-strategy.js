/**
 * 策略层：「档位③·GTO 近似策略」
 * ============================================================
 * 【先把话说清楚（诚实红线）】
 *   这【不是】真正的 GTO。真 GTO 要用 CFR 求解器离线算几小时、生成几 GB 的
 *   解法库，再查表执行——前端插件里既没算力也没解法库，做不到，也不骗你能做到。
 *
 *   这【是】把 GTO 的几条"核心思想"用我们手上的合法数据（胜率/底池/牌面）
 *   实时近似出来，目标是"难被对手看穿、长期不吃亏"：
 *
 *     1) 混合频率（Mixed Strategy）：同一个局面不总是做同一个动作，
 *        而是按一组概率"掷骰子"决定。这样对手抓不到你的规律，无法针对你。
 *        —— 这是 GTO 和前两档最本质的区别：前两档是"确定性"的（同输入同输出），
 *           本档是"带频率的随机"（同输入可能跟、可能加、可能弃，但比例是算好的）。
 *
 *     2) MDF 最小防守频率（Minimum Defense Frequency）：面对对手下注，
 *        为了不被"无脑诈唬"剥削，你必须至少防守（跟注/加注）一定比例的牌。
 *        MDF = 底池 / (底池 + 对手下注额)。对手下得越小，你越要多防守。
 *
 *     3) 价值/诈唬平衡（Polarization）：主动下注时，不只用好牌下注，
 *        也按"平衡比例"掺入一部分诈唬，让对手跟也不是、弃也不是。
 *        平衡诈唬比例由下注尺度决定（下注越大，允许的诈唬越多）。
 *
 *     4) 尺度化下注（Bet Sizing）：按牌面湿度和牌力，在 1/3、1/2、2/3、超池
 *        几档里选，而不是永远一个固定比例。
 *
 * 【返回结构】沿用所有策略共享的"合同"：{ action, amount, reason }
 *   —— 和档位①②完全一致，decision-engine 可无缝互换。
 *
 * 【依赖的随机性】
 *   混合频率需要随机数。为便于单测复现，decide 支持从外部注入一个 rng（返回 0~1），
 *   不注入时默认用 Math.random。这样测试里可以喂固定序列、断言频率分布。
 */

import {
  POKER_ACTION,
  POKER_ACTION_NAMES,
  EQUITY,
} from '../../common/constants.js';
import { potOdds } from '../equity-engine.js';
import { evaluate, detectDraws, analyzeBoardTexture, HAND_RANK, BOARD_TEXTURE } from '../poker-engine.js';

// ============ 本档位专用阈值（集中成常量，便于调参，和逻辑解耦） ============

// —— 牌力分层（GTO 里把手牌粗分成几类，各类有不同的频率策略）——
//   用"成手等级 + 胜率"共同判定，避免只看其一走偏。
const NUT_RANK = HAND_RANK.STRAIGHT; // 顺子及以上=超强牌（坚果区），几乎只加注/跟注
const STRONG_RANK = HAND_RANK.THREE_KIND; // 三条及以上=强牌，主要价值下注
const MEDIUM_RANK = HAND_RANK.ONE_PAIR; // 一对及以上=中等牌，薄价值/抓诈
// 胜率分界（配合牌力，判"这手到底算强还是弱"）：
const EQ_STRONG = 66; // 胜率 >= 66% 视为"价值区"
const EQ_MEDIUM = 48; // 48%~66% 视为"边缘/摊牌区"
// 低于 EQ_MEDIUM 的牌，要么是诈唬候选（有听牌），要么直接放弃。

// —— 下注尺度分档（相对底池的比例）。GTO 常用多尺度，这里给 4 档 ——
const SIZING = {
  SMALL: 0.33, // 1/3 池：干牌面、薄价值、小探测
  MID: 0.5, // 1/2 池：常规
  BIG: 0.66, // 2/3 池：湿牌面保护、强价值
  OVERBET: 1.1, // 超池：极化（要么坚果要么诈唬）场景，收益最大化
};

// —— 混合频率表（核心）：每种"局面类别"给一组动作概率，加起来必须=1 ——
//   读法：{raise: 0.7, call: 0.3} 表示 70% 概率加注、30% 概率跟注。
//   这些数字是对 GTO 解法常见倾向的"经验近似"，不是精确解，但方向正确、且带随机性。
const FREQ = {
  // 免费行动（toCall=0）时：
  FREE_VALUE: { raise: 0.8, check: 0.2 }, // 强价值牌：多数下注，偶尔过牌埋伏（混频）
  FREE_SEMIBLUFF: { raise: 0.5, check: 0.5 }, // 有听牌：一半拿来半诈唬，一半过牌controlled
  FREE_GIVEUP: { check: 1.0 }, // 没价值没听牌：过牌放弃主动权
  // 面对下注（toCall>0）时：
  FACING_NUT: { raise: 0.6, call: 0.4 }, // 坚果区：多加注,也混入平跟埋伏
  FACING_STRONG: { raise: 0.3, call: 0.7 }, // 强牌：以跟注为主，少量加注
  FACING_BLUFFCATCH: { call: 1.0 }, // 抓诈区：按 MDF 决定是否在"该防守"里，守则跟
  FACING_DRAW: { call: 0.7, raise: 0.3 }, // 听牌：多数跟注搏成牌，部分半诈唬加注施压
};

/**
 * 从一组"动作->概率"里按概率随机抽一个动作（混合频率的落地）。
 * @param {Object<string,number>} dist 概率分布，如 {raise:0.7, call:0.3}
 * @param {function():number} rng 返回 [0,1) 的随机函数（可注入，便于测试）
 * @returns {string} 抽中的动作 key
 */
function sampleAction(dist, rng) {
  const r = rng();
  let acc = 0;
  for (const [action, p] of Object.entries(dist)) {
    acc += p;
    if (r < acc) return action;
  }
  // 浮点误差兜底：返回最后一个动作
  const keys = Object.keys(dist);
  return keys[keys.length - 1];
}

/**
 * 听牌强弱判断（和档位②同口径，保持一致）。
 * @returns {'strong'|'weak'|'none'}
 */
function drawStrength(draws) {
  if (!Array.isArray(draws) || draws.length === 0) return 'none';
  const text = draws.join('');
  if (text.includes('同花') || text.includes('两头顺')) return 'strong';
  if (text.includes('卡顺')) return 'weak';
  return 'none';
}

/**
 * 按牌面湿度挑一个下注尺度（湿面下大、干面下小）。
 * @param {string} textureLevel BOARD_TEXTURE 之一
 * @param {boolean} polarize 是否极化场景（坚果/纯诈唬），极化时用超池
 * @returns {number} SIZING 里的某个比例
 */
function pickSizing(textureLevel, polarize) {
  if (polarize) return SIZING.OVERBET;
  if (textureLevel === BOARD_TEXTURE.WET) return SIZING.BIG;
  if (textureLevel === BOARD_TEXTURE.DRY) return SIZING.SMALL;
  return SIZING.MID;
}

/** 底池 × 比例，向下取整，至少 1。 */
function raiseAmount(pot, ratio) {
  const base = Number(pot) || 0;
  return Math.max(1, Math.floor(base * ratio));
}

/**
 * 【对外主函数】GTO 近似决策。
 * @param {object} params
 *   @param {object} params.ctx 局面：{hole, board, opponents, pot, toCall, position?}
 *   @param {object} params.eq  胜率结果：{ok, equity, ...}
 *   @param {string} [params.opponentStyle] 对手风格 id（本档暂不强依赖，预留对齐接口）
 *   @param {function():number} [params.rng] 可注入随机源（测试复现用），默认 Math.random
 * @returns {{action:string, amount:number, reason:string}}
 */
export function decide({ ctx, eq, rng }) {
  const roll = typeof rng === 'function' ? rng : Math.random;

  // 兜底：胜率没算出来就别乱动。
  if (!eq || !eq.ok) {
    return { action: POKER_ACTION.CHECK, amount: 0, reason: '胜率数据不足，暂不主动行动。' };
  }

  const equity = eq.equity;
  const pot = Number(ctx.pot) || 0;
  const toCall = Number(ctx.toCall) || 0;

  // —— 先算本档要用的几样信息 ——
  const allCards = [...ctx.hole, ...ctx.board];
  const madeRank = evaluate(allCards)[0]; // 成手等级
  const canImprove = ctx.board.length < 5; // 河牌后听牌无价值
  const draw = canImprove ? drawStrength(detectDraws(allCards)) : 'none';
  const texture = analyzeBoardTexture(ctx.board);

  // 把这手牌归到一个"类别"（供查频率表）。顺序：坚果 > 强 > 中/抓诈 > 听牌 > 放弃。
  const isNut = madeRank >= NUT_RANK || equity >= 82;
  const isStrong = madeRank >= STRONG_RANK || equity >= EQ_STRONG;
  const isMedium = madeRank >= MEDIUM_RANK || equity >= EQ_MEDIUM;
  const hasDraw = draw === 'strong';

  // ========== 情况 A：不用花钱（可免费过牌/下注）==========
  if (toCall <= 0) {
    // 选分布：价值 / 半诈唬 / 放弃
    let dist = FREQ.FREE_GIVEUP;
    if (isStrong) dist = FREQ.FREE_VALUE;
    else if (hasDraw) dist = FREQ.FREE_SEMIBLUFF;

    const action = sampleAction(dist, roll);
    if (action === 'raise') {
      // 极化：坚果牌 or 纯诈唬（没成手但有强听）时用超池，收益/压迫最大化
      const polarize = isNut || (!isMedium && hasDraw);
      const ratio = pickSizing(texture.level, polarize);
      const amount = raiseAmount(pot, ratio);
      const tag = isStrong ? '价值下注' : '半诈唬';
      return {
        action: POKER_ACTION.RAISE,
        amount,
        reason: `GTO近似·${tag}：按 ${Math.round(ratio * 100)}% 池下注约 ${amount}（混频抽中下注）。`,
      };
    }
    return {
      action: POKER_ACTION.CHECK,
      amount: 0,
      reason: `GTO近似·过牌控池（胜率 ${equity}%，混频抽中过牌，隐藏手牌区间）。`,
    };
  }

  // ========== 情况 B：面对下注（toCall>0）==========
  // 1) 先算 MDF（最小防守频率）：pot / (pot + toCall)。
  //    含义：为了不被对手无脑诈唬剥削，这个比例的牌必须守住（不能都弃）。
  const mdf = pot + toCall > 0 ? pot / (pot + toCall) : 0.5;

  // 2) 底池赔率 / 回本线：跟注在数学上划不划算。
  const odds = potOdds(pot, toCall);
  const breakeven = odds.ok && odds.breakevenPct != null ? odds.breakevenPct : 50;
  const margin = equity - breakeven;

  // 3) 坚果 / 强牌：按频率表混合"加注 or 跟注"。
  if (isNut) {
    const action = sampleAction(FREQ.FACING_NUT, roll);
    if (action === 'raise') {
      const amount = raiseAmount(pot, pickSizing(texture.level, true)); // 坚果极化加注
      return { action: POKER_ACTION.RAISE, amount, reason: `GTO近似·坚果加注约 ${amount}（混频抽中加注，极化施压）。` };
    }
    return { action: POKER_ACTION.CALL, amount: 0, reason: `GTO近似·坚果平跟埋伏（混频抽中跟注，诱对手继续下注）。` };
  }
  if (isStrong) {
    const action = sampleAction(FREQ.FACING_STRONG, roll);
    if (action === 'raise') {
      const amount = raiseAmount(pot, pickSizing(texture.level, false));
      return { action: POKER_ACTION.RAISE, amount, reason: `GTO近似·强牌价值加注约 ${amount}（混频抽中加注）。` };
    }
    return { action: POKER_ACTION.CALL, amount: 0, reason: `GTO近似·强牌跟注（胜率 ${equity}%，混频以跟注为主）。` };
  }

  // 4) 有强听牌：按频率表混合"跟注搏成牌 or 半诈唬加注"。
  if (hasDraw && canImprove) {
    const action = sampleAction(FREQ.FACING_DRAW, roll);
    if (action === 'raise') {
      const amount = raiseAmount(pot, pickSizing(texture.level, false));
      return { action: POKER_ACTION.RAISE, amount, reason: `GTO近似·听牌半诈唬加注约 ${amount}（成牌赢大池、弃牌也赚）。` };
    }
    return { action: POKER_ACTION.CALL, amount: 0, reason: `GTO近似·听牌跟注搏成牌（隐含赔率，混频抽中跟注）。` };
  }

  // 5) 抓诈区（中等牌，没成强牌也没强听）：用 MDF 决定"守不守"。
  //    做法：把"胜率相对回本线的富余"换算成一个防守倾向，再和 MDF 比，
  //    并掺入随机（混频），避免每次临界牌都做一样的动作被对手读死。
  if (isMedium) {
    // 防守得分：胜率够本(margin>=0)则强烈倾向防守；略不够本则按 MDF 概率性防守。
    //   defendProb 介于 0~1：越接近 1 越该跟。
    let defendProb;
    if (margin >= 0) {
      defendProb = 1; // 够本：必守（跟注在数学上就划算）
    } else if (margin <= EQUITY.FOLD_MARGIN) {
      defendProb = Math.max(0, mdf - 0.15); // 明显不够本：只按略低于 MDF 的频率象征性防守
    } else {
      defendProb = mdf; // 临界：恰好按 MDF 防守，杜绝被诈唬剥削
    }
    if (roll() < defendProb) {
      return {
        action: POKER_ACTION.CALL,
        amount: 0,
        reason: `GTO近似·抓诈跟注（按最小防守频率 MDF≈${Math.round(mdf * 100)}% 防守，胜率 ${equity}%）。`,
      };
    }
    return {
      action: POKER_ACTION.FOLD,
      amount: 0,
      reason: `GTO近似·弃牌（本手落在 MDF 之外的放弃区，胜率 ${equity}% 不足以防守）。`,
    };
  }

  // 6) 其余（弱牌、无听牌）=> 弃牌。
  return {
    action: POKER_ACTION.FOLD,
    amount: 0,
    reason: `GTO近似·弃牌（胜率 ${equity}% 偏低、无听牌，防守无利可图）。`,
  };
}

// 动作名小助手，和其它档位保持一致口径。
export function actionName(action) {
  return POKER_ACTION_NAMES[action] || action;
}
