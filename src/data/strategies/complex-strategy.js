/**
 * 策略层：「档位②·复杂判断」
 * ------------------------------------------------------------
 * 和档位①的关系：档位①只看"胜率 vs 回本线"两件事；档位②在这个基础上，
 *   再叠加多个真实可得的因素，做更细的取舍（但依然是纯函数，好测试、好复用）：
 *     1) 成手牌力分级：强成手才价值加注，中等牌只跟/过，别乱加注送钱。
 *     2) 听牌（隐含赔率）：有强听牌时，即使当前胜率略低于回本线也值得跟。
 *     3) 多人底池：对手越多，想跟注要求的"赢面"越高。
 *     4) 牌面阶段：河牌（公共牌 5 张）不再给听牌加分。
 *     5) 【新】牌面湿/干：牌面越湿（同花/连张/成对），领先时越要下大注保护、
 *        也更不敢用边缘牌跟注；牌面干时下注尺度收小。
 *     6) 【新】群体默认画像：按桌子风格（松/标准/紧）温和偏移——
 *        松桌多价值少诈唬、紧桌敢施压。参数来自 constants 的 OPPONENT_STYLES.decision。
 *     7) 【新】位置：晚位（庄/CO）更激进、早位（枪口/盲注）更收紧。
 *        ⚠️ 只有能从数据里【真实拿到】位置时才生效；拿不到(null)完全退回原逻辑，不编。
 *
 * 返回结构沿用所有策略共享的"合同"：{ action, amount, reason }
 */

import {
  POKER_ACTION,
  POKER_ACTION_NAMES,
  EQUITY,
  AUTOPILOT,
  getOpponentDecisionProfile,
} from '../../common/constants.js';
import { potOdds } from '../equity-engine.js';
import { evaluate, detectDraws, analyzeBoardTexture, HAND_RANK, BOARD_TEXTURE } from '../poker-engine.js';
import { handStrength } from '../hand-range.js';

// ============ 本档位专用阈值（集中成常量，便于调参，和逻辑解耦） ============
// 成手牌力分界：等级 >= 这个值算"强成手"，可以放心价值加注（三条及以上）。
const STRONG_MADE_RANK = HAND_RANK.THREE_KIND; // 3
// 中等成手：两对。够跟注价值，但一般不主动大加注。
const MEDIUM_MADE_RANK = HAND_RANK.TWO_PAIR; // 2

// 免费行动（toCall=0）时的两条下注线：
const FREE_VALUE_RAISE_EQUITY = 68; // 胜率这么高 => 价值下注要钱
const FREE_PROTECT_BET_EQUITY = 55; // 胜率中上 + 怕被反超 => 下注保护，把听牌的人赶走

// 多人底池惩罚：每多 1 个对手，跟注的"回本线"额外抬高这么多点（人越多越保守）。
const MULTIWAY_MARGIN_PER_OPP = 4;

// 隐含赔率额度：有强听牌时，允许当前胜率比回本线低最多这么多点，仍然跟注。
//   （道理：现在差一点，但成牌后能从对手身上赢回更多，长期划算。）
const IMPLIED_ODDS_CREDIT = 8;

// 半诈唬：对手人数 <= 这个数时，拿着强听牌可以主动下注（既可能让对手弃牌，成牌又能赢大池）。
const SEMI_BLUFF_MAX_OPP = 2;

// 两种加注尺度（相对底池的基准比例）：强成手价值注下得更大，半诈唬下得温和些。
//   注意：这是"基准值"，真正下注时还会按牌面湿度在下面的 TEXTURE_SIZE_MULT 上微调。
const RAISE_RATIO_VALUE = 0.66; // 2/3 池：强牌要价
const RAISE_RATIO_SEMIBLUFF = AUTOPILOT.RAISE_POT_RATIO; // 复用全局默认 1/2 池

// 【新】牌面湿度 -> 下注尺度乘数：
//   湿牌面上，领先时要下更大的注"收保护费"（别让一堆听牌的人便宜补牌）；
//   干牌面威胁小，下注尺度收小一点，省着点下。乘到基准比例上。
const TEXTURE_SIZE_MULT = {
  [BOARD_TEXTURE.DRY]: 0.85, // 干面：缩小到 85%
  [BOARD_TEXTURE.MEDIUM]: 1.0, // 中性：不变
  [BOARD_TEXTURE.WET]: 1.25, // 湿面：放大到 125%（收保护费）
};

// 【新】位置 -> 跟注门槛偏移（百分点）：
//   晚位信息多、能占便宜，门槛降低（更舍得跟/更激进）；
//   早位信息少、容易被夹击，门槛抬高（更收紧）。中位/未知为 0（不动）。
const POSITION_MARGIN_SHIFT = {
  late: -2, // 晚位：门槛 -2 点，更激进
  middle: 0, // 中位：不变
  early: 2, // 早位：门槛 +2 点，更收紧
};

// ============ 翻牌前（公共牌 0 张）专用阈值 ============
// 为什么翻牌前要单独一套：翻牌前只有两张牌，蒙特卡洛算出的"摊到底"胜率天然偏低，
//   多人时更低。若还拿它去扛被多人惩罚抬高的门槛，几乎所有牌都会被弃——
//   这正是"开牌前特别爱弃牌、不看看牌费用"的根源。翻牌前应改用：
//     起手牌强度（Chen 分）+ 看牌到底便不便宜（隐含赔率），而不是硬扛摊牌胜率。
//
// Chen 分强度分界（score 越高越强）：
const PRE_STRONG_SCORE = 9; // >=9：强起手（大对子 / AK / AQs 等）—— 该加注要价值
const PRE_PLAYABLE_SCORE = 6; // >=6：可玩牌（如 QTs=8、KJo=7）—— 面对合理下注愿意跟
const PRE_MARGINAL_SCORE = 4; // >=4：边缘牌（如 Q5s=4）—— 只有很便宜才跟，大注照弃

// 【关键】翻牌前用"底池赔率"衡量贵不贵，而不是"要跟的钱÷底池"。
//   底池赔率 = 要跟的钱 /(底池 + 要跟的钱)，把要跟的钱也算进分母。
//   为什么必须这样：翻牌前底池只有大小盲那么点，分母很小，用"要跟的钱÷底池"会虚高
//   （跟一个大盲就显示 40%、67%），把好牌误判成"太贵"而弃——这正是"开局乱弃"的根因。
//   底池赔率不受底池小的影响，跟一个标准大盲通常只有 ~30%，好牌该跟就跟。
//
// 下面三档是"能接受的最大底池赔率（%）"，数字越大越敢跟（越贵也跟）：
const PRE_PLAYABLE_POT_ODDS = 45; // 可玩牌：底池赔率 <=45% 就跟（跟一两个加注都 OK）
const PRE_SPEC_POT_ODDS = 38; // 投机手（小对/同花连张）：靠隐含赔率，<=38% 跟
const PRE_MARGINAL_POT_ODDS = 28; // 边缘牌：只在便宜(<=28%，约等于跟个盲注)时才跟

// “便宜入池”补充规则：解决站点尚未把盲注计入 pot、导致底池赔率虚高的问题。
// 只有费用确实低、并且手牌达到最低质量时才放行，不会让 72o 之类的垃圾牌无脑入池。
const PRE_CHEAP_ENTRY_SCORE = 3; // 最低入池牌力；早位还会自动提高 1 档
const PRE_CHEAP_ENTRY_MAX_BB = 1.05; // 待跟注不超过约 1 个大盲
const PRE_CHEAP_ENTRY_STACK_PCT = 3; // 或者待跟注不超过剩余筹码的 3%

/**
 * 【翻牌前专用决策】只在公共牌 0 张时调用。
 *   核心：用起手牌强度 + 看牌费用（隐含赔率）判断，不碰那个偏低的摊牌胜率。
 * @param {object} ctx 局面 {hole, pot, toCall, opponents, position?}
 * @param {object} profile 群体画像旋钮（callThreshold/valueStretch...）
 * @param {number} positionShift 位置带来的"紧度偏移"（正=更紧，负=更松）
 * @param {number} sizeMult 下注尺度乘数（翻牌前牌面还没出，固定取 1，这里保留参数好统一）
 * @returns {{action, amount, reason}}
 */
function decidePreflop(ctx, profile, positionShift, sizeMult) {
  const pot = Number(ctx.pot) || 0;
  const toCall = Number(ctx.toCall) || 0;
  const stack = Number(ctx.stack);
  const bigBlind = Number(ctx.bigBlind);

  // 起手牌强度（复用 Chen 公式）。拿不到两张牌就保守过牌/弃牌。
  const hs = handStrength(ctx.hole);
  if (!hs.ok) {
    return toCall <= 0
      ? { action: POKER_ACTION.CHECK, amount: 0, reason: '翻牌前底牌数据不足，先过牌。' }
      : { action: POKER_ACTION.FOLD, amount: 0, reason: '翻牌前底牌数据不足，弃牌。' };
  }

  // "投机手"：本身强度不高，但中了就是大牌 —— 小对子、同花连张。便宜就值得看翻牌。
  const isSpeculative = (hs.isPair && hs.highRank <= 9) || (hs.suited && hs.connected);
  // 画像/位置合成的"紧度偏移"：正=更保守，负=更激进。换算成对 Chen 分门槛的微调。
  const tightShift = (profile.callThreshold + positionShift) / 2; // 2 分≈1 档，缩小影响
  const strongGate = PRE_STRONG_SCORE + tightShift;
  const playGate = PRE_PLAYABLE_SCORE + tightShift;

  // ===== 情况 A：没人下注，可免费 / 主动下注 =====
  if (toCall <= 0) {
    // 强起手 => 价值加注，先把底池做大、也筛掉一堆垃圾牌。
    if (hs.score >= strongGate) {
      const amount = raiseAmount(pot, RAISE_RATIO_VALUE, sizeMult * profile.valueStretch);
      return {
        action: POKER_ACTION.RAISE,
        amount,
        reason: `翻牌前强起手（强度 ${hs.score}），加注到约 ${amount} 建立底池。`,
      };
    }
    // 其余（含可玩/投机/垃圾）=> 免费就过牌白看翻牌，不浪费也不乱投。
    return { action: POKER_ACTION.CHECK, amount: 0, reason: `翻牌前可免费看牌（强度 ${hs.score}），过牌看翻牌。` };
  }

  // ===== 情况 B：有人下注，要花 toCall 才能继续 =====
  // 关键：用"底池赔率"衡量贵不贵（要跟的钱 /(底池+要跟的钱)），不受翻牌前底池小的影响。
  //   复用 equity-engine 的 potOdds，拿不到数据时当作很贵（100%）。
  const odds = potOdds(pot, toCall);
  const potOddsPct = odds.ok && odds.breakevenPct != null ? odds.breakevenPct : 100;

  // “便宜”不能只看底池赔率：站点若暂时上报 pot=0，正常跟一个大盲也会被算成 100%。
  // 因此再看两项真实数据：是否只需跟约 1BB、是否只占剩余筹码很小比例。
  const costInBb = Number.isFinite(bigBlind) && bigBlind > 0 ? toCall / bigBlind : null;
  const stackCostPct = Number.isFinite(stack) && stack > 0 ? (toCall / stack) * 100 : null;
  const cheapByBlind = costInBb != null && costInBb <= PRE_CHEAP_ENTRY_MAX_BB;
  const cheapByStack = stackCostPct != null && stackCostPct <= PRE_CHEAP_ENTRY_STACK_PCT;
  const cheapEntry = cheapByBlind || cheapByStack;

  // 早位信息少，最低牌力提高一档；晚位仍保持基础门槛，但不会放行明显垃圾牌。
  const cheapEntryGate = Math.max(
    2,
    PRE_CHEAP_ENTRY_SCORE + Math.max(0, tightShift)
  );
  const cheapEntryEligible =
    hs.score >= cheapEntryGate ||
    hs.isPair ||
    (hs.suited && hs.connected);

  // 强起手 => 直接加注（翻牌前强牌不怕，主动施压拿价值）。
  if (hs.score >= strongGate) {
    const amount = raiseAmount(pot + toCall, RAISE_RATIO_VALUE, sizeMult * profile.valueStretch);
    return {
      action: POKER_ACTION.RAISE,
      amount,
      reason: `翻牌前强起手（强度 ${hs.score}），再加注到约 ${amount} 要价值。`,
    };
  }
  // 可玩牌 => 底池赔率不太差就跟（看一张翻牌再说）。
  if (hs.score >= playGate && potOddsPct <= PRE_PLAYABLE_POT_ODDS) {
    return {
      action: POKER_ACTION.CALL,
      amount: 0,
      reason: `翻牌前可玩牌（强度 ${hs.score}），底池赔率 ${Math.round(potOddsPct)}% 划算，跟注看翻牌。`,
    };
  }
  // 投机手 => 靠隐含赔率，赔率不太差就跟（搏翻牌中大牌）。
  if (isSpeculative && potOddsPct <= PRE_SPEC_POT_ODDS) {
    return {
      action: POKER_ACTION.CALL,
      amount: 0,
      reason: `翻牌前投机手（${hs.isPair ? '小对子' : '同花连张'}），底池赔率 ${Math.round(potOddsPct)}% 可接受，跟注搏翻牌。`,
    };
  }
  // 底池数据暂时不准也没关系：只跟约 1BB / 只占筹码 3%，且手牌不是垃圾牌，就允许看翻牌。
  if (cheapEntry && cheapEntryEligible) {
    const costText = cheapByBlind
      ? `约 ${costInBb.toFixed(1)} 个大盲`
      : `约占筹码 ${stackCostPct.toFixed(1)}%`;
    return {
      action: POKER_ACTION.CALL,
      amount: 0,
      reason: `翻牌前入局费用较低（${costText}），手牌强度 ${hs.score} 可接受，跟注看翻牌。`,
    };
  }
  // 边缘牌 => 只有很便宜（约等于跟个盲注）才跟，大注照弃。
  if (hs.score >= PRE_MARGINAL_SCORE && potOddsPct <= PRE_MARGINAL_POT_ODDS) {
    return {
      action: POKER_ACTION.CALL,
      amount: 0,
      reason: `翻牌前边缘牌（强度 ${hs.score}）但很便宜（底池赔率 ${Math.round(potOddsPct)}%），跟注看翻牌。`,
    };
  }
  // 其余 => 弃牌（牌不够强、底池赔率也不划算，没有搏的理由）。
  return {
    action: POKER_ACTION.FOLD,
    amount: 0,
    reason: `翻牌前牌力一般（强度 ${hs.score}）、底池赔率 ${Math.round(potOddsPct)}% 不划算，弃牌。`,
  };
}

/**
 * 判断听牌强弱：
 *   - 强听牌：听同花、或两头顺（补牌多、成牌概率高）。
 *   - 弱听牌：卡顺（只有 4 张补牌）。
 * detectDraws 返回的是中文提示串（如"听同花（约 9 张补牌）"），这里按关键词判断。
 * @param {string[]} draws detectDraws 的结果
 * @returns {'strong'|'weak'|'none'}
 */
function drawStrength(draws) {
  if (!Array.isArray(draws) || draws.length === 0) return 'none';
  const text = draws.join('');
  if (text.includes('同花') || text.includes('两头顺')) return 'strong';
  if (text.includes('卡顺')) return 'weak';
  return 'none';
}

/** 算一个加注额：底池 * 比例 * 各种乘数，向下取整，至少 1。
 * @param {number} pot   当前底池
 * @param {number} ratio 基准比例（如 0.66）
 * @param {number} [mult=1] 额外乘数（如牌面湿度乘数 × 价值倾向），默认 1
 */
function raiseAmount(pot, ratio, mult = 1) {
  const base = Number(pot) || 0;
  const finalRatio = ratio * (Number(mult) || 1);
  return Math.max(1, Math.floor(base * finalRatio));
}

// ============ 加注额"封顶"（防误全下的策略层保险）============
// 为什么需要：各分支算出的加注额是"底池×比例"，本身到不了全下；但为双保险再加一道硬上限，
//   让【中等及以下的牌绝不打出接近全下的尺度】——这正对应"只有一对却 all in"的担忧。
//   - 能拿到筹码(stack)：按"剩余筹码的百分比"封顶；只有超强成手(葫芦及以上)才放宽。
//   - 拿不到筹码(stack=null)：退回"按底池倍数"封顶，保守兜底，绝不编一个假筹码。
const STACK_CAP_NORMAL = 0.33; // 普通牌：加注额最多押到剩余筹码的 1/3
const STACK_CAP_STRONG = 0.75; // 超强成手：最多 3/4（接近全下这种极端留给人工决定）
const POT_CAP_MULT_NO_STACK = 1.0; // 没有筹码数据时：加注额最多 1 倍底池（保守）
// "超强成手"门槛：葫芦及以上才算（可以打大）；四条/同花顺更不用说。一对/两对/三条都不算。
const SUPER_STRONG_RANK = HAND_RANK.FULL_HOUSE; // 6

/**
 * 给加注额"封顶"：防止中等牌被打成接近全下。纯函数，便于单测。
 * @param {number} amount 原始加注额
 * @param {object} p
 *   @param {number} p.pot 当前底池
 *   @param {number|null} [p.stack] 我的剩余筹码（拿不到为 null/undefined）
 *   @param {number} p.madeRank 当前成手等级（HAND_RANK），决定是否放宽
 * @returns {number} 封顶后的加注额（至少 1）
 */
function capRaiseAmount(amount, { pot, stack, madeRank }) {
  let capped = Math.max(1, Math.floor(Number(amount) || 0));
  const strong = Number(madeRank) >= SUPER_STRONG_RANK; // 葫芦及以上才允许打大

  if (stack != null && Number.isFinite(stack) && stack > 0) {
    // 有真实筹码：按筹码百分比封顶（这是最贴合"别全下"的保险）。
    const stackCap = Math.max(1, Math.floor(stack * (strong ? STACK_CAP_STRONG : STACK_CAP_NORMAL)));
    capped = Math.min(capped, stackCap);
  } else {
    // 没有筹码数据：退回按底池倍数封顶（强牌放宽到 2 倍底池），绝不编筹码。
    const potCap = Math.floor((Number(pot) || 0) * POT_CAP_MULT_NO_STACK * (strong ? 2 : 1));
    if (potCap > 0) capped = Math.min(capped, potCap);
  }
  return capped;
}

/**
 * 【内部】复杂档决策核心：产出 {action, amount, reason}，但加注额【尚未封顶】。
 *   对外请用下面的 decide（它会在唯一出口统一封顶，防误全下）。
 * @param {object} params
 *   @param {object} params.ctx 局面：{hole, board, opponents, pot, toCall, position?, stack?}
 *   @param {object} params.eq  胜率结果：{ok, equity, win, ...}
 *   @param {string} [params.opponentStyle] 对手风格 id（群体默认画像用，缺省=中性）
 * @returns {{action:string, amount:number, reason:string}}
 */
function decideCore({ ctx, eq, opponentStyle }) {
  // 兜底：胜率没算出来就别乱动。
  if (!eq || !eq.ok) {
    return { action: POKER_ACTION.CHECK, amount: 0, reason: '胜率数据不足，暂不主动行动。' };
  }

  const equity = eq.equity; // 综合赢面（百分比）
  const pot = Number(ctx.pot) || 0;
  const toCall = Number(ctx.toCall) || 0;
  const opponents = Number(ctx.opponents) || 1;

  // —— 先把"牌力 / 听牌 / 阶段"这几样算出来（本档的额外信息）——
  const allCards = [...ctx.hole, ...ctx.board];
  const madeRank = evaluate(allCards)[0]; // 当前成手等级（HAND_RANK）
  const canImprove = ctx.board.length < 5; // 河牌后没牌可补，听牌不再有价值
  const draw = canImprove ? drawStrength(detectDraws(allCards)) : 'none';

  const isStrongMade = madeRank >= STRONG_MADE_RANK;
  const isMediumMade = madeRank >= MEDIUM_MADE_RANK;

  // 多人底池惩罚：对手每多一个，想继续就要求更高的赢面。
  const multiwayPenalty = Math.max(0, opponents - 1) * MULTIWAY_MARGIN_PER_OPP;

  // —— 【新 5】牌面湿/干：决定下注尺度 & 要不要更谨慎 ——
  const texture = analyzeBoardTexture(ctx.board);
  const sizeMult = TEXTURE_SIZE_MULT[texture.level] || 1; // 湿面放大、干面缩小下注
  const wet = texture.level === BOARD_TEXTURE.WET;

  // —— 【新 6】群体默认画像：按桌子风格拿到"温和旋钮"（拿不到风格=中性 1/0）——
  const profile = getOpponentDecisionProfile(opponentStyle);

  // —— 【新 7】位置：晚位更激进 / 早位更紧（拿不到位置 position=null，偏移为 0 不动）——
  const positionShift = POSITION_MARGIN_SHIFT[ctx.position] || 0;

  // ========== 翻牌前（公共牌 0 张）：走专用分支 ==========
  // 为什么单拎出来：翻牌前只有两张牌，摊牌胜率天然偏低、还被多人惩罚压得更低，
  //   直接用它判断会"什么牌都想弃、也不看看牌费用"。翻牌前改用"起手强度 + 看牌贵不贵"
  //   来决定（见 decidePreflop）。翻牌后(board>=3)仍走下面成熟的成手/听牌逻辑，不受影响。
  if (ctx.board.length === 0) {
    return decidePreflop(ctx, profile, positionShift, sizeMult);
  }

  // 把"画像门槛偏移 + 位置偏移"合成一个"紧度偏移"：正=更谨慎，负=更激进。
  //   湿牌面再额外加一点谨慎（边缘牌别乱跟）。全部集中算一次，后面复用。
  const tightnessShift = profile.callThreshold + positionShift + (wet ? 1 : 0);

  // 价值下注倾向：松桌(valueStretch>1)把价值注门槛压低一点，更薄地要价值。
  const valueThin = (profile.valueStretch - 1) * 10; // 1.2 => 压低 2 点；0.9 => 抬高 1 点

  // 诈唬倾向：松桌(bluffBias 很小)干脆关掉半诈唬（他们爱跟注，诈唬是送钱）。
  const allowBluff = profile.bluffBias >= 0.75;

  // ========== 情况 A：不用花钱（可免费过牌/下注）==========
  if (toCall <= 0) {
    // A1 强成手、或胜率很高 => 价值下注要钱（门槛随画像/位置/牌面微调）。
    const valueGate = FREE_VALUE_RAISE_EQUITY - valueThin + tightnessShift;
    if (isStrongMade || equity >= valueGate) {
      const amount = raiseAmount(pot, RAISE_RATIO_VALUE, sizeMult * profile.valueStretch);
      return {
        action: POKER_ACTION.RAISE,
        amount,
        reason: `${isStrongMade ? '已成强牌' : `胜率 ${equity}%`}，价值下注到约 ${amount}（${texture.level === BOARD_TEXTURE.WET ? '湿面加大' : texture.level === BOARD_TEXTURE.DRY ? '干面收小' : '标准'}）。`,
      };
    }
    // A2 拿强听牌、人不多、且当前桌子适合诈唬 => 半诈唬下注。
    if (draw === 'strong' && opponents <= SEMI_BLUFF_MAX_OPP && allowBluff) {
      const amount = raiseAmount(pot, RAISE_RATIO_SEMIBLUFF, sizeMult);
      return {
        action: POKER_ACTION.RAISE,
        amount,
        reason: `有强听牌且对手少，半诈唬下注约 ${amount}（成牌赢大池，弃牌也不亏）。`,
      };
    }
    // A3 胜率中上 + 牌面有威胁 => 下注保护，把等着补牌的人赶走（湿面更要下、下更大）。
    const protectGate = FREE_PROTECT_BET_EQUITY + tightnessShift;
    if (equity >= protectGate) {
      const amount = raiseAmount(pot, RAISE_RATIO_SEMIBLUFF, sizeMult);
      return {
        action: POKER_ACTION.RAISE,
        amount,
        reason: `胜率 ${equity}% 领先${wet ? '、牌面偏湿' : ''}，下注约 ${amount} 保护，别让对手免费补牌。`,
      };
    }
    // A4 其余 => 过牌白看一张。
    return {
      action: POKER_ACTION.CHECK,
      amount: 0,
      reason: `可免费过牌、胜率 ${equity}% 还不够强，先过牌白看一张。`,
    };
  }

  // ========== 情况 B：需要跟注 ==========
  const odds = potOdds(pot, toCall);
  const breakeven = odds.ok && odds.breakevenPct != null ? odds.breakevenPct : 50;

  // 实际门槛 = 回本线 + 多人惩罚 + 紧度偏移（画像/位置/湿面一起作用）。
  const effectiveBreakeven = breakeven + multiwayPenalty + tightnessShift;
  const margin = equity - effectiveBreakeven; // 比"实际门槛"高/低多少点

  // 把门槛显示成整数，便于阅读（内部计算仍用精确值）。
  const gateText = Math.round(effectiveBreakeven);

  // B1 强成手 + 明显领先 => 加注扩大收益（尺度随牌面湿度 & 价值倾向调整）。
  if (isStrongMade && margin >= EQUITY.CALL_MARGIN) {
    const amount = raiseAmount(pot, RAISE_RATIO_VALUE, sizeMult * profile.valueStretch);
    return {
      action: POKER_ACTION.RAISE,
      amount,
      reason: `已成强牌且胜率 ${equity}% 高于门槛 ${gateText}%，加注到约 ${amount}。`,
    };
  }

  // B2 够本（含中等成手）=> 跟注。
  if (margin >= 0) {
    return {
      action: POKER_ACTION.CALL,
      amount: 0,
      reason: `胜率 ${equity}% 不低于门槛 ${gateText}%${
        isMediumMade ? '（已有两对以上）' : ''
      }，跟注划算。`,
    };
  }

  // B3 当前略不够本，但有强听牌且还能补牌 => 用"隐含赔率"兜底跟注。
  //    成牌后能从对手身上赢更多，所以可以容忍小幅的负 margin。
  if (draw === 'strong' && canImprove && margin >= -IMPLIED_ODDS_CREDIT) {
    return {
      action: POKER_ACTION.CALL,
      amount: 0,
      reason: `胜率 ${equity}% 暂低于门槛 ${gateText}%，但有强听牌，靠隐含赔率跟注搏成牌。`,
    };
  }

  // B4 其余 => 弃牌（赢面不够、也没有值得搏的听牌）。
  return {
    action: POKER_ACTION.FOLD,
    amount: 0,
    reason: `胜率 ${equity}% 低于门槛 ${gateText}%${
      multiwayPenalty > 0 ? `（${opponents} 人底池已加严）` : ''
    }${ctx.position === 'early' ? '（早位更谨慎）' : ''}，弃牌。`,
  };
}

// 动作名小助手，和档位①保持一致的口径（供上层做日志/展示时统一用）。
export function actionName(action) {
  return POKER_ACTION_NAMES[action] || action;
}

/**
 * 【对外主函数】复杂档决策（唯一出口）。
 *   = 先跑 decideCore 得到决策，再对"加注"动作统一封顶（防中等牌误打成接近全下）。
 *   在这里集中封顶的好处：各分支不用各自记得封顶，逻辑只有一处，好测好调（单一出口原则）。
 * @param {object} params {ctx, eq, opponentStyle}
 *   ctx 可带 stack（我的剩余筹码，防御式；拿不到为 null，封顶自动退回按底池倍数）
 * @returns {{action:string, amount:number, reason:string}}
 */
export function decide({ ctx, eq, opponentStyle }) {
  const result = decideCore({ ctx, eq, opponentStyle });

  // 只有"加注"才需要封顶；其它动作(过牌/跟注/弃牌)金额本就为 0，原样返回。
  if (result.action !== POKER_ACTION.RAISE || !(result.amount > 0)) {
    return result;
  }

  // 当前成手等级：决定封顶松紧（葫芦及以上才放宽，一对/两对/三条都按普通封顶）。
  const madeRank = evaluate([...(ctx.hole || []), ...(ctx.board || [])])[0];
  const capped = capRaiseAmount(result.amount, {
    pot: Number(ctx.pot) || 0,
    stack: ctx.stack, // 可能为 null/undefined，capRaiseAmount 内部会处理
    madeRank,
  });

  // 没被削减就原样返回；被削减了，补一句提示让理由透明（便于你在面板看懂为什么没打那么大）。
  if (capped >= result.amount) return result;
  return {
    ...result,
    amount: capped,
    reason: `${result.reason}（为防过度投入，加注额封顶到约 ${capped}）`,
  };
}
