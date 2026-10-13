/**
 * 策略层：「档位①·简单托管」
 * ------------------------------------------------------------
 * 职责（单一）：输入"当前局面 + 已算好的胜率"，输出"该做什么动作"。
 *   —— 它是一个纯函数：给同样的输入，永远给同样的输出，不碰 DOM、不碰网络，
 *      所以极好测试、好复用（这就是我们把决策和执行分开的原因）。
 *
 * 这一档的"思路"非常朴素，只看两件事（最好理解、也最稳健）：
 *   1) 我的胜率 equity 有多高？
 *   2) 跟这注划不划算（底池赔率算出的"回本线" breakevenPct）？
 * 规则：
 *   - 不用花钱（toCall=0，可免费过牌）：
 *       · 胜率很高  -> 加注要价（价值下注）
 *       · 否则      -> 过牌（白看一张，不浪费筹码）
 *   - 需要跟注（toCall>0）：
 *       · 胜率明显高于回本线很多 -> 加注
 *       · 高于回本线（够本）     -> 跟注
 *       · 和回本线差不多（临界） -> 跟注（简单档选择保守跟注看牌）
 *       · 明显低于回本线         -> 弃牌
 *
 * 约定的返回结构（所有策略都遵守同一份"合同"，便于互换）：
 *   { action, amount, reason }
 *     action —— POKER_ACTION 之一（fold/check/call/raise）
 *     amount —— 仅 raise 时有意义：建议加注到多少筹码；其它动作为 0
 *     reason —— 给人看的决策理由（会显示在面板"最近动作"里）
 */

import { POKER_ACTION, POKER_ACTION_NAMES, EQUITY, AUTOPILOT } from '../../common/constants.js';
import { potOdds } from '../equity-engine.js';

// "胜率明显高于回本线多少个点，就从'跟注'升级成'加注'"的阈值。
//   复用 CALL_MARGIN 作为基准，再额外要求高出一截，避免赢面一般也乱加注。
const RAISE_EXTRA_MARGIN = 15; // 高出回本线 (CALL_MARGIN + 15) 个点以上才加注

// 没有底池赔率数据时（比如还没下注、免费看牌），用这个绝对胜率线来决定是否价值加注。
const FREE_VALUE_RAISE_EQUITY = 65; // 免费可过牌时，胜率 >= 65% 才主动加注要价

/**
 * 计算一个"稳健的加注额"：当前底池的固定比例，并向下取整到整数筹码。
 * @param {number} pot 当前底池
 * @returns {number} 建议加注到的筹码数（至少为 1，避免 0 注）
 */
function computeRaiseAmount(pot) {
  const base = Number(pot) || 0;
  const raise = Math.floor(base * AUTOPILOT.RAISE_POT_RATIO);
  return Math.max(1, raise);
}

/**
 * 【对外主函数】简单档决策。
 * @param {object} params
 *   @param {object} params.ctx 局面上下文（game-state.js 产出）：{hole,board,opponents,pot,toCall}
 *   @param {object} params.eq  胜率结果（equity-engine.js 产出）：{equity,win,...,ok}
 * @returns {{action:string, amount:number, reason:string}}
 */
export function decide({ ctx, eq }) {
  // 兜底：胜率没算出来就别乱动，交给上层决定（通常是"不托管这手"）。
  if (!eq || !eq.ok) {
    return {
      action: POKER_ACTION.CHECK,
      amount: 0,
      reason: '胜率数据不足，暂不主动行动。',
    };
  }

  const equity = eq.equity; // 综合赢面（百分比）
  const pot = Number(ctx.pot) || 0;
  const toCall = Number(ctx.toCall) || 0;

  // —— 情况 A：不用花钱（可免费过牌）——
  if (toCall <= 0) {
    if (equity >= FREE_VALUE_RAISE_EQUITY) {
      const amount = computeRaiseAmount(pot);
      return {
        action: POKER_ACTION.RAISE,
        amount,
        reason: `可免费行动且胜率高达 ${equity}%，主动加注到约 ${amount} 要价。`,
      };
    }
    return {
      action: POKER_ACTION.CHECK,
      amount: 0,
      reason: `可免费过牌、胜率 ${equity}% 还不够强，先过牌白看一张。`,
    };
  }

  // —— 情况 B：需要跟注，先算"回本线"（底池赔率）——
  const odds = potOdds(pot, toCall);
  // 回本线取不到时，退化成"用绝对胜率 50% 判断"的保守逻辑，保证始终能给出动作。
  const breakeven = odds.ok && odds.breakevenPct != null ? odds.breakevenPct : 50;
  const margin = equity - breakeven; // 比回本线高/低多少个点

  // 明显低于回本线 -> 弃牌
  if (margin <= EQUITY.FOLD_MARGIN) {
    return {
      action: POKER_ACTION.FOLD,
      amount: 0,
      reason: `胜率 ${equity}% 低于回本线 ${breakeven}%，跟注长期亏，弃牌。`,
    };
  }

  // 明显高出回本线一大截 -> 加注（价值最大化）
  if (margin >= EQUITY.CALL_MARGIN + RAISE_EXTRA_MARGIN) {
    const amount = computeRaiseAmount(pot);
    return {
      action: POKER_ACTION.RAISE,
      amount,
      reason: `胜率 ${equity}% 远高于回本线 ${breakeven}%，加注到约 ${amount} 扩大收益。`,
    };
  }

  // 其余（够本或临界）-> 跟注
  return {
    action: POKER_ACTION.CALL,
    amount: 0,
    reason: `胜率 ${equity}% 不低于回本线 ${breakeven}%，跟注划算。`,
  };
}

// 把动作翻译成"动作名"的小助手，供上层做日志/展示时统一口径（可选用）。
export function actionName(action) {
  return POKER_ACTION_NAMES[action] || action;
}
