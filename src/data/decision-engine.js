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
  getOpponentPercent,
} from '../common/constants.js';
import { simulateEquity } from './equity-engine.js';

// 各策略实现：按"策略名 -> 决策函数"登记。
//   新增策略时在这里加一行即可（档位②③的实现文件后续补上，先只接 simple）。
import { decide as simpleDecide } from './strategies/simple-strategy.js';

// 策略注册表：key 对应 STRATEGY_TIERS[].strategy 字段。
//   暂未实现的档位先不登记，运行时会回退到 simple 并在 reason 里说明。
const STRATEGY_REGISTRY = {
  simple: simpleDecide,
  // complex: complexDecide,  // 档位②，待实现
  // gto: gtoDecide,          // 档位③，待实现
};

/**
 * 【对外主函数】对当前局面做一次托管决策。
 * @param {object} ctx 局面上下文（game-state.js 的 extractGameState 结果，需 ok=true）
 * @param {object} [config]
 *   @param {string} [config.tier]            策略档位 id（默认取档位配置里的默认档）
 *   @param {string} [config.opponentStyle]   对手风格 id（用于设定对手牌力，影响胜率）
 *   @param {number} [config.simulations]     可选：覆盖模拟次数（测试时可调小加速）
 * @returns {{ok:boolean, reason?:string, action?:string, amount?:number, tier?:string, equity?:object}}
 */
export function decide(ctx, config = {}) {
  // 1) 局面必须有效（有底牌等）。无效直接返回"不托管"，由上层决定如何提示。
  if (!ctx || !ctx.ok) {
    return { ok: false, reason: (ctx && ctx.reason) || '局面数据不足，暂不托管。' };
  }

  // 2) 解析配置档位（查不到会回退到默认档，保证不崩）。
  const tierConf = getStrategyTier(config.tier);

  // 3) 先算胜率（决策的核心依据）。对手牌力按配置的风格来，默认"标准"。
  const opponentStyle = config.opponentStyle || DEFAULT_OPPONENT_STYLE;
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
  const result = strategyFn({ ctx, eq });

  // 6) 组装统一返回：带上档位、胜率，方便面板展示与日志。
  return {
    ok: true,
    tier: tierConf.id,
    action: result.action || POKER_ACTION.CHECK,
    amount: Number(result.amount) || 0,
    reason: (result.reason || '') + fallbackNote,
    equity: eq, // 把胜率一起带出来，面板可直接显示，不必再算一遍
  };
}
