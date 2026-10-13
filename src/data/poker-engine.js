/**
 * 数据层：德州扑克「算法引擎」（纯计算，无网络、无界面）
 * ------------------------------------------------------------
 * 职责（单一）：只做扑克牌的数学，方便单独复用和测试。
 *   1) parseCard   —— 把 "As" / "10h" 这种字符串变成程序好算的 {点数, 花色}。
 *   2) buildDeck   —— 造一副完整的 52 张牌。
 *   3) evaluate    —— 从 5~7 张牌里，挑出"最好的 5 张"，给这手牌打一个可比较的分数。
 *   4) compareHands—— 比较两手牌谁大。
 *   5) handName    —— 把分数翻译成人话（"葫芦""同花"……）。
 *   6) detectDraws —— 识别"听牌"（还差一张就成同花/顺子）。
 *
 * 核心概念：怎么给一手牌"打分"？
 *   我们把每手牌压成一个数组： [牌型等级, 关键点数1, 关键点数2, ...]
 *   - 第 0 位是"牌型等级"（见下方 HAND_RANK，数字越大牌型越好）。
 *   - 后面几位是"同牌型时比大小的关键点数"（比如一对 K，就先比 K，再比剩下的单张）。
 *   这样两手牌比大小，就变成"两个数组逐位比大小"，既简单又不会出错。
 */

// 点数字母 -> 数字大小（方便比较）。A 最大(14)，2 最小。
const RANK_VALUE = {
  2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9,
  T: 10, J: 11, Q: 12, K: 13, A: 14,
};

// 牌型等级：数字越大越好。evaluate 返回的分数数组第 0 位就是它。
// （注意：皇家同花顺其实是"最大的同花顺"，这里不单列等级，
//   统一算作 STRAIGHT_FLUSH，到 handName 里再判断是不是皇家。）
export const HAND_RANK = {
  STRAIGHT_FLUSH: 8, // 同花顺
  FOUR_KIND: 7, // 四条
  FULL_HOUSE: 6, // 葫芦（三条+一对）
  FLUSH: 5, // 同花
  STRAIGHT: 4, // 顺子
  THREE_KIND: 3, // 三条
  TWO_PAIR: 2, // 两对
  ONE_PAIR: 1, // 一对
  HIGH_CARD: 0, // 高牌
};

const ALL_SUITS = ['s', 'h', 'd', 'c']; // 黑桃 红心 方块 梅花

/**
 * 把一张牌字符串解析成 { r:点数数字, s:花色字母 }，解析不了返回 null。
 * 兼容大小写、"10" 和 "T" 两种十的写法。
 * @param {string} str 例 "As" "Kd" "10h" "Tc"
 */
export function parseCard(str) {
  if (typeof str !== 'string') return null;
  const text = str.trim();
  // 点数部分可能是 "10" 或单个字符；花色是最后一个字符
  const suit = text.slice(-1).toLowerCase();
  if (!ALL_SUITS.includes(suit)) return null;

  let rankPart = text.slice(0, -1).toUpperCase();
  if (rankPart === '10') rankPart = 'T'; // 统一成 T 好查表
  const r = RANK_VALUE[rankPart];
  if (!r) return null;

  return { r, s: suit };
}

/** 把 {r,s} 还原成标准字符串，如 {r:14,s:'s'} -> "As"（T 显示成 T）。 */
export function cardToString(card) {
  const rankChar = Object.keys(RANK_VALUE).find((k) => RANK_VALUE[k] === card.r);
  return `${rankChar}${card.s}`;
}

/**
 * 造一副完整的 52 张牌（返回 {r,s} 对象数组）。
 * 蒙特卡洛模拟时，会从这副牌里去掉"已知的牌"，剩下的用来随机发。
 */
export function buildDeck() {
  const deck = [];
  for (const s of ALL_SUITS) {
    for (let r = 2; r <= 14; r++) {
      deck.push({ r, s });
    }
  }
  return deck;
}

/**
 * 在"一组点数集合"里找最长的顺子，返回顺子的最大点数；找不到返回 0。
 * - 自动处理 A 既能当最大(14)又能当最小(1) 的情况（A-2-3-4-5 这种"轮子顺"）。
 * @param {Set<number>} rankSet 出现过的点数集合，如 {14,13,12,11,10}
 */
function findStraightHigh(rankSet) {
  // A 当 1 用：如果有 A(14)，就临时也认为有个 1，方便判断 A-2-3-4-5
  const set = new Set(rankSet);
  if (set.has(14)) set.add(1);

  // 从大到小找：谁能当"顺子里最大那张"。最小的顺子是 5-4-3-2-A(high=5)
  for (let high = 14; high >= 5; high--) {
    if (set.has(high) && set.has(high - 1) && set.has(high - 2) && set.has(high - 3) && set.has(high - 4)) {
      return high;
    }
  }
  return 0;
}

/**
 * 【核心】给 5~7 张牌打分，返回可比较的分数数组 [等级, 关键点数...]。
 * 内部会自动"从 7 张里挑最好的 5 张"——因为我们是按整体的对子/顺子/同花来判断的。
 * @param {Array<string|{r,s}>} cards 牌数组，元素可以是 "As" 字符串或 {r,s} 对象
 * @returns {number[]} 分数数组；牌不够(少于1张)返回 [0]
 */
export function evaluate(cards) {
  // 统一转成 {r,s}，过滤掉无法识别的
  const list = cards
    .map((c) => (typeof c === 'string' ? parseCard(c) : c))
    .filter(Boolean);
  if (list.length === 0) return [HAND_RANK.HIGH_CARD];

  // 统计每个点数出现几次、每个花色出现几次
  const rankCount = {}; // 点数 -> 次数
  const suitCards = { s: [], h: [], d: [], c: [] }; // 花色 -> 该花色的点数列表
  for (const { r, s } of list) {
    rankCount[r] = (rankCount[r] || 0) + 1;
    suitCards[s].push(r);
  }

  // 所有出现过的点数，从大到小排好（比大小时常用）
  const ranksDesc = Object.keys(rankCount).map(Number).sort((a, b) => b - a);

  // 按"出现次数"分组：几条、几对分别有哪些点数（每组内从大到小）
  const quads = ranksDesc.filter((r) => rankCount[r] === 4); // 四条
  const trips = ranksDesc.filter((r) => rankCount[r] === 3); // 三条
  const pairs = ranksDesc.filter((r) => rankCount[r] === 2); // 对子

  // —— 找同花：哪个花色有 >=5 张 ——
  let flushSuit = null;
  for (const s of ALL_SUITS) {
    if (suitCards[s].length >= 5) flushSuit = s;
  }

  // —— 1) 同花顺：先看同花那组花色里能不能连成顺子 ——
  if (flushSuit) {
    const flushHigh = findStraightHigh(new Set(suitCards[flushSuit]));
    if (flushHigh) return [HAND_RANK.STRAIGHT_FLUSH, flushHigh];
  }

  // —— 2) 四条：四条点数 + 1 张最大的踢脚 ——
  if (quads.length) {
    const quad = quads[0];
    const kicker = ranksDesc.find((r) => r !== quad) || 0;
    return [HAND_RANK.FOUR_KIND, quad, kicker];
  }

  // —— 3) 葫芦：一个三条 + 一个对子（两个三条时，大的当三条、小的当对子）——
  if (trips.length >= 1 && (pairs.length >= 1 || trips.length >= 2)) {
    const tripRank = trips[0];
    // 对子来源：真正的对子里最大的，或"第二个三条"（取其一的较大值）
    const pairCandidate = Math.max(pairs[0] || 0, trips[1] || 0);
    return [HAND_RANK.FULL_HOUSE, tripRank, pairCandidate];
  }

  // —— 4) 同花：取该花色里最大的 5 张点数 ——
  if (flushSuit) {
    const top5 = suitCards[flushSuit].slice().sort((a, b) => b - a).slice(0, 5);
    return [HAND_RANK.FLUSH, ...top5];
  }

  // —— 5) 顺子 ——
  const straightHigh = findStraightHigh(new Set(ranksDesc));
  if (straightHigh) return [HAND_RANK.STRAIGHT, straightHigh];

  // —— 6) 三条：三条点数 + 2 张最大的踢脚 ——
  if (trips.length) {
    const trip = trips[0];
    const kickers = ranksDesc.filter((r) => r !== trip).slice(0, 2);
    return [HAND_RANK.THREE_KIND, trip, ...kickers];
  }

  // —— 7) 两对：两个最大的对子 + 1 张最大的踢脚 ——
  if (pairs.length >= 2) {
    const [p1, p2] = pairs;
    const kicker = ranksDesc.find((r) => r !== p1 && r !== p2) || 0;
    return [HAND_RANK.TWO_PAIR, p1, p2, kicker];
  }

  // —— 8) 一对：对子点数 + 3 张最大的踢脚 ——
  if (pairs.length === 1) {
    const p = pairs[0];
    const kickers = ranksDesc.filter((r) => r !== p).slice(0, 3);
    return [HAND_RANK.ONE_PAIR, p, ...kickers];
  }

  // —— 9) 高牌：最大的 5 张 ——
  return [HAND_RANK.HIGH_CARD, ...ranksDesc.slice(0, 5)];
}

/**
 * 比较两手牌的分数数组：a 比 b 大返回正数、小返回负数、一样大返回 0。
 * 逐位比较（第一位是牌型等级，往后是关键点数），和"比字典序"同理。
 */
export function compareHands(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * 把分数数组翻译成牌型中文名。
 * @param {number[]} score evaluate 的返回值
 * @param {object} names   HAND_CATEGORY_NAMES（由调用方传入，保持常量集中）
 */
export function handName(score, names) {
  const category = score[0];
  // 同花顺里，如果最大牌是 A(14)，那就是皇家同花顺
  if (category === HAND_RANK.STRAIGHT_FLUSH && score[1] === 14) {
    return names[9]; // 皇家同花顺
  }
  return names[category] ?? '未知';
}

/**
 * 识别"听牌"：手里还没成同花/顺子，但再来一张合适的就能成。
 * 只在翻牌/转牌阶段（公共牌 3~4 张、还有后续牌可发）才有意义。
 * @param {Array<string|{r,s}>} known 已知的全部牌（你的底牌 + 已翻公共牌）
 * @returns {string[]} 人话提示数组，如 ["听同花（差 1 张）", "两头顺听牌（约 8 张补牌）"]
 */
export function detectDraws(known) {
  const list = known
    .map((c) => (typeof c === 'string' ? parseCard(c) : c))
    .filter(Boolean);
  const hints = [];

  // 如果已经成了同花或顺子，就不叫"听牌"了，直接返回空
  const made = evaluate(list)[0];
  if (made >= HAND_RANK.STRAIGHT) return hints;

  // —— 同花听牌：某个花色正好有 4 张（再来 1 张同花色就成同花）——
  const suitCount = { s: 0, h: 0, d: 0, c: 0 };
  for (const { s } of list) suitCount[s]++;
  if (ALL_SUITS.some((s) => suitCount[s] === 4)) {
    hints.push('听同花（差 1 张，约 9 张补牌）');
  }

  // —— 顺子听牌：数一数"再补哪一个点数能凑成顺子"，有几个这样的点数 ——
  // 已有点数集合
  const have = new Set(list.map((c) => c.r));
  const completing = new Set(); // 能补成顺子的点数集合
  for (let v = 2; v <= 14; v++) {
    if (have.has(v)) continue; // 已经有了就不算"补"
    const test = new Set(have);
    test.add(v);
    if (findStraightHigh(test)) completing.add(v);
  }
  if (completing.size >= 2) {
    hints.push('两头顺听牌（约 8 张补牌）');
  } else if (completing.size === 1) {
    hints.push('卡顺听牌（约 4 张补牌）');
  }

  return hints;
}
