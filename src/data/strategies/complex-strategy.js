/**
 * 策略层：「档位②·复杂判断」（推荐档）
 * ------------------------------------------------------------
 * 讲人话，这一档的大脑分两段：
 *
 * 【翻牌前】只看起手牌强度（Chen 分）+ 位置 + 前面有没有人加注：
 *   - 没人加注：按位置开池（晚位放宽、早位收紧；前面弃牌的人越多越敢偷盲）。
 *   - 有人加注：顶级牌 3-bet，好牌在赔率合适时跟注，小对子/同花连张只在"便宜且筹码深"时投机。
 *   - 有人 3-bet：只有 QQ+/AK 再加注，其余好牌赔率合适才跟。
 *
 * 【翻牌后】核心是"胜率 vs 回本线"，再叠加：
 *   1) 成手分级：区分"我自己的牌"和"公共牌自带的牌"（公共牌两对时我没加成，不能当两对打）。
 *   2) 听牌：强听牌可半诈唬、可靠隐含赔率跟注。
 *   3) 牌面湿/干：湿面下大注收保护费，干面下小注。
 *   4) 单挑时适度下小注试探（c-bet/探池），河牌用顶对做薄价值。
 *   5) 对手风格（松/紧）、位置、整体打法（稳健/均衡/激进）做温和偏移。
 *   ⚠️ 胜率在进来之前已经按"对手的下注/加注"估算过对手的牌（见 opponent-range.js）：
 *      翻牌后按"对手这手牌在牌面上中了什么、会不会这样下注"加权，面对大注/加注不会高估自己。
 *
 * 输出合同：{ action, reason, sizing? }
 *   - 加注时不直接给金额，而是给"意图" sizing（如 半池 / 按大盲开池），
 *     由 decision-engine 统一交给 bet-sizing.js 换算成正确的"加注至"金额（并处理封顶、全下、合法范围）。
 *   - 纯函数（随机数可注入 rng），便于测试。
 */

import {
  POKER_ACTION,
  POKER_ACTION_NAMES,
  SIZING,
  getOpponentDecisionProfile,
  getAggressionProfile,
  getValueBetProfile,
  getPreflopEntryProfile,
  BOARD_DANGER,
  EXPLOIT,
  BARREL,
} from '../../common/constants.js';
import { potOdds } from '../equity-engine.js';
import { detectDraws, analyzeBoardTexture, BOARD_TEXTURE } from '../poker-engine.js';
import { handStrength } from '../hand-range.js';
// 成手分级 / 听牌强弱：和"对手范围估算"共用同一套规则（见 hand-class.js），保证口径一致。
import { MADE, MADE_LABEL, DRAW, classifyMade, drawStrength } from '../hand-class.js';
import { SIZE_STRENGTH, pickBluffRatioByEV } from '../bet-sizing.js';

// ======================= 翻牌前参数 =======================
// 开池门槛（Chen 分 ≥ 这个值才主动开池加注）。分越高牌越好：AA=20、KK=16、AKs=12、TT=10、99=9、88=8、66=6。
const OPEN_GATE = { early: 9, middle: 8, late: 6 };
const OPEN_GATE_UNKNOWN = 8; // 拿不到位置时按中位处理
// "前面弃牌的人越多越敢开池"：满桌按 5 个对手算，每少 1 个对手，开池门槛降低 0.5 分。
const FULL_TABLE_OPPONENTS = 5;
const OPEN_GATE_STEP_PER_FOLD = 0.5;
const OPEN_GATE_FLOOR = 4; // 再怎么放宽，也不低于 4 分（不拿 72o 这种垃圾偷盲）

const PRE_MONSTER_SCORE = 14; // QQ+：超强起手（下注尺度按"超强牌"）
const PRE_STRONG_SCORE = 10; // TT+/AK/AQs/AJs/KQs：强起手（可 3-bet 拿价值）
const PRE_CALL_RAISE_SCORE = 7; // 面对一次加注：晚位 ≥7 分可跟，其它位置 ≥8 分
const PRE_CALL_3BET_SCORE = 10; // 面对 3-bet：≥10 分才考虑跟
const PRE_MARGINAL_SCORE = 4; // 边缘牌：底池赔率很好时可以跟的最低牌力

// 能接受的"底池赔率"上限（%）= 要跟的钱 ÷ (底池 + 要跟的钱)。越大越敢跟。
//   参考：跟一个标准 3 倍加注，底池赔率约 40%。
const PRE_CALL_POT_ODDS = 45; // 好牌跟加注
const PRE_SPEC_POT_ODDS = 45; // 投机手（筹码够深时，靠中大牌后的隐含赔率）
const PRE_MARGINAL_POT_ODDS = 28; // 边缘牌只在很便宜时跟
// 翻牌前"对手数"包含还没行动的人，所以从第 3 个对手起才收紧，每多 1 个下调 3 点。
const PRE_MULTIWAY_FREE_OPPONENTS = 2;
const PRE_MULTIWAY_ODDS_SHRINK = 3;

// 投机手"挖暗三"规则：跟注额 ≤ 剩余筹码的这个比例，中了才赚得回来（隐含赔率）。
const SET_MINE_STACK_RATIO = 0.1; // 面对普通加注
const SET_MINE_STACK_RATIO_3BET = 0.06; // 面对 3-bet
// 最高注 ≤ 约 1 个大盲：说明还没人加注（只有盲注或平跟），按"没人加注"处理。
const UNOPENED_MAX_BET_BB = 1.05;
// "便宜看翻牌"的费用门槛、牌力门槛由面板的「入池意愿」决定（见 constants.js 的 PREFLOP_ENTRY_PROFILES）。

// ======================= 翻牌后参数 =======================
// "平均份额" = 100 ÷ (对手数 + 1)。单挑 50%、三人 33%。下面的"优势"都是在平均份额之上加多少点。
const VALUE_EDGE = 15; // 价值下注：胜率高出平均份额 15 点（单挑 ≥65%）
const STRONG_BET_EDGE = 3; // 强成手：只要胜率高出平均份额 3 点就下注（别慢打让对手免费补牌）
const THIN_VALUE_EDGE = 8; // 河牌薄价值：顶对以上、胜率高出 8 点（单挑 ≥58%）
const PROTECT_EDGE = 7; // 湿面保护注：胜率高出 7 点
const PROBE_MIN_EQUITY = 42; // 单挑试探注：胜率至少 42%
const PROBE_FREQUENCY = 0.6; // 试探注只在 60% 的时候打（混一点频率，不让对手轻易看穿）
const RAISE_EDGE = 12; // 面对下注时加注：胜率比回本线高出 12 点
const MULTIWAY_CALL_PENALTY = 2; // 多人底池：每多 1 个对手，跟注门槛 +2 点（反向隐含赔率）
const IMPLIED_ODDS_CREDIT = 8; // 强听牌：胜率可比门槛低 8 点仍跟（成牌后能多赢回来）
const IMPLIED_MAX_STACK_RATIO = 0.25; // 但跟注额不能超过剩余筹码 1/4（筹码浅时没有隐含赔率）
const SEMI_BLUFF_MAX_OPP = 2; // 半诈唬只对 ≤2 个对手

// 下注占底池的比例（再乘牌面湿度等）：
const RATIO = {
  MONSTER: 0.75,
  STRONG: 0.66,
  THIN: 0.5,
  RIVER_MONSTER: 0.85,
  RIVER_STRONG: 0.7,
  RIVER_THIN: 0.45,
  PROTECT: 0.5,
  SEMI_BLUFF: 0.72, // 半诈唬：约 2/3 池起步，才有"吓退"的压迫力（原 0.55 太小，对手花小钱就能跟）
  PROBE: 0.5, // 单挑试探/持续下注：半池（原 0.33 太小，没中的牌也懒得弃）
  RAISE_STRONG: 0.6, // 面对下注加注：加注至 = 最高注 + 0.6 ×(跟注后底池)，约 3 倍对手下注
  RAISE_MONSTER: 0.7,
};

// 牌面湿度 -> 下注尺度乘数：湿面放大（收保护费），干面缩小（省着下）。
const TEXTURE_SIZE_MULT = {
  [BOARD_TEXTURE.DRY]: 0.85,
  [BOARD_TEXTURE.MEDIUM]: 1.0,
  [BOARD_TEXTURE.WET]: 1.25,
};

// 位置 -> 翻牌后门槛偏移（百分点）：晚位更敢跟、早位更收紧。拿不到位置不偏移。
const POSITION_MARGIN_SHIFT = { late: -2, middle: 0, early: 2 };

// ======================= 小工具 =======================
/** 动作结果的快捷构造，统一字段，减少各分支手写对象。 */
function act(action, reason, sizing) {
  return sizing ? { action, reason, sizing } : { action, reason };
}

/**
 * 诈唬性下注结果：在 act 基础上打一个 bluff:true 标记。
 *   作用：让后台(service-worker)在这次动作真正点下去后，把本手的"连续开枪数"加一，
 *   下次决策时据此执行「诈唬纪律」(见 bluffDisciplineOk)。价值下注不走这里、不会被计数。
 */
function actBluff(action, reason, sizing) {
  return { ...act(action, reason, sizing), bluff: true };
}

/**
 * 「诈唬纪律」闸门：决定这一次"主动诈唬性下注"是否放行。
 *   移植自线上 AI 的优点——它连续开枪(barrel)基本都有牌力支撑，河牌极少空枪硬吹。
 *   这里把这条纪律落到我方：少打那种"第一枪没中就硬吹第二三枪"被反加血亏的空气牌。
 * @param {object} plan 本手诈唬计划 {barrels,...}；barrels=本手已开过的诈唬枪数
 * @param {object} p
 *   @param {boolean} p.isRiver    是否河牌
 *   @param {boolean} p.hasSupport 手里有没有"支撑"(任意听牌或任意成手；纯空气=无)
 * @returns {{ok:boolean, note:string}} ok=放行诈唬；note=被拦原因(写进过牌理由便于复盘)
 */
function bluffDisciplineOk(plan, { isRiver, hasSupport }) {
  const barrels = Math.max(0, Number(plan && plan.barrels) || 0);
  // ① 开枪已达上限：收枪，不再空枪硬吹。
  if (barrels >= BARREL.MAX_BARRELS) {
    return { ok: false, note: `本手诈唬已连开 ${barrels} 枪达上限` };
  }
  // ② 第二枪起必须有支撑(听牌/成手)；纯空气不许续攻。
  if (barrels >= 1 && !hasSupport) {
    return { ok: false, note: '续攻无听牌/成手支撑' };
  }
  // ③ 河牌诈唬必须有支撑(落实"河牌极少空枪"这条纪律)。
  if (isRiver && BARREL.RIVER_NEEDS_SUPPORT && !hasSupport) {
    return { ok: false, note: '河牌无成手支撑' };
  }
  return { ok: true, note: '' };
}

/** 拿到底池赔率百分比（拿不到数据当作很贵 100%）。 */
function potOddsPct(pot, toCall) {
  const odds = potOdds(pot, toCall);
  return odds.ok && odds.breakevenPct != null ? odds.breakevenPct : 100;
}

/** 成手档 -> 下注尺度档（决定封顶与能否全下）。 */
function sizeStrengthOf(made) {
  if (made === MADE.MONSTER) return SIZE_STRENGTH.MONSTER;
  if (made === MADE.STRONG) return SIZE_STRENGTH.STRONG;
  return SIZE_STRENGTH.NORMAL;
}

/**
 * 「危险牌面」给非强牌加的跟注门槛（百分点）。
 *   讲人话：转牌/河牌出现已成同花、已成顺、公共牌成对时，对手下注多半已握大牌组。
 *   自己只有顶对及以下的非强牌，就该更谨慎——按威胁强度累加惩罚，但封顶，避免矫枉过正。
 *   强牌（三条/顺子/同花以上）不走这里（调用处已排除）。
 * @param {object} texture analyzeBoardTexture 的结果
 * @param {number} street  已翻公共牌张数（4=转牌、5=河牌）
 * @returns {{penalty:number, note:string}}
 */
function dangerPenalty(texture, street) {
  // 翻牌（3 张）还早、牌面没定型，不加严。
  if (!texture || street < BOARD_DANGER.MIN_STREET) return { penalty: 0, note: '' };

  let penalty = 0;
  const hits = [];
  // 同花：已成(made) / 4 张同色(strong) 才算危险；3 张同色只是听牌，不加。
  const flush = BOARD_DANGER.FLUSH[texture.flushRisk];
  if (flush) { penalty += flush; hits.push('同花'); }
  // 顺子：4 连(made) / 3 连(strong) 才算危险；略带连张不加。
  const straight = BOARD_DANGER.STRAIGHT[texture.straightRisk];
  if (straight) { penalty += straight; hits.push('顺子'); }
  // 公共牌成对：可能有人中三条/葫芦。
  if (texture.paired) { penalty += BOARD_DANGER.PAIRED; hits.push('公对'); }

  penalty = Math.min(penalty, BOARD_DANGER.MAX_PENALTY); // 叠加封顶，别把能跟的牌也全吓弃
  const note = penalty > 0 ? `危险牌面(${hits.join('/')})门槛+${penalty}` : '';
  return { penalty, note };
}

// ======================= 翻牌前 =======================
/**
 * 「便宜看翻牌」判断：看翻牌的费用很小时，牌差一点也值得花钱看一张（中了能赢回很多）。
 *   费用门槛、牌力门槛都来自面板的「入池意愿」配置（PREFLOP_ENTRY_PROFILES）。
 * @param {object} p
 *   @param {number}  p.toCall   要跟的钱
 *   @param {number}  p.bigBlind 大盲（拿不到传 NaN）
 *   @param {number}  p.stack    剩余筹码（拿不到传 NaN）
 *   @param {number}  p.score    起手牌强度（Chen 分）
 *   @param {boolean} p.isSpeculative 是否投机手（口袋对子/同花连张/同花A），这类牌不受牌力门槛限制
 *   @param {number}  p.shift    对手风格 + 打法倾向合成的紧度偏移
 *   @param {object}  p.entry    入池意愿配置 {cheapMaxBb, cheapMinScore, cheapMaxStackPct, fallbackStackPct}
 * @returns {{ok:boolean, cost:string}} ok=值得便宜看；cost=费用说明（如"2 个大盲"，拿不到数据为空串）
 */
function cheapSeeFlop({ toCall, bigBlind, stack, score, isSpeculative, shift, entry }) {
  const hasBb = Number.isFinite(bigBlind) && bigBlind > 0;
  const hasStack = Number.isFinite(stack) && stack > 0;
  const stackPct = hasStack ? (toCall / stack) * 100 : null;

  // 1) 费用够不够小：优先按"几个大盲"判断，同时不能占剩余筹码太多；拿不到大盲时只看筹码比例。
  //    cost 是中性的费用描述（"2 个大盲" / "筹码的 2%"），拿不到数据时为空串，方便拼进跟注/弃牌理由。
  let cheap;
  let cost;
  if (hasBb) {
    const costBb = toCall / bigBlind;
    cheap = costBb <= entry.cheapMaxBb && (stackPct == null || stackPct <= entry.cheapMaxStackPct);
    cost = `${+costBb.toFixed(1)} 个大盲`;
  } else {
    cheap = stackPct != null && stackPct <= entry.fallbackStackPct;
    cost = stackPct != null ? `筹码的 ${+stackPct.toFixed(1)}%` : '';
  }

  // 2) 牌够不够格：投机手直接够格，其余看牌力是否达到门槛（紧度偏移会微调门槛）。
  const handOk = isSpeculative || score >= entry.cheapMinScore + shift;
  return { ok: cheap && handOk, cost };
}

/**
 * 翻牌前决策。
 * @param {object} ctx 局面
 * @param {object} knobs {profile, aggression, valueBet, entry}
 */
function decidePreflop(ctx, knobs) {
  const { profile, aggression, entry, entryLabel } = knobs;
  const pot = Number(ctx.pot) || 0;
  const toCall = Number(ctx.toCall) || 0;
  const stack = Number(ctx.stack);
  const hasStack = Number.isFinite(stack) && stack > 0;
  const bigBlind = Number(ctx.bigBlind);
  const hasBb = Number.isFinite(bigBlind) && bigBlind > 0;
  const maxBet = Math.max(Number(ctx.maxBet) || 0, (Number(ctx.heroBet) || 0) + toCall);
  const opponents = Math.max(1, Number(ctx.opponents) || 1);

  const hs = handStrength(ctx.hole);
  if (!hs.ok) {
    return toCall <= 0
      ? act(POKER_ACTION.CHECK, '翻牌前底牌数据不足，先过牌。')
      : act(POKER_ACTION.FOLD, '翻牌前底牌数据不足，弃牌。');
  }

  const score = hs.score;
  // 对手风格 + 整体打法 合成的"紧度"（正=更紧）。减半使用，避免翻牌前范围被调得太离谱。
  const shift = (profile.callThreshold + aggression.thresholdShift) / 2;
  const isAK = hs.highRank === 14 && hs.lowRank === 13;
  const isSpeculative = hs.isPair || (hs.suited && hs.connected) || (hs.suited && hs.highRank === 14);
  const sizeStrength =
    score >= PRE_MONSTER_SCORE ? SIZE_STRENGTH.MONSTER
      : score >= PRE_STRONG_SCORE ? SIZE_STRENGTH.STRONG
        : SIZE_STRENGTH.NORMAL;
  const preflopSizing = { kind: 'preflop', strength: sizeStrength };

  // 开池门槛：按位置 + 已弃牌人数（对手越少越敢开）+ 紧度偏移。
  const posGate = OPEN_GATE[ctx.position] ?? OPEN_GATE_UNKNOWN;
  const foldedBonus = Math.max(0, FULL_TABLE_OPPONENTS - opponents) * OPEN_GATE_STEP_PER_FOLD;
  const openGate = Math.max(OPEN_GATE_FLOOR, posGate - foldedBonus + shift);

  // 可接受的底池赔率上限：随打法倾向调整，人多时收紧（最低 10%）。
  const shrink = Math.max(0, opponents - PRE_MULTIWAY_FREE_OPPONENTS) * PRE_MULTIWAY_ODDS_SHRINK;
  const oddsCap = (base) => Math.max(10, base + aggression.preflopOddsShift - shrink);
  const oddsPct = potOddsPct(pot, toCall);
  const oddsText = `底池赔率 ${Math.round(oddsPct)}%`;

  // 判断"面对什么"：没人加注 / 一次加注 / 3-bet 以上。
  //   拿不到大盲时无法区分，按"一次加注"保守处理。
  let facing = 'unopened';
  if (toCall > 0) {
    if (!hasBb) facing = 'raise';
    else if (maxBet >= bigBlind * SIZING.FOURBET_TRIGGER_BB) facing = 'threebet';
    else if (maxBet > bigBlind * UNOPENED_MAX_BET_BB) facing = 'raise';
  }

  // 「便宜看翻牌」：没人加注、或面对一次小加注时都适用（面对 3-bet 不适用，对手范围太强）。
  const cheap = cheapSeeFlop({ toCall, bigBlind, stack, score, isSpeculative, shift, entry });
  const costNote = cheap.cost ? `，要跟 ${cheap.cost}` : ''; // 弃牌理由里顺带说明费用（放进"强度"那个括号里）
  const cheapReason = () =>
    `翻牌前看翻牌只要 ${cheap.cost}（入池意愿：${entryLabel}），强度 ${score} 的牌便宜看一张，跟注。`;

  // —— 情况 1：没人加注（可免费过牌，或只需补到大盲）——
  if (facing === 'unopened') {
    if (score >= openGate + (toCall <= 0 ? 1 : 0)) {
      // 大盲位别人都只平跟时，要求再高 1 分才加注（位置差，被动一点）。
      return act(
        POKER_ACTION.RAISE,
        `翻牌前没人加注，起手牌强度 ${score} 达到开池线 ${openGate.toFixed(1)}，主动加注`,
        preflopSizing
      );
    }
    if (toCall <= 0) {
      return act(POKER_ACTION.CHECK, `翻牌前可免费看牌（强度 ${score}），过牌看翻牌。`);
    }
    // 只需补一点（小盲补大盲 / 跟平跟者）：费用够小、牌够格就便宜看翻牌。
    if (cheap.ok) return act(POKER_ACTION.CALL, cheapReason());
    if (score >= PRE_MARGINAL_SCORE && oddsPct <= oddsCap(PRE_MARGINAL_POT_ODDS)) {
      return act(POKER_ACTION.CALL, `翻牌前边缘牌（强度 ${score}）但${oddsText}很便宜，跟注。`);
    }
    return act(POKER_ACTION.FOLD, `翻牌前牌力太弱（强度 ${score}${costNote}），按当前入池意愿不值得看，弃牌。`);
  }

  // —— 情况 2：面对一次加注 ——
  if (facing === 'raise') {
    if (score >= PRE_STRONG_SCORE + shift || isAK) {
      return act(POKER_ACTION.RAISE, `翻牌前面对加注，强起手（强度 ${score}）再加注（3-bet）拿价值`, preflopSizing);
    }
    const callGate = PRE_CALL_RAISE_SCORE + (ctx.position === 'late' ? 0 : 1) + shift;
    if (score >= callGate && oddsPct <= oddsCap(PRE_CALL_POT_ODDS)) {
      return act(POKER_ACTION.CALL, `翻牌前面对加注，好牌（强度 ${score}）且${oddsText}可接受，跟注看翻牌。`);
    }
    // 投机手：中了暗三/同花/顺子能赢一大笔，所以关键看"筹码够不够深"（跟注额 ≤ 剩余筹码 10%）；
    //   拿不到筹码数据时，退回只看底池赔率（要求更便宜一些）。
    const setMineOk = hasStack
      ? toCall <= stack * SET_MINE_STACK_RATIO
      : oddsPct <= oddsCap(PRE_MARGINAL_POT_ODDS) + 5;
    if (isSpeculative && setMineOk && oddsPct <= oddsCap(PRE_SPEC_POT_ODDS)) {
      return act(
        POKER_ACTION.CALL,
        `翻牌前投机手（${hs.isPair ? '小对子' : '同花连张/同花A'}），筹码够深、${oddsText}，跟注博大牌。`
      );
    }
    // 对手只是小加注（比如最小加注）、看翻牌费用很小：按入池意愿便宜看一张。
    if (cheap.ok) return act(POKER_ACTION.CALL, cheapReason());
    return act(POKER_ACTION.FOLD, `翻牌前面对加注（强度 ${score}${costNote}），牌力不够、跟注不划算，弃牌。`);
  }

  // —— 情况 3：面对 3-bet 及以上 ——
  if (score >= PRE_MONSTER_SCORE || isAK) {
    return act(POKER_ACTION.RAISE, `翻牌前面对再加注，顶级起手（强度 ${score}）继续加注`, {
      kind: 'preflop',
      strength: SIZE_STRENGTH.MONSTER,
    });
  }
  if (score >= PRE_CALL_3BET_SCORE + shift && oddsPct <= oddsCap(PRE_CALL_POT_ODDS)) {
    return act(POKER_ACTION.CALL, `翻牌前面对再加注，强牌（强度 ${score}）${oddsText}可接受，跟注。`);
  }
  if (hs.isPair && hasStack && toCall <= stack * SET_MINE_STACK_RATIO_3BET) {
    return act(POKER_ACTION.CALL, '翻牌前面对再加注，口袋对子筹码够深，便宜跟注博暗三条。');
  }
  return act(POKER_ACTION.FOLD, `翻牌前面对再加注，强度 ${score} 打不过对手的强范围，弃牌。`);
}

// ======================= 翻牌后 =======================
function decidePostflop(ctx, eq, knobs, rng) {
  const { profile, aggression, valueBet, exploitMode, plan } = knobs;
  const equity = eq.equity;
  const pot = Number(ctx.pot) || 0;
  const toCall = Number(ctx.toCall) || 0;
  const stack = Number(ctx.stack);
  const hasStack = Number.isFinite(stack) && stack > 0;
  const opponents = Math.max(1, Number(ctx.opponents) || 1);
  const street = ctx.board.length; // 3=翻牌 4=转牌 5=河牌
  const isRiver = street >= 5;

  const made = classifyMade(ctx.hole, ctx.board);
  const draw = isRiver ? DRAW.NONE : drawStrength(detectDraws([...ctx.hole, ...ctx.board]));
  const texture = analyzeBoardTexture(ctx.board);
  const wet = texture.level === BOARD_TEXTURE.WET;
  const textureMult = TEXTURE_SIZE_MULT[texture.level] || 1;
  const textureText = wet ? '湿牌面放大尺度' : texture.level === BOARD_TEXTURE.DRY ? '干牌面收小尺度' : '';

  const fairShare = 100 / (opponents + 1);
  const positionShift = POSITION_MARGIN_SHIFT[ctx.position] || 0;
  // 紧度偏移（正=更谨慎）：对手风格 + 位置 + 湿面 + 打法倾向。
  const tightness = profile.callThreshold + positionShift + (wet ? 1 : 0) + aggression.thresholdShift;
  // 松桌(valueStretch>1)更薄地要价值；紧桌反之。
  const valueThin = (profile.valueStretch - 1) * 10;
  const allowBluff = profile.bluffBias >= 0.75 && aggression.allowSemiBluff;
  // 诈唬放大系数：由「打法倾向」决定（均衡 ×1.0、激进 ×1.25）。只放大诈唬/试探注，不碰价值下注。
  const bluffMult = Number(aggression.bluffSizeMult) || 1;
  const isStrongMade = made === MADE.MONSTER || made === MADE.STRONG;
  const madeText = MADE_LABEL[made];

  // 诈唬「支撑」：手里有任意成手(哪怕小对子)或任意听牌，就算有支撑；纯空气牌=无支撑。
  //   「诈唬纪律」据此判断第二枪/河牌诈唬能不能续攻（见 bluffDisciplineOk）。
  const hasSupport = made !== MADE.NONE || draw !== DRAW.NONE;

  // 诈唬/试探注的"尺度"：先用期望值(EV)在几个候选里挑一个"够大到能吓退对手"的比例，
  //   再乘牌面湿度(extraMult)与打法倾向(bluffMult)微调。放在这里统一出口，A4 半诈唬 / A6 试探注共用。
  //   fold 率近似用对手"诈唬敏感度"bluffBias：对手越爱弃牌，就越敢、越该下大注偷池。
  //   剥削模式下：线上 AI 示弱时极易被偷，所以把它的弃牌率再放大一档（等效敢下更大的注）。
  const exploitBluffBias = exploitMode ? profile.bluffBias * EXPLOIT.BLUFF_BIAS_BOOST : profile.bluffBias;
  const bluffRatio = (extraMult = 1) => {
    const pick = pickBluffRatioByEV({
      pot: Number(ctx.pot) || 0,
      heroBet: Number(ctx.heroBet) || 0,
      maxBet: Math.max(Number(ctx.maxBet) || 0, Number(ctx.heroBet) || 0),
      toCall: 0, // A 分支是"无人下注"场景，不用跟注
      bluffBias: exploitBluffBias,
    });
    return pick.ratio * extraMult * bluffMult;
  };

  // 价值下注的尺度：超强/强牌乘"大牌下注"倍数与松桌倍数，河牌用河牌比例。
  const valueSizing = () => {
    const strength = sizeStrengthOf(made);
    const base =
      made === MADE.MONSTER ? (isRiver ? RATIO.RIVER_MONSTER : RATIO.MONSTER)
        : made === MADE.STRONG ? (isRiver ? RATIO.RIVER_STRONG : RATIO.STRONG)
          : (isRiver ? RATIO.RIVER_THIN : RATIO.THIN);
    const bigMult = isStrongMade ? valueBet.sizeMultiplier : 1;
    return { kind: 'pot', ratio: base * textureMult * profile.valueStretch * bigMult, strength };
  };

  // ========== A：没人下注（可以免费过牌）==========
  if (toCall <= 0) {
    // A1 强成手：胜率只要不明显落后就下注（别慢打，让对手为听牌付钱）。
    if (isStrongMade && equity >= fairShare + STRONG_BET_EDGE) {
      return act(POKER_ACTION.RAISE, `${madeText}、胜率 ${equity}%，价值下注${textureText ? `（${textureText}）` : ''}`, valueSizing());
    }
    // A2 胜率明显领先（如顶对好踢脚）：价值下注。
    const valueGate = fairShare + VALUE_EDGE - valueThin + tightness + aggression.valueGateShift;
    if (equity >= valueGate && made !== MADE.NONE) {
      return act(POKER_ACTION.RAISE, `${madeText}、胜率 ${equity}% 高于价值线 ${Math.round(valueGate)}%，下注要价值`, valueSizing());
    }
    // A3 河牌薄价值：顶对以上、人少、胜率中上 => 小注要一点钱（对手常用更差的牌跟）。
    const thinGate = fairShare + THIN_VALUE_EDGE - valueThin + tightness + aggression.valueGateShift;
    if (isRiver && opponents <= 2 && (made === MADE.TOP_PAIR || isStrongMade) && equity >= thinGate) {
      return act(POKER_ACTION.RAISE, `河牌${madeText}、胜率 ${equity}%，小注薄价值`, {
        kind: 'pot', ratio: RATIO.RIVER_THIN, strength: SIZE_STRENGTH.NORMAL,
      });
    }
    // A4 强听牌半诈唬：对手少、桌风允许诈唬、还有牌可补。下得够大才能逼对手弃牌。
    //   尺度交给 EV 择优（bluffRatio）：对手越爱弃牌越敢打大注，湿面再放大一点收压迫力。
    //   ⚠️ 先过「诈唬纪律」：开枪数达上限时收枪改过牌（别空枪硬吹被反加）。强听牌本身就是支撑。
    if (draw === DRAW.STRONG && opponents <= SEMI_BLUFF_MAX_OPP && allowBluff) {
      const gate = bluffDisciplineOk(plan, { isRiver, hasSupport });
      if (gate.ok) {
        return actBluff(POKER_ACTION.RAISE, `强听牌半诈唬（对手弃牌就赢、成牌赢大池）`, {
          kind: 'pot', ratio: bluffRatio(textureMult), strength: SIZE_STRENGTH.NORMAL,
        });
      }
      return act(POKER_ACTION.CHECK, `有强听牌但诈唬纪律限制（${gate.note}），改过牌看牌。`);
    }
    // A5 湿面保护：胜率中上、还有牌要发 => 下注别让对手免费补牌。
    if (!isRiver && wet && made !== MADE.NONE && equity >= fairShare + PROTECT_EDGE + tightness) {
      return act(POKER_ACTION.RAISE, `胜率 ${equity}% 领先但牌面湿，下注保护`, {
        kind: 'pot', ratio: RATIO.PROTECT * textureMult, strength: SIZE_STRENGTH.NORMAL,
      });
    }
    // A6 单挑试探注（相当于持续下注/探池）：干/中性牌面、胜率不差，下够大才逼得走没中的牌。
    //   尺度同样用 EV 择优，确保"够大到能吓退"，而不是写死一个小比例。
    //   剥削模式下：线上 AI 单挑示弱很好偷，所以提高试探注频率(常规 0.6 → 0.85)。
    const probeFreq = exploitMode ? EXPLOIT.PROBE_FREQUENCY : PROBE_FREQUENCY;
    if (!isRiver && opponents === 1 && allowBluff && !wet && equity >= PROBE_MIN_EQUITY && rng() < probeFreq) {
      // ⚠️ 试探注也是主动诈唬，先过「诈唬纪律」：连开枪达上限或续攻无支撑时收枪改过牌。
      const gate = bluffDisciplineOk(plan, { isRiver, hasSupport });
      if (gate.ok) {
        return actBluff(POKER_ACTION.RAISE, `单挑、牌面不湿、胜率 ${equity}%，下注试探（对手没中多半会弃）`, {
          kind: 'pot', ratio: bluffRatio(), strength: SIZE_STRENGTH.NORMAL,
        });
      }
      return act(POKER_ACTION.CHECK, `本可试探注但诈唬纪律限制（${gate.note}），改过牌看牌。`);
    }
    return act(POKER_ACTION.CHECK, `可免费过牌，胜率 ${equity}%（${madeText}）不够下注，过牌。`);
  }

  // ========== B：面对下注 ==========
  const breakeven = potOddsPct(pot, toCall);
  const multiway = Math.max(0, opponents - 1) * MULTIWAY_CALL_PENALTY;
  // 危险牌面（成同花/成顺/公对）：只对"非强牌"加跟注门槛，强牌不受影响、照常跟/加。
  const danger = isStrongMade ? { penalty: 0, note: '' } : dangerPenalty(texture, street);
  // 剥削模式：线上 AI 的下注在"多人池"和"河牌"上几乎都是真牌（它极少在这两种场合诈唬）。
  //   所以非强牌面对它的下注要更尊重——额外抬高跟注门槛，少被它的价值注骗着追。强牌不受影响。
  let exploitPenalty = 0;
  const exploitHits = [];
  if (exploitMode && !isStrongMade) {
    if (opponents >= 2) { exploitPenalty += EXPLOIT.MULTIWAY_BET_PENALTY; exploitHits.push('多人池'); }
    if (isRiver) { exploitPenalty += EXPLOIT.BARREL_RIVER_PENALTY; exploitHits.push('河牌'); }
  }
  const exploitText = exploitHits.length ? `，剥削(${exploitHits.join('/')})门槛+${exploitPenalty}` : '';
  const required = breakeven + multiway + tightness + danger.penalty + exploitPenalty;
  const reqText = Math.round(required);
  const dangerText = (danger.note ? `，${danger.note}` : '') + exploitText;

  // B1 强成手 + 胜率远超回本线 => 加注（价值加注 / 过牌加注）。
  if (isStrongMade && equity >= breakeven + RAISE_EDGE && equity >= fairShare + VALUE_EDGE) {
    return act(POKER_ACTION.RAISE, `${madeText}、胜率 ${equity}% 远高于回本线 ${Math.round(breakeven)}%，加注`, {
      kind: 'pot',
      ratio: (made === MADE.MONSTER ? RATIO.RAISE_MONSTER : RATIO.RAISE_STRONG) * valueBet.sizeMultiplier,
      strength: sizeStrengthOf(made),
    });
  }
  // B2 胜率够本 => 跟注。
  if (equity >= required) {
    return act(POKER_ACTION.CALL, `胜率 ${equity}% ≥ 门槛 ${reqText}%（${madeText}${dangerText}），跟注划算。`);
  }
  // B3 强听牌 + 筹码够深 => 靠隐含赔率跟注。
  //   剥削模式：它下注=价值，追牌成了也赢不回那么多（没什么隐含赔率），所以让分打折。
  const impliedOk = !hasStack || toCall <= stack * IMPLIED_MAX_STACK_RATIO;
  const impliedCredit = exploitMode ? IMPLIED_ODDS_CREDIT * EXPLOIT.IMPLIED_CREDIT_MULT : IMPLIED_ODDS_CREDIT;
  if (draw === DRAW.STRONG && impliedOk && equity >= required - impliedCredit) {
    return act(POKER_ACTION.CALL, `胜率 ${equity}% 略低于门槛 ${reqText}%，但有强听牌、筹码够深，跟注博成牌。`);
  }
  // B4 其余 => 弃牌。
  return act(
    POKER_ACTION.FOLD,
    `胜率 ${equity}% 低于门槛 ${reqText}%（${madeText}${opponents > 1 ? `、${opponents} 人池` : ''}${dangerText}），弃牌。`
  );
}

// ======================= 对外 =======================
// 动作名小助手（供日志/展示统一口径）。
export function actionName(action) {
  return POKER_ACTION_NAMES[action] || action;
}

/**
 * 【对外主函数】复杂档决策。
 * @param {object} params
 *   @param {object} params.ctx 局面
 *   @param {object} params.eq  胜率结果 {ok, equity,...}
 *   @param {string} [params.opponentStyle]     对手风格 id
 *   @param {string} [params.aggressionProfile] 整体打法 id
 *   @param {string} [params.valueBetProfile]   大牌下注 id
 *   @param {string} [params.preflopEntryProfile] 翻牌前入池意愿 id
 *   @param {Function} [params.rng]             随机数函数（测试可注入固定值）
 * @returns {{action:string, reason:string, sizing?:object}}
 */
export function decide({
  ctx,
  eq,
  opponentStyle,
  aggressionProfile,
  valueBetProfile,
  preflopEntryProfile,
  exploitMode = false,
  plan = null,
  rng = Math.random,
}) {
  const entryConf = getPreflopEntryProfile(preflopEntryProfile);
  const knobs = {
    profile: getOpponentDecisionProfile(opponentStyle),
    aggression: getAggressionProfile(aggressionProfile).decision,
    valueBet: getValueBetProfile(valueBetProfile).decision,
    entry: entryConf.decision, // 翻牌前「便宜看翻牌」的门槛
    entryLabel: entryConf.label, // 写进决策理由，让你知道是哪个设置起的作用
    exploitMode: Boolean(exploitMode), // 剥削模式：针对线上 AI 弱点的专项调整（只翻牌后用到）
    plan: plan || {}, // 本手诈唬计划(连续开枪数等)，由后台跨 tick 维护，用于「诈唬纪律」
  };
  const board = Array.isArray(ctx.board) ? ctx.board : [];

  // 翻牌前不看蒙特卡洛胜率（两张牌时天然偏低），走起手牌 + 位置的专用逻辑。
  if (board.length === 0) return decidePreflop(ctx, knobs);

  if (!eq || !eq.ok) {
    return (Number(ctx.toCall) || 0) > 0
      ? act(POKER_ACTION.FOLD, '胜率数据不足，面对下注先弃牌。')
      : act(POKER_ACTION.CHECK, '胜率数据不足，先过牌。');
  }
  return decidePostflop({ ...ctx, board }, eq, knobs, typeof rng === 'function' ? rng : Math.random);
}
