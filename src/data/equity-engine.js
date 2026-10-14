/**
 * 数据层：「胜率引擎」（蒙特卡洛模拟 + 底池赔率 + 跟/弃建议）
 * ------------------------------------------------------------
 * 职责（单一）：用合法可见的数据，算出"赢面有多大、该不该跟注"。
 *   依赖下层的 poker-engine.js（只管比牌型大小），自己专注做概率/决策。
 *
 * 它只用到这些你本来就看得见的信息：
 *   - 你自己的两张底牌
 *   - 已经翻开的公共牌
 *   - 还有几个对手没弃牌
 *   - 底池大小、你要跟多少注（用于算赔率）
 * 完全不碰任何对手的隐藏牌，等价于 PokerStove / Equilab 这类公开胜率计算器。
 *
 * 蒙特卡洛是什么（讲人话）：
 *   既然不知道对手拿什么、后面还会翻什么公共牌，那就"假装发很多次牌"：
 *   每一次都从剩余牌里随机给每个对手发两张、把公共牌补齐到 5 张，
 *   然后比大小看你赢没赢。发个 1 万次，数一数赢的比例，就是你的胜率。
 */

import { buildDeck, evaluate, compareHands, detectDraws, parseCard } from './poker-engine.js';
import { EQUITY } from '../common/constants.js';
import { getAllowedClassSet, comboClassKey, RANGE_MAX_TRIES } from './hand-range.js';

// 按权重抽对手牌时（大注下空气牌权重很低，收牌率低），多给几倍的尝试次数，保证几乎都能抽到合规的牌。
const WEIGHTED_TRIES_MULT = 3;

/**
 * 从一副完整牌里，去掉"已知的牌"，返回剩余可用的牌。
 * @param {Array<{r,s}>} knownCards 已知牌（你的底牌 + 已翻公共牌）
 * @returns {Array<{r,s}>} 剩余牌堆
 */
function buildRemainingDeck(knownCards) {
  // 把已知牌做成一个"指纹集合"，方便快速判断某张牌是不是已经用掉了
  const used = new Set(knownCards.map((c) => `${c.r}${c.s}`));
  return buildDeck().filter((c) => !used.has(`${c.r}${c.s}`));
}

/**
 * Fisher–Yates 洗牌：把数组原地打乱，保证每种顺序概率相等（公平随机）。
 * 蒙特卡洛每一轮都要"重新随机发牌"，靠的就是先洗牌再按顺序取。
 */
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]]; // 交换 i 和 j
  }
  return arr;
}

/**
 * 从"剩余牌池"里给一个对手发两张牌（会把发出去的牌从池里移除，避免重复用）。
 * 这是"对手牌组范围"的落地点：
 *   - allowedSet 和 weigher 都没有（风格=随机、没人下注）时：直接从已洗好的牌池顶部拿两张，最快。
 *   - allowedSet 有值时：只接受"组合牌型落在允许范围里"的两张牌（如只发前 25% 的强牌）。
 *   - weigher 有值时（翻牌后面对下注）：再按"这手牌会这样下注的可能性"(0~1) 抽签决定收不收，
 *     例如权重 0.1 的空气牌，10 次里只收 1 次 —— 这样发出来的对手牌就"像个会下注的人"。
 *   随机试，最多 maxTries 次；实在凑不出时，用试过的牌里"权重最高"的那手兜底（宁可把对手想强，不想弱）。
 * @param {Array<{r,s}>} pool  剩余可发的牌（会被原地修改：移除已发的牌）
 * @param {Set<string>|null} allowedSet  允许的牌型集合，null = 不限制
 * @param {Function|null} [weigher]  手牌权重函数 (a,b)=>0~1，null = 不加权
 * @returns {Array<{r,s}>} 两张牌
 */
function dealOpponentHand(pool, allowedSet, weigher = null) {
  // 不限制范围也不加权：牌池本就洗过，直接取顶部两张即可
  if (!allowedSet && !weigher) {
    return [pool.pop(), pool.pop()];
  }

  const maxTries = weigher ? RANGE_MAX_TRIES * WEIGHTED_TRIES_MULT : RANGE_MAX_TRIES;
  let backup = null; // 兜底候选：{i, j, w}，记下试过的"合规且权重最高"的那手
  for (let t = 0; t < maxTries; t++) {
    const i = Math.floor(Math.random() * pool.length);
    let j = Math.floor(Math.random() * pool.length);
    while (j === i) j = Math.floor(Math.random() * pool.length); // 两张不能是同一张

    const a = pool[i];
    const b = pool[j];
    if (allowedSet && !allowedSet.has(comboClassKey(a, b))) continue; // 起手牌不在范围里，换一手
    const w = weigher ? weigher(a, b) : 1;
    if (!backup || w > backup.w) backup = { i, j, w };
    // 按权重抽签：权重 1 一定收，权重 0.1 只有 10% 的机会收
    if (w >= 1 || Math.random() < w) return takePair(pool, i, j);
  }

  // 兜底：用试过的牌里权重最高的那手；一手合规的都没试到（极少发生），就随便发两张
  if (backup) return takePair(pool, backup.i, backup.j);
  return [pool.pop(), pool.pop()];
}

/** 把牌池里下标 i、j 的两张牌取出来（先删大下标，避免删完位置错乱）。 */
function takePair(pool, i, j) {
  const a = pool[i];
  const b = pool[j];
  pool.splice(Math.max(i, j), 1);
  pool.splice(Math.min(i, j), 1);
  return [a, b];
}

/**
 * 【核心】蒙特卡洛模拟你的胜率。
 * @param {object} input
 *   @param {Array<string|{r,s}>} input.hole       你的底牌（通常 2 张）
 *   @param {Array<string|{r,s}>} input.board       已翻开的公共牌（0/3/4/5 张）
 *   @param {number}               input.opponents  还没弃牌的对手数
 *   @param {number}               [input.opponentPercent] 对手牌组范围：只玩"最强前百分之几"的牌。
 *                                   100（或不传）= 随机任意牌（最乐观）；越小 = 对手越强、你胜率越低越真实。
 *   @param {{bettor:Function, others:Function}} [input.weighers] 可选：翻牌后面对下注时的"手牌权重函数"
 *                                   （见 opponent-range.js）。第 1 个对手当作下注者用 bettor，其余对手用 others。
 *   @param {number}               [input.simulations] 模拟次数（默认取常量）
 * @returns {{win:number, tie:number, lose:number, equity:number, samples:number, ok:boolean, reason?:string}}
 *   win/tie/lose 是百分比；equity 是"综合赢面"（平局按人数均分彩池）。
 */
export function simulateEquity(input) {
  const simulations = input.simulations || EQUITY.SIMULATIONS;

  // 对手牌组范围：把"百分比"换成"允许的牌型集合"。null 表示随机（不过滤）。
  const allowedSet = getAllowedClassSet(input.opponentPercent);
  // 翻牌后面对下注时的"手牌权重函数"（没有就不加权，等同老逻辑）。
  const weighers =
    input.weighers && typeof input.weighers.bettor === 'function' && typeof input.weighers.others === 'function'
      ? input.weighers
      : null;

  // 1) 把输入统一成 {r,s}，并做基本校验
  const hole = (input.hole || []).map((c) => (typeof c === 'string' ? parseCard(c) : c)).filter(Boolean);
  const board = (input.board || []).map((c) => (typeof c === 'string' ? parseCard(c) : c)).filter(Boolean);
  const opponents = Number(input.opponents) || 0;

  // 数据不足时直接返回"算不了"，由界面提示——保证不乱给结果（数据一致性）
  if (hole.length < 2) {
    return emptyResult('还没拿到你的两张底牌');
  }
  if (opponents < 1) {
    return emptyResult('没有存活的对手，无需计算');
  }
  if (opponents > EQUITY.MAX_OPPONENTS) {
    return emptyResult('对手人数异常');
  }

  // 2) 准备剩余牌堆，并检查牌够不够发
  const known = [...hole, ...board];
  const remaining = buildRemainingDeck(known);
  const boardNeed = 5 - board.length; // 还要补几张公共牌
  const need = opponents * 2 + boardNeed; // 这一轮一共要发多少张
  if (need > remaining.length) {
    return emptyResult('剩余牌不足以模拟（数据可能异常）');
  }

  // 3) 开始模拟
  let win = 0;
  let tie = 0;
  let lose = 0;

  for (let n = 0; n < simulations; n++) {
    // 每轮都复制一份"剩余牌"并洗乱。注意：下面给对手发牌会从这份牌池里取走牌，
    //   所以用一个会被修改的副本 pool，公共牌则从剩下的里补。
    const pool = shuffleInPlace(remaining.slice());

    // 先给每个对手发 2 张（按牌组范围过滤 + 按下注可能性加权，发出去的牌会从 pool 里移除）
    const oppScores = [];
    for (let o = 0; o < opponents; o++) {
      const weigher = weighers ? (o === 0 ? weighers.bettor : weighers.others) : null;
      const oppHole = dealOpponentHand(pool, allowedSet, weigher);
      oppScores.push([...oppHole]); // 先存底牌，等公共牌补齐后再打分
    }

    // 再从 pool 剩下的牌里补齐公共牌到 5 张（本轮大家共用）
    const fullBoard = board.slice();
    for (let i = 0; i < boardNeed; i++) fullBoard.push(pool.pop());

    // 我的最终 7 张（底牌 + 公共牌）打分
    const myScore = evaluate([...hole, ...fullBoard]);

    // 对手各自和公共牌凑 7 张打分，取"相对我最强"的那个对手
    let bestOppCmp = -1; // >0 对手赢，=0 平，<0 我赢
    for (const oppHole of oppScores) {
      const oppScore = evaluate([...oppHole, ...fullBoard]);
      const cmp = compareHands(oppScore, myScore);
      if (cmp > bestOppCmp) bestOppCmp = cmp;
    }

    // 和"最强的那个对手"比：对手更大 => 我输；相等 => 平；更小 => 我赢
    if (bestOppCmp > 0) lose++;
    else if (bestOppCmp === 0) tie++;
    else win++;
  }

  // 4) 换算成百分比。equity（综合赢面）把平局按"大家平分"折算：
  //    赢算 1 份、平局算半份（简化：按一个对手平分，近似够用）。
  const toPct = (x) => (x / simulations) * 100;
  const winPct = toPct(win);
  const tiePct = toPct(tie);
  const losePct = toPct(lose);
  const equity = winPct + tiePct / 2;

  return {
    ok: true,
    win: round1(winPct),
    tie: round1(tiePct),
    lose: round1(losePct),
    equity: round1(equity),
    samples: simulations,
  };
}

/**
 * 底池赔率 + 盈亏平衡胜率。
 * 讲人话：你跟这注要花 toCall，赢了能拿走 pot(含对手刚下的)。
 *   盈亏平衡胜率 = 你要花的钱 / (最终底池)。
 *   只要你的真实胜率高于这个平衡点，长期跟注就是赚的。
 * @param {number} pot    当前底池（在你跟注之前的总额）
 * @param {number} toCall 你需要跟入的筹码
 * @returns {{ok:boolean, potOddsText?:string, breakevenPct?:number, reason?:string}}
 */
export function potOdds(pot, toCall) {
  pot = Number(pot) || 0;
  toCall = Number(toCall) || 0;
  if (toCall <= 0) {
    // 不用花钱就能看牌（已过牌/免费看），不存在赔率问题
    return { ok: true, breakevenPct: 0, potOddsText: '无需跟注（可免费看牌）' };
  }
  if (pot <= 0) {
    return { ok: false, reason: '暂无底池数据' };
  }
  const finalPot = pot + toCall; // 你跟注后，你赢了能拿走的总额
  const breakevenPct = (toCall / finalPot) * 100; // 盈亏平衡胜率
  // 赔率文字，如 "3.0 : 1"（赢 1 次能抵 3 次输）
  const ratio = (pot / toCall).toFixed(1);
  return {
    ok: true,
    breakevenPct: round1(breakevenPct),
    potOddsText: `${ratio} : 1`,
  };
}

/**
 * 综合胜率和底池赔率，给出跟/弃建议。
 * @param {number} equity      你的综合胜率（百分比）
 * @param {number} breakeven   盈亏平衡胜率（百分比）
 * @returns {{action:string, level:'good'|'close'|'bad', detail:string}}
 */
export function suggestAction(equity, breakeven) {
  const margin = equity - breakeven; // 你比"回本线"高/低多少个点
  if (margin >= EQUITY.CALL_MARGIN) {
    return {
      action: '建议跟注',
      level: 'good',
      detail: `胜率 ${equity}% 高于回本线 ${breakeven}%，长期跟注划算。`,
    };
  }
  if (margin <= EQUITY.FOLD_MARGIN) {
    return {
      action: '建议弃牌',
      level: 'bad',
      detail: `胜率 ${equity}% 低于回本线 ${breakeven}%，长期跟注亏损。`,
    };
  }
  return {
    action: '临界，谨慎',
    level: 'close',
    detail: `胜率 ${equity}% 和回本线 ${breakeven}% 很接近，可结合位置与读牌决定。`,
  };
}

/**
 * 对外的"一次性全算好"便捷函数：给界面用，省得各处零散调用。
 * @param {object} ctx 由数据抽取层（game-state.js）产出的局面上下文
 * @returns {object} 聚合好的结果，含胜率/赔率/建议/听牌提示
 */
export function analyze(ctx) {
  // 1) 胜率
  const equity = simulateEquity({
    hole: ctx.hole,
    board: ctx.board,
    opponents: ctx.opponents,
  });
  if (!equity.ok) {
    return { ok: false, reason: equity.reason };
  }

  // 2) 底池赔率 + 建议
  const odds = potOdds(ctx.pot, ctx.toCall);
  let suggestion = null;
  if (odds.ok && odds.breakevenPct != null) {
    suggestion = suggestAction(equity.equity, odds.breakevenPct);
  }

  // 3) 听牌提示（只用你的底牌 + 已翻公共牌，合法）
  const draws = detectDraws([...(ctx.hole || []), ...(ctx.board || [])]);

  return {
    ok: true,
    equity, // {win,tie,lose,equity,samples}
    odds, // {potOddsText,breakevenPct}
    suggestion, // {action,level,detail} 或 null
    draws, // string[]
  };
}

// —— 小工具 ——
function round1(x) {
  return Math.round(x * 10) / 10; // 保留 1 位小数
}

function emptyResult(reason) {
  return { ok: false, win: 0, tie: 0, lose: 0, equity: 0, samples: 0, reason };
}
