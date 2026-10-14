/**
 * 数据层：「决策引擎」统一入口（托管大脑的总开关 + 路由）
 * ------------------------------------------------------------
 * 职责（单一）：根据配置的"策略档位"，把当前局面交给对应的策略去决策，
 *   最后统一产出一个标准化的决策结果。它只负责"选哪套大脑 + 把输入喂进去"，
 *   具体怎么想交给各个 strategies/*-strategy.js（可插拔、互不干扰）。
 *
 * 为什么要有这一层（模块化 + 数据管理层抽象）：
 *   - 调用方（执行器/面板）永远只调 decide(ctx, config)，不关心用的是哪套策略；
 *   - 以后新增"复杂判断""GTO 策略"，只要在 STRATEGY_TIERS 里登记 + 写个策略文件，
 *     这里加一行路由即可，调用方代码一个字都不用改。
 *
 * 输入 / 输出的"合同"（所有策略共享同一份，便于互换）：
 *   输入 ctx    —— game-state.js 产出的局面：{hole,board,opponents,pot,toCall,...}
 *   输入 config —— {tier: 档位id, opponentPercent: 对手牌力百分比}
 *   输出        —— {ok, action, amount, reason, tier, equity}
 *                  ok=false 时附 reason，表示"这手不方便托管"（如数据不足）。
 */

import {
  POKER_ACTION,
  getStrategyTier,
  DEFAULT_OPPONENT_STYLE,
  DEFAULT_AGGRESSION_PROFILE,
  DEFAULT_VALUE_BET_PROFILE,
  getOpponentPercent,
} from '../common/constants.js';
import { simulateEquity } from './equity-engine.js';
import { buildOpponentModel, resolveOpponentStyle } from './opponent-model.js';

// 各策略实现：按"策略名 -> 决策函数"登记。
//   新增策略时在这里加一行即可（档位③的实现文件后续补上）。
import { decide as simpleDecide } from './strategies/simple-strategy.js';
import { decide as complexDecide } from './strategies/complex-strategy.js';

// 策略注册表：key 对应 STRATEGY_TIERS[].strategy 字段。
//   暂未实现的档位先不登记，运行时会回退到 simple 并在 reason 里说明。
const STRATEGY_REGISTRY = {
  simple: simpleDecide,
  complex: complexDecide, // 档位②·复杂判断
  // gto: gtoDecide,          // 档位③，待实现
};

/**
 * 把策略算出的“加注至金额”限制在服务器明确给出的合法范围内。
 * 拿不到某一侧边界时只限制另一侧；两侧都没有则保持原值。
 */
function normalizeRaiseAmount(amount, minRaiseTo, maxRaiseTo) {
  let value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return 0;

  const min = Number(minRaiseTo);
  const max = Number(maxRaiseTo);
  if (Number.isFinite(max) && max > 0) value = Math.min(value, max);
  if (Number.isFinite(min) && min > 0) value = Math.max(value, min);
  return Math.round(value);
}

/**
 * 【对外主函数】对当前局面做一次托管决策。
 * @param {object} ctx 局面上下文（game-state.js 的 extractGameState 结果，需 ok=true）
 * @param {object} [config]
 *   @param {string} [config.tier]            策略档位 id（默认取档位配置里的默认档）
 *   @param {string} [config.opponentStyle]   对手风格 id（用于设定对手牌力，影响胜率）
 *   @param {string} [config.aggressionProfile] 整体打法倾向（稳健/均衡/激进）
 *   @param {string} [config.valueBetProfile] 大牌价值下注力度（标准/强势/最大化）
 *   @param {number} [config.simulations]     可选：覆盖模拟次数（测试时可调小加速）
 *   @param {Array}  [config.records]         可选：全部抓包记录。传入时会"边打边记"构建对手档案，
 *                                            在你没主动选风格（用默认档）且观察可靠时，用观察结果覆盖。
 * @returns {{ok:boolean, reason?:string, action?:string, amount?:number, tier?:string, equity?:object, opponentModel?:object}}
 */
export function decide(ctx, config = {}) {
  // 1) 局面必须有效（有底牌等）。无效直接返回"不托管"，由上层决定如何提示。
  if (!ctx || !ctx.ok) {
    return { ok: false, reason: (ctx && ctx.reason) || '局面数据不足，暂不托管。' };
  }

  // 2) 解析配置档位（查不到会回退到默认档，保证不崩）。
  const tierConf = getStrategyTier(config.tier);

  // 2.5) 决定本手用哪个"对手风格"：
  //   - 基线 = 你手选的风格（没选则默认「标准」）。
  //   - 若传入了 records（边打边记），且你用的就是默认档（等于"没主见"），
  //     并且观察样本够多够可靠，就用机器人自己观察出的隐含风格覆盖基线。
  //   - 你一旦手动选了非默认风格，就【尊重你的选择】，不自作主张（数据一致性 + 可预期）。
  //   ⚠️ "到底用哪个画像"这条规则统一交给 resolveOpponentStyle（和面板共用同一函数），
  //      避免两处各写一份、导致"面板胜率"和"托管实际画像"对不上。
  const chosenStyle = config.opponentStyle || DEFAULT_OPPONENT_STYLE;
  let opponentModel = null;
  let modelNote = '';

  if (Array.isArray(config.records)) {
    opponentModel = buildOpponentModel(config.records);
  }
  const resolved = resolveOpponentStyle(chosenStyle, opponentModel);
  const opponentStyle = resolved.style;
  if (resolved.overridden) {
    modelNote = `（已据 ${opponentModel.handsSeen} 手观察，自动按「${opponentStyle}」桌打）`;
  }

  // 3) 先算胜率（决策的核心依据）。对手牌力按上面定好的风格来。
  const eq = simulateEquity({
    hole: ctx.hole,
    board: ctx.board,
    opponents: ctx.opponents,
    opponentPercent: getOpponentPercent(opponentStyle),
    simulations: config.simulations, // 不传则引擎用默认次数
  });
  if (!eq.ok) {
    return { ok: false, reason: eq.reason || '胜率算不出来，暂不托管。', tier: tierConf.id };
  }

  // 4) 按档位选策略函数。未实现的档位回退到 simple，并在理由里说明。
  let strategyFn = STRATEGY_REGISTRY[tierConf.strategy];
  let fallbackNote = '';
  if (!strategyFn) {
    strategyFn = STRATEGY_REGISTRY.simple;
    fallbackNote = `（档位「${tierConf.label}」尚在开发中，暂用简单档代理）`;
  }

  // 5) 交给策略决策，拿到标准化动作结果。
  //    把 opponentStyle 一并传入：档位②会据此做"群体默认画像"的温和偏移
  //    （松桌多价值少诈唬、紧桌敢施压）。简单档不读这个字段，多传无害。
  const result = strategyFn({
    ctx,
    eq,
    opponentStyle,
    aggressionProfile: config.aggressionProfile || DEFAULT_AGGRESSION_PROFILE,
    valueBetProfile: config.valueBetProfile || DEFAULT_VALUE_BET_PROFILE,
  });
  const rawAmount = Number(result.amount) || 0;
  const amount =
    result.action === POKER_ACTION.RAISE
      ? normalizeRaiseAmount(rawAmount, ctx.minRaiseTo, ctx.maxRaiseTo)
      : rawAmount;
  const amountNote =
    result.action === POKER_ACTION.RAISE && amount !== Math.round(rawAmount)
      ? `（已按牌桌合法范围调整为 ${amount}）`
      : '';

  // 6) 组装统一返回：带上档位、胜率、对手档案，方便面板展示与日志。
  return {
    ok: true,
    tier: tierConf.id,
    action: result.action || POKER_ACTION.CHECK,
    // 使用服务器认可的合法金额，让“接下来”预告与最终实际下注保持一致。
    amount,
    minRaiseTo: ctx.minRaiseTo ?? null,
    maxRaiseTo: ctx.maxRaiseTo ?? null,
    reason: (result.reason || '') + amountNote + modelNote + fallbackNote,
    equity: eq, // 把胜率一起带出来，面板可直接显示，不必再算一遍
    opponentModel, // 对手档案（可能为 null/不可靠），面板可选择性展示
  };
}
