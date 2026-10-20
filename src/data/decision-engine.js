/**
 * 数据层：「决策引擎」统一入口（托管大脑的总开关 + 路由）
 * ------------------------------------------------------------
 * 职责：根据配置的"策略档位"，把当前局面交给对应的策略去决策，最后统一产出标准化结果。
 *
 * 一次决策的流水线（讲人话）：
 *   1) 定对手风格：你手选的，或机器人边打边记观察出来的；
 *   2) 收窄对手范围：对手下注/加注越大，他手里越可能是好牌（opponent-range.js）；
 *   3) 算胜率：按收窄后的范围做蒙特卡洛模拟；
 *   4) 交给策略：策略只说"做什么 + 下注意图（半池 / 开池 2.5BB / 全下）"；
 *   5) 换算金额：bet-sizing.js 把意图换算成正确的"加注至"金额，并封顶、夹合法范围；
 *      换算不出合法加注（如普通牌只能全下）时，自动降级为跟注/过牌，绝不冒险。
 *
 * 输出：{ok, action, amount, reason, tier, equity, ...}
 *   amount 只对加注有意义 = "加注至"金额（直接填进 River 的金额框）。
 */

import {
  POKER_ACTION,
  getStrategyTier,
  DEFAULT_OPPONENT_STYLE,
  DEFAULT_AGGRESSION_PROFILE,
  DEFAULT_VALUE_BET_PROFILE,
  DEFAULT_PREFLOP_ENTRY_PROFILE,
  getOpponentPercent,
  getOpponentStyleLabel,
  getValueBetProfile,
} from '../common/constants.js';
import { simulateEquity, potOdds } from './equity-engine.js';
import { buildOpponentModel, resolveOpponentStyle } from './opponent-model.js';
import { narrowOpponentPercent } from './opponent-range.js';
import { resolveRaiseTo } from './bet-sizing.js';

// 各策略实现：按"策略名 -> 决策函数"登记（新增策略在这里加一行即可）。
import { decide as simpleDecide } from './strategies/simple-strategy.js';
import { decide as complexDecide } from './strategies/complex-strategy.js';

const STRATEGY_REGISTRY = {
  simple: simpleDecide,
  complex: complexDecide, // 档位②·复杂判断（推荐）
  // gto: gtoDecide,          // 档位③，待实现
};

/**
 * 加注落实不了时的降级：能免费就过牌；要花钱时，胜率够回本线就跟，否则弃。
 * @returns {{action:string, note:string}}
 */
function downgradeRaise(ctx, eq, why) {
  const toCall = Number(ctx.toCall) || 0;
  if (toCall <= 0) return { action: POKER_ACTION.CHECK, note: `（${why}，改为过牌）` };
  const odds = potOdds(ctx.pot, toCall);
  const breakeven = odds.ok && odds.breakevenPct != null ? odds.breakevenPct : 100;
  const equity = eq && eq.ok ? eq.equity : 0;
  // 翻牌前胜率天然偏低，策略本来就想加注说明牌不差，翻牌前统一降级为跟注。
  const preflop = !ctx.board || ctx.board.length === 0;
  if (preflop || equity >= breakeven) {
    return { action: POKER_ACTION.CALL, note: `（${why}，改为跟注）` };
  }
  return { action: POKER_ACTION.FOLD, note: `（${why}，且跟注不划算，改为弃牌）` };
}

/**
 * 把策略结果里的"加注"统一换算成合法的"加注至"金额。
 *   兼容两种写法：新写法给 sizing 意图；老写法只给 amount（当作"加注至"金额直接用）。
 */
function finalizeRaise(ctx, eq, result, valueBetProfile) {
  const sizing = result.sizing || { kind: 'raiseTo', value: result.amount };
  const valueBet = getValueBetProfile(valueBetProfile).decision;
  const resolved = resolveRaiseTo(ctx, sizing, valueBet);
  if (!resolved.ok) {
    const down = downgradeRaise(ctx, eq, resolved.reason.replace(/。$/, ''));
    return { action: down.action, amount: 0, reason: `${result.reason}${down.note}`, allIn: false };
  }
  const verb = resolved.allIn ? '全下' : (Number(ctx.toCall) || 0) > 0 ? '加注至' : '下注至';
  const extra = resolved.note ? `（${resolved.note}）` : '';
  return {
    action: POKER_ACTION.RAISE,
    amount: resolved.raiseTo,
    allIn: resolved.allIn,
    reason: `${result.reason.replace(/[。，]$/, '')}，${verb} ${resolved.raiseTo}${extra}。`,
  };
}

/**
 * 【对外主函数】对当前局面做一次托管决策。
 * @param {object} ctx 局面上下文（game-state.js 的 extractGameState 结果，需 ok=true）
 * @param {object} [config]
 *   @param {string} [config.tier]              策略档位 id
 *   @param {string} [config.opponentStyle]     对手类型 id（auto=自动识别，或具体风格）
 *   @param {string} [config.aggressionProfile] 整体打法倾向
 *   @param {string} [config.valueBetProfile]   大牌下注力度
 *   @param {string} [config.preflopEntryProfile] 翻牌前入池意愿（便宜时愿不愿意用差牌看翻牌）
 *   @param {number} [config.simulations]       可选：覆盖模拟次数（测试时调小加速）
 *   @param {Array}  [config.records]           可选：全部抓包记录（边打边记对手档案）
 *   @param {object} [config.opponentModel]     可选：已算好的对手档案（面板已经算过时直接传，省得再算一遍）
 *   @param {Function} [config.rng]             可选：随机数函数（测试注入）
 * @returns {object}
 */
export function decide(ctx, config = {}) {
  // 1) 局面必须有效。
  if (!ctx || !ctx.ok) {
    return { ok: false, reason: (ctx && ctx.reason) || '局面数据不足，暂不托管。' };
  }
  const tierConf = getStrategyTier(config.tier);

  // 2) 定对手风格（规则统一交给 resolveOpponentStyle，和面板共用，保证两边一致）。
  const chosenStyle = config.opponentStyle || DEFAULT_OPPONENT_STYLE;
  let opponentModel = config.opponentModel || null;
  if (!opponentModel && Array.isArray(config.records)) opponentModel = buildOpponentModel(config.records);
  const resolved = resolveOpponentStyle(chosenStyle, opponentModel);
  const opponentStyle = resolved.style;
  const modelNote = resolved.learned
    ? `（已观察 ${opponentModel.handsSeen} 手，按「${getOpponentStyleLabel(opponentStyle)}」对手打）`
    : '';

  // 3) 按对手下注行为收窄范围，再算胜率。
  const range = narrowOpponentPercent(ctx, getOpponentPercent(opponentStyle));
  const eq = simulateEquity({
    hole: ctx.hole,
    board: ctx.board,
    opponents: ctx.opponents,
    opponentPercent: range.percent,
    weighers: range.weighers, // 翻牌后面对下注：按"对手会这样下注的牌"加权抽牌
    simulations: config.simulations,
  });
  // 翻牌前策略不依赖胜率，算不出来也能决策；翻牌后没胜率就不托管。
  if (!eq.ok && ctx.board && ctx.board.length > 0) {
    return { ok: false, reason: eq.reason || '胜率算不出来，暂不托管。', tier: tierConf.id };
  }

  // 4) 选策略（未实现的档位回退 simple）。
  let strategyFn = STRATEGY_REGISTRY[tierConf.strategy];
  let fallbackNote = '';
  if (!strategyFn) {
    strategyFn = STRATEGY_REGISTRY.simple;
    fallbackNote = `（档位「${tierConf.label}」尚在开发中，暂用简单档代理）`;
  }
  const aggressionProfile = config.aggressionProfile || DEFAULT_AGGRESSION_PROFILE;
  const valueBetProfile = config.valueBetProfile || DEFAULT_VALUE_BET_PROFILE;
  const preflopEntryProfile = config.preflopEntryProfile || DEFAULT_PREFLOP_ENTRY_PROFILE;
  const result = strategyFn({
    ctx,
    eq,
    opponentStyle,
    aggressionProfile,
    valueBetProfile,
    preflopEntryProfile,
    exploitMode: Boolean(config.exploitMode), // 剥削模式开关：针对线上 AI 弱点的专项调整（见 complex-strategy）
    plan: config.plan || {}, // 本手诈唬计划(连续开枪数)，后台跨 tick 维护，用于「诈唬纪律」
    rng: config.rng,
  });

  // 5) 加注统一换算金额；其它动作金额为 0。
  let final = { action: result.action || POKER_ACTION.CHECK, amount: 0, reason: result.reason || '', allIn: false };
  if (final.action === POKER_ACTION.RAISE) {
    final = finalizeRaise(ctx, eq, result, valueBetProfile);
  }
  // 诈唬标记：策略把"主动诈唬性下注"标了 bluff=true；只有最终仍是加注/下注才算真开了一枪，
  //   被降级成跟注/过牌(finalizeRaise 可能降级)就不算。后台据此累加本手"连续开枪数"。
  const bluff = Boolean(result.bluff) && final.action === POKER_ACTION.RAISE;
  // 跟注时如果要跟的钱 ≥ 剩余筹码，实际就是跟注全下，标出来方便你在面板一眼看到。
  const stack = Number(ctx.stack);
  if (final.action === POKER_ACTION.CALL && Number.isFinite(stack) && stack > 0 && ctx.toCall >= stack) {
    final.allIn = true;
  }

  return {
    ok: true,
    tier: tierConf.id,
    action: final.action,
    amount: final.amount,
    allIn: final.allIn,
    bluff, // 本次是否为"主动诈唬性下注"：后台用它累加本手连续开枪数（诈唬纪律）
    minRaiseTo: ctx.minRaiseTo ?? null,
    maxRaiseTo: ctx.maxRaiseTo ?? null,
    toCall: Number(ctx.toCall) || 0, // 要跟的钱（执行层记录跟注金额用）
    pot: Number(ctx.pot) || 0, // 当前底池（面板展示用）
    stack: ctx.stack ?? null, // 我的剩余筹码（后台统计盈亏用；拿不到为 null）
    reason: final.reason + modelNote + fallbackNote,
    rangeNote: range.note, // 对手范围收窄说明（面板可展示）
    opponentPercent: range.percent,
    signature: ctx.signature, // 局面指纹：执行层用它防止对同一局面重复出手
    street: Array.isArray(ctx.board) ? ctx.board.length : 0,
    equity: eq.ok ? eq : null,
    opponentModel,
  };
}
