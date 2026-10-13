/**
 * 托管·轮次探测器（判断"是不是轮到我行动了"）
 * ------------------------------------------------------------
 * 职责（单一）：只回答一个问题——"现在该我出手吗？"，返回 true/false。
 *   不做决策、不点按钮。怎么认"轮到我"由外部规则（TURN_INDICATOR_RULES）决定。
 *
 * 为什么单独成一个模块：
 *   "认轮次"是最容易因站点差异而需要调整的部分，隔离出来后，
 *   以后改识别方式只动这一个文件，控制器（controller）完全不用变。
 */

import { isVisible } from './dom-locator.js';

/** 取元素可见文字 */
function textOf(el) {
  return (el && (el.textContent || el.value) || '').trim();
}

/**
 * 判断当前是否"轮到我行动"。
 * @param {object} rule TURN_INDICATOR_RULES：{selectors:string[], textIncludes:string[]}
 * @param {Document|Element} [root=document]
 * @returns {boolean}
 */
export function isMyTurn(rule, root = document) {
  if (!rule) return false;

  // 1) 先看精确选择器：轮到我时常会出现/高亮某个元素（如 .your-turn）。
  //    只要这个元素存在且可见，就认为轮到我了。
  for (const sel of rule.selectors || []) {
    try {
      const el = root.querySelector(sel);
      if (el && isVisible(el)) return true;
    } catch {
      // 选择器写错不致崩，继续
    }
  }

  // 2) 兜底：扫页面文字，看有没有"轮到你 / your turn"之类的可见提示。
  //    为控制性能，只在"可能承载提示文案"的小范围元素里找，而不是全页遍历。
  const words = (rule.textIncludes || []).map((w) => String(w).toLowerCase());
  if (words.length === 0) return false;

  // 常见承载提示文案的元素类型（克制范围，避免扫到正文大段文字）
  const nodes = root.querySelectorAll('span, div, p, b, strong, button, [class*="turn"], [class*="active"]');
  for (const el of nodes) {
    if (!isVisible(el)) continue;
    const txt = textOf(el).toLowerCase();
    if (!txt || txt.length > 40) continue; // 提示文案一般很短，太长的多半是正文
    if (words.some((w) => txt.includes(w))) return true;
  }
  return false;
}
