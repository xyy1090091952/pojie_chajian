/**
 * 数据层：起手牌「牌组范围」计算（纯算法，无网络、无界面）
 * ------------------------------------------------------------
 * 为什么需要它：
 *   原来的胜率模拟假设对手"随便两张牌"（完全随机），但现实里对手——尤其是
 *   还没弃牌、还在跟注的人——手里通常是比随机更强的牌。假设对手拿随机牌，
 *   会【高估】你的胜率。
 *
 * 这个模块干的事（讲人话）：
 *   1) 给德州 169 种起手牌型（如 AA、AKs、72o）每种打一个"强度分"。
 *   2) 从强到弱排好队。
 *   3) 给定一个百分比（如"前 50%"），算出"属于这个范围的牌型集合"。
 *   蒙特卡洛模拟时，就只给对手发"落在这个范围里"的牌，更贴近真实。
 *
 * 强度分用的是经典的「Chen 公式」——德州里广泛使用的起手牌评分法，
 *   简单、够用，也方便解释。
 */

// 一副牌一共有 C(52,2) = 1326 种两张牌的组合。按"前百分之几"选牌组时用它做分母。
const TOTAL_COMBOS = 1326;

// 查找上限：范围很窄 + 剩牌受限时，随机试很多次也凑不出合规的牌，
//   超过这个次数就兜底随便发，避免卡死。
export const RANGE_MAX_TRIES = 200;

/**
 * Chen 公式：给一种起手牌打强度分（分越高越强）。
 * @param {number} high 较大点数（2~14，A=14）
 * @param {number} low  较小点数
 * @param {boolean} suited 是否同花色
 */
function chenScore(high, low, suited) {
  // 1) 基础分看最大的那张牌：A=10、K=8、Q=7、J=6；其余按"点数的一半"
  const baseMap = { 14: 10, 13: 8, 12: 7, 11: 6 };
  let score = baseMap[high] ?? high / 2;

  // 2) 对子：基础分翻倍，且最低记 5 分（比如一对 2 记 5 分）
  if (high === low) {
    return Math.round(Math.max(score * 2, 5));
  }

  // 3) 同花加 2 分
  if (suited) score += 2;

  // 4) 两张牌之间的"空档"越大越难连成顺子，扣分
  const gap = high - low - 1;
  if (gap === 1) score -= 1;
  else if (gap === 2) score -= 2;
  else if (gap === 3) score -= 4;
  else if (gap >= 4) score -= 5;

  // 5) 连张/小空档且两张都比 Q 小 => 有顺子潜力，加 1 分
  if (gap <= 1 && high <= 11) score += 1;

  return Math.round(score);
}

// 把一种牌型编码成唯一字符串（key），方便放进集合里查。
//   对子：          "P14"（一对 A）
//   非对子+同花：    "14-13-s"（AKs）
//   非对子+不同花：  "14-13-o"（AKo）
function classKey(high, low, pair, suited) {
  if (pair) return `P${high}`;
  return `${high}-${low}-${suited ? 's' : 'o'}`;
}

/**
 * 构建"全部 169 种起手牌型"，带强度分和组合数权重，并按强度从高到低排序。
 *   权重 = 这种牌型实际有多少种具体组合：
 *     对子 6 种、同花非对子 4 种、不同花非对子 12 种。
 * 只在模块加载时算一次（169 种，很快），结果缓存复用。
 */
function buildRankedClasses() {
  const list = [];
  for (let high = 14; high >= 2; high--) {
    for (let low = high; low >= 2; low--) {
      if (low === high) {
        // 对子
        list.push({ key: classKey(high, low, true, false), weight: 6, score: chenScore(high, low, false) });
      } else {
        // 同花
        list.push({ key: classKey(high, low, false, true), weight: 4, score: chenScore(high, low, true) });
        // 不同花
        list.push({ key: classKey(high, low, false, false), weight: 12, score: chenScore(high, low, false) });
      }
    }
  }
  // 从强到弱排序
  list.sort((a, b) => b.score - a.score);
  return list;
}

// 排好序的牌型表（模块级缓存，只算一次）
const RANKED_CLASSES = buildRankedClasses();

// 不同百分比对应的"允许牌型集合"缓存，避免重复计算（key=百分比）
const allowedSetCache = new Map();

/**
 * 给定百分比，返回"落在前 X% 的牌型 key 集合"。
 *   - 返回 null 表示 100%（任意牌 = 随机），模拟时可跳过过滤、直接发牌（更快）。
 * @param {number} percent 1~100
 * @returns {Set<string>|null}
 */
export function getAllowedClassSet(percent) {
  const p = Number(percent) || 100;
  if (p >= 100) return null; // 随机：不限制

  if (allowedSetCache.has(p)) return allowedSetCache.get(p);

  const limit = (TOTAL_COMBOS * p) / 100; // 允许的组合总数上限
  const set = new Set();
  let cumulative = 0;
  for (const c of RANKED_CLASSES) {
    if (cumulative >= limit) break; // 够了就停
    set.add(c.key);
    cumulative += c.weight;
  }
  allowedSetCache.set(p, set);
  return set;
}

/**
 * 把两张具体的牌（{r,s}）归到它所属的牌型 key，用于判断是否落在允许范围内。
 * @param {{r:number,s:string}} a
 * @param {{r:number,s:string}} b
 */
export function comboClassKey(a, b) {
  const high = Math.max(a.r, b.r);
  const low = Math.min(a.r, b.r);
  if (high === low) return `P${high}`;
  const suited = a.s === b.s;
  return `${high}-${low}-${suited ? 's' : 'o'}`;
}
