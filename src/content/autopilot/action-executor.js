/**
 * 托管·动作执行器（把"决策"真正变成页面上的点击）
 * ------------------------------------------------------------
 * 职责（单一）：收到一个决策 {action, amount}，在页面上找到对应按钮并点击；
 *   若是加注，先把金额填进输入框再点"加注"。只负责"手"，不负责"脑"。
 *
 * 拟人化 & 安全：
 *   - 点击前随机等待一小段时间（像真人思考），区间由 AUTOPILOT 配置。
 *   - 找不到按钮就放弃本次（返回失败），绝不乱点。
 *
 * 和项目一致的分层：规则（怎么认按钮）来自 constants.js；
 *   执行器只按规则找、按决策点，规则与逻辑解耦。
 */

import {
  POKER_ACTION,
  POKER_ACTION_NAMES,
  ACTION_BUTTON_RULES,
  BET_INPUT_RULES,
  AUTOPILOT,
} from '../../common/constants.js';
import { findActionButton, findBetInput, isActionable } from './dom-locator.js';

/** 返回 [min, max] 区间内的随机整数毫秒数（拟人化延迟用） */
function randomDelay() {
  const min = AUTOPILOT.ACTION_DELAY_MIN_MS;
  const max = AUTOPILOT.ACTION_DELAY_MAX_MS;
  return Math.floor(min + Math.random() * Math.max(0, max - min));
}

/** 一个"等待 ms 毫秒"的 Promise，便于用 await 写顺序逻辑 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 给输入框"像真人一样"赋值：先聚焦，设置 value，再派发 input/change 事件。
 *   很多前端框架（React/Vue）只认事件，不派发事件它不会更新内部状态。
 * @param {HTMLInputElement} input
 * @param {number} value
 */
function setInputValue(input, value) {
  input.focus();
  // 用原生 setter 赋值，确保 React 这类框架能感知到变化
  const proto = Object.getPrototypeOf(input);
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) {
    desc.set.call(input, String(value));
  } else {
    input.value = String(value);
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * 模拟一次真实点击：派发 mousedown/mouseup/click，兼容只认鼠标事件的站点。
 * @param {Element} el
 */
function humanClick(el) {
  const opts = { bubbles: true, cancelable: true, view: window };
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.click(); // 原生 click 覆盖大多数情况
}

/**
 * 【对外主函数】执行一个决策动作。
 * @param {object} decision {action, amount, reason, ...}（background 决策引擎产出）
 * @returns {Promise<{ok:boolean, action?:string, amount?:number, label?:string, reason:string}>}
 *   ok=true 表示成功点了；ok=false 带 reason 说明为何没点（如没找到按钮）。
 */
export async function executeDecision(decision) {
  if (!decision || !decision.action) {
    return { ok: false, reason: '没有有效决策，跳过。' };
  }

  const action = decision.action;
  const rule = ACTION_BUTTON_RULES[action];
  if (!rule) {
    return { ok: false, reason: `未知动作「${action}」，跳过。` };
  }

  // 1) 先找到动作按钮；找不到就不动（宁可不点也不乱点）。
  const btn = findActionButton(rule);
  if (!btn) {
    return { ok: false, reason: `页面上没找到「${POKER_ACTION_NAMES[action] || action}」按钮，跳过。` };
  }

  // 2) 拟人化等待：像真人思考一会儿再出手。
  await sleep(randomDelay());

  // 3) 等待后按钮可能已失效（局面变了），再确认一次可点。
  if (!isActionable(btn)) {
    return { ok: false, reason: '准备点击时按钮已失效（局面可能已变），跳过。' };
  }

  // 4) 若是加注，先把金额填进输入框（填不进也继续点按钮，让站点用默认额兜底）。
  if (action === POKER_ACTION.RAISE && decision.amount > 0) {
    const input = findBetInput(BET_INPUT_RULES);
    if (input) {
      setInputValue(input, decision.amount);
      await sleep(200); // 给框架一点时间消化输入
    }
  }

  // 5) 点击！
  humanClick(btn);

  return {
    ok: true,
    action,
    amount: Number(decision.amount) || 0,
    label: POKER_ACTION_NAMES[action] || action,
    reason: decision.reason || '',
  };
}
