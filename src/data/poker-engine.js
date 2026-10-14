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

// 牌面湿度分级（干 / 中 / 湿）。导出成枚举常量，策略层直接按它判断，不写字符串字面量。
export const BOARD_TEXTURE = {
  DRY: 'dry', // 干：没花、不连，一对也相对安全
  MEDIUM: 'medium', // 中：有一点威胁
  WET: 'wet', // 湿：同花/顺子/对子威胁大，容易被反超
};

// 牌面危险度"打分权重"与"分级阈值"（集中成常量，便于调参，和判断逻辑解耦）。
//   每一项代表某种威胁贡献多少"危险分"，最后把分数和下面两个阈值比，得出干/中/湿。
const BOARD_TEXTURE_WEIGHTS = {
  // 同花威胁：面上同色张数越多越危险
  FLUSH_THREE: 2, // 3 张同色（同花听面）
  FLUSH_FOUR: 4, // 4 张同色（极易成同花）
  FLUSH_MADE: 5, // 5 张同色（面上已成同花）
  // 顺子威胁：牌面点数越"连"越危险
  STRAIGHT_TWO: 1, // 只两张沾边（弱连）
  STRAIGHT_THREE: 2, // 3 张连张（顺子听牌活跃）
  STRAIGHT_FOUR: 4, // 4 张高度连张（顺子威胁极大）
  // 对子牌面：可能已有三条/葫芦
  PAIRED: 2,
  // 分级阈值：危险分 >= WET_AT 判"湿"；>= MEDIUM_AT 判"中"；否则"干"。
  MEDIUM_AT: 2,
  WET_AT: 4,
};

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

/**
 * 牌面"湿/干"分级（也叫牌面危险度 / board texture）。
 * ------------------------------------------------------------
 * 讲人话：同样是你一对，公共牌"干"（如 K♠7♦2♣，没花、不连）时很安全；
 *   公共牌"湿"（如 K♥Q♥J♥，又同花又连张）时，对手很容易已经成了更大的牌、
 *   或者手握一堆听牌随时反超你。所以"要不要下注保护、下多大"要看牌面湿度。
 *
 * 为什么放在 poker-engine（最底层纯计算）：
 *   它只用公共牌本身做数学判断，不碰胜率、不碰策略，属于"扑克数学"的一部分，
 *   和 evaluate / detectDraws 同层，可被任何上层（策略、面板）复用。
 *
 * 判断的三个来源（都只看公共牌，不看任何人的底牌）：
 *   1) 同花威胁：同一花色在牌面上有几张（3 张=听面活跃，4 张=极危险，5 张=面上已成同花）。
 *   2) 顺子威胁：牌面点数有多"连"（一个 5 点数窗口里挤了几张，越挤越容易凑顺子）。
 *   3) 对子牌面：牌面本身成对时，有人可能已中三条/葫芦。
 *
 * @param {Array<string|{r,s}>} board 已翻开的公共牌（0~5 张）
 * @returns {{
 *   level: 'dry'|'medium'|'wet',  // 湿度分级（供策略直接用）
 *   score: number,                // 内部打的危险分（越大越湿，便于调参/调试）
 *   flushRisk: 'none'|'draw'|'strong'|'made',   // 同花威胁等级
 *   straightRisk: 'none'|'draw'|'strong'|'made',// 顺子威胁等级
 *   paired: boolean,              // 牌面是否成对
 *   reasons: string[]             // 中文解释（可用于界面/日志，透明可核对）
 * }}
 */
export function analyzeBoardTexture(board) {
  const list = (Array.isArray(board) ? board : [])
    .map((c) => (typeof c === 'string' ? parseCard(c) : c))
    .filter(Boolean);

  // 翻牌前 / 牌面不足 3 张：谈不上危险，直接当"干"返回（防御式，避免上层拿到脏值）。
  if (list.length < 3) {
    return {
      level: BOARD_TEXTURE.DRY,
      score: 0,
      flushRisk: 'none',
      straightRisk: 'none',
      paired: false,
      reasons: ['牌面未成形（不足 3 张公共牌）'],
    };
  }

  const reasons = [];

  // —— 1) 同花威胁：数每种花色在牌面上出现几张，取最多的那种 ——
  const suitCount = { s: 0, h: 0, d: 0, c: 0 };
  for (const { s } of list) suitCount[s]++;
  const maxSuit = Math.max(...ALL_SUITS.map((s) => suitCount[s]));

  let flushRisk = 'none';
  let flushScore = 0;
  if (maxSuit >= 5) {
    flushRisk = 'made'; // 面上就有 5 张同花，谁手里有这花色就是同花
    flushScore = BOARD_TEXTURE_WEIGHTS.FLUSH_MADE;
    reasons.push('牌面已有同花（5 张同色）');
  } else if (maxSuit === 4) {
    flushRisk = 'strong'; // 4 张同色，任何人只要有 1 张这花色就成同花，极危险
    flushScore = BOARD_TEXTURE_WEIGHTS.FLUSH_FOUR;
    reasons.push('牌面 4 张同色，极易成同花');
  } else if (maxSuit === 3) {
    flushRisk = 'draw'; // 3 张同色，有同花听牌/两张同色即成同花
    flushScore = BOARD_TEXTURE_WEIGHTS.FLUSH_THREE;
    reasons.push('牌面 3 张同色，同花威胁活跃');
  }

  // —— 2) 顺子威胁：看牌面点数有多"连" ——
  //   做法：把点数去重（A 既算 14 也算 1，兼顾 A-2-3-4-5），
  //   找"任意连续 5 个点数的窗口里，最多塞进了几张牌面点数"。塞得越多越容易凑顺子。
  const rankSet = new Set(list.map((c) => c.r));
  if (rankSet.has(14)) rankSet.add(1); // A 当小牌用
  const ranks = [...rankSet];

  let maxInWindow = 0; // 最密的 5 点数窗口里有几张不同点数
  for (let start = 1; start <= 10; start++) {
    const end = start + 4;
    const cnt = ranks.filter((r) => r >= start && r <= end).length;
    if (cnt > maxInWindow) maxInWindow = cnt;
  }
  // 另外单独判断"是否存在两张点数靠得很近（差 <=2，即连张或隔一张）"，用于弱连面
  let twoConnected = false;
  for (let i = 0; i < ranks.length; i++) {
    for (let j = i + 1; j < ranks.length; j++) {
      if (Math.abs(ranks[i] - ranks[j]) <= 2) twoConnected = true;
    }
  }

  let straightRisk = 'none';
  let straightScore = 0;
  if (maxInWindow >= 4) {
    straightRisk = 'made'; // 牌面 4 张落在一个顺子窗口，极易有人已成顺或大听牌
    straightScore = BOARD_TEXTURE_WEIGHTS.STRAIGHT_FOUR;
    reasons.push('牌面高度连张，顺子威胁极大');
  } else if (maxInWindow === 3) {
    straightRisk = 'strong'; // 3 张连张面，顺子听牌很多
    straightScore = BOARD_TEXTURE_WEIGHTS.STRAIGHT_THREE;
    reasons.push('牌面连张，顺子听牌活跃');
  } else if (twoConnected) {
    straightRisk = 'draw'; // 只有两张沾边，威胁较弱
    straightScore = BOARD_TEXTURE_WEIGHTS.STRAIGHT_TWO;
    reasons.push('牌面略带连张');
  }

  // —— 3) 对子牌面：面上成对，可能有人已中三条/葫芦 ——
  const rankCount = {};
  for (const { r } of list) rankCount[r] = (rankCount[r] || 0) + 1;
  const paired = Object.values(rankCount).some((n) => n >= 2);
  const pairScore = paired ? BOARD_TEXTURE_WEIGHTS.PAIRED : 0;
  if (paired) reasons.push('牌面成对，可能有三条/葫芦');

  // —— 汇总打分 -> 分级 ——
  const score = flushScore + straightScore + pairScore;
  let level = BOARD_TEXTURE.DRY;
  if (score >= BOARD_TEXTURE_WEIGHTS.WET_AT) level = BOARD_TEXTURE.WET;
  else if (score >= BOARD_TEXTURE_WEIGHTS.MEDIUM_AT) level = BOARD_TEXTURE.MEDIUM;

  if (reasons.length === 0) reasons.push('牌面干燥，威胁较小');

  return { level, score, flushRisk, straightRisk, paired, reasons };
}
