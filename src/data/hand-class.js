/**
 * 数据层：「成手分级」（一手牌在当前公共牌上到底算多强）
 * ------------------------------------------------------------
 * 讲人话：
 *   牌型名字会骗人。公共牌 J J 8 3 2，你拿 5 5，牌型显示"两对"，
 *   但其中 J J 是公共牌送给所有人的，你自己只贡献了一对 5 —— 实际只是"小对子"。
 *   所以分级时要剔除"公共牌自带的部分"，只看"我自己的牌带来了多少"。
 *
 * 这套规则两处共用（保证口径一致）：
 *   1) 策略层：判断"我"是强牌还是弱牌（complex-strategy.js）；
 *   2) 对手范围：判断"对手某手牌"下注的可能性有多大（opponent-range.js）。
 *
 * 全部是纯函数，便于测试。
 */

import { evaluate, compareHands, parseCard, HAND_RANK } from './poker-engine.js';

// 成手分级（只看"自己的牌带来的部分"）：
export const MADE = {
  MONSTER: 'monster', // 葫芦及以上
  STRONG: 'strong', // 两对(公共牌未成对) / 三条 / 顺子 / 同花
  TOP_PAIR: 'top_pair', // 顶对或超对
  WEAK_PAIR: 'weak_pair', // 中小对子
  NONE: 'none', // 没成牌，或只是公共牌自带的牌
};

// 分级的中文名（写进决策理由 / 面板）。
export const MADE_LABEL = {
  [MADE.MONSTER]: '超强成手',
  [MADE.STRONG]: '强成手',
  [MADE.TOP_PAIR]: '顶对',
  [MADE.WEAK_PAIR]: '小对子',
  [MADE.NONE]: '未成手',
};

// 听牌强弱档。
export const DRAW = {
  STRONG: 'strong', // 同花听牌 / 两头顺
  WEAK: 'weak', // 卡顺
  NONE: 'none',
};

/** 把字符串牌统一转成 {r,s}，并去掉解析失败的。 */
function toCards(list) {
  return (list || []).map((c) => (typeof c === 'string' ? parseCard(c) : c)).filter(Boolean);
}

/**
 * 成手分级：关键是剔除"公共牌自带的部分"。
 *   例：公共牌 9 9 J J x，我拿 A Q —— 牌型显示"两对"，但两对全是公共牌的，我只多了个 A 踢脚，
 *   不能当两对去价值下注。办法：比较"我的牌型"和"只看公共牌的牌型"，我没加成就降级。
 * @param {Array<string|{r,s}>} hole  两张底牌
 * @param {Array<string|{r,s}>} board 已翻开的公共牌（3~5 张）
 * @returns {string} MADE 中的一档
 */
export function classifyMade(hole, board) {
  const holeCards = toCards(hole);
  const boardCards = toCards(board);
  const heroScore = evaluate([...holeCards, ...boardCards]);
  const boardScore = evaluate(boardCards);
  const rank = heroScore[0];
  const boardRank = boardScore[0];

  // 河牌 5 张时，若最好 5 张就是公共牌本身 => 底牌完全没贡献。
  if (boardCards.length >= 5 && compareHands(heroScore, boardScore) === 0) return MADE.NONE;
  // 牌型等级没比公共牌高（如公共牌一对、我也只是那一对）=> 只靠踢脚，按未成手。
  if (rank <= boardRank) return MADE.NONE;

  if (rank >= HAND_RANK.FULL_HOUSE) return MADE.MONSTER;
  if (rank >= HAND_RANK.THREE_KIND) return MADE.STRONG;
  if (rank === HAND_RANK.TWO_PAIR) {
    // 公共牌已有一对时，"两对"里只有一对是我的 => 按对子算。
    if (boardRank >= HAND_RANK.ONE_PAIR) return pairClass(heroScore, boardCards, true);
    return MADE.STRONG;
  }
  if (rank === HAND_RANK.ONE_PAIR) return pairClass(heroScore, boardCards, false);
  return MADE.NONE;
}

/** 对子细分：顶对/超对 vs 小对子。boardPaired 时取"我自己那一对"的点数。 */
function pairClass(heroScore, boardCards, boardPaired) {
  const ranks = boardCards.map((c) => c.r);
  const boardCounts = {};
  for (const r of ranks) boardCounts[r] = (boardCounts[r] || 0) + 1;
  // 我的对子点数：普通对子是 heroScore[1]；公共牌成对时，取两对里"不是公共牌那一对"的点数。
  let myPair = heroScore[1];
  if (boardPaired) {
    const pairs = [heroScore[1], heroScore[2]];
    myPair = pairs.find((p) => (boardCounts[p] || 0) < 2) ?? heroScore[2];
  }
  // 顶对比较对象：公共牌里"没成对的最大单张"。
  const singles = ranks.filter((r) => boardCounts[r] === 1);
  const topSingle = singles.length ? Math.max(...singles) : 0;
  return myPair >= topSingle ? MADE.TOP_PAIR : MADE.WEAK_PAIR;
}

/**
 * 判断听牌强弱（detectDraws 返回中文提示串，按关键词判断）：
 *   强听牌 = 同花听牌 / 两头顺；弱听牌 = 卡顺。
 * @param {string[]} draws detectDraws 的结果
 * @returns {string} DRAW 中的一档
 */
export function drawStrength(draws) {
  if (!Array.isArray(draws) || draws.length === 0) return DRAW.NONE;
  const text = draws.join('');
  if (text.includes('同花') || text.includes('两头顺')) return DRAW.STRONG;
  if (text.includes('卡顺')) return DRAW.WEAK;
  return DRAW.NONE;
}
