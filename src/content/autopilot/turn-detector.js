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

import { POKER_ACTION, ACTION_BUTTON_RULES } from '../../common/constants.js';
import { isVisible, findActionButton } from './dom-locator.js';

// 能证明"轮到我"的按钮：弃牌 / 过牌 / 跟注（加注按钮可能常驻，不作为判据）。
const TURN_PROOF_ACTIONS = [POKER_ACTION.FOLD, POKER_ACTION.CHECK, POKER_ACTION.CALL];

/** 取元素可见文字 */
function textOf(el) {
  return (el && (el.textContent || el.value) || '').trim();
}

/**
 * 最可靠的判据：动作区容器里有没有【可点】的弃牌/过牌/跟注按钮。
 *   没轮到你时，这些按钮要么不存在、要么是禁用的；所以"能点"就等于"轮到我"。
 * @returns {boolean|null} true=轮到我；false=动作区在但没可点按钮；null=页面上没找到动作区（交给兜底判断）
 */
function checkActionZone(rule, root) {
  let zoneFound = false;
  for (const sel of rule.actionZoneSelectors || []) {
    let zone = null;
    try {
      zone = root.querySelector(sel);
    } catch {
      continue; // 选择器写错不致崩
    }
    if (!zone) continue;
    zoneFound = true;
    // 只在动作区里找按钮，避免误认页面其它地方的同名按钮
    const hasButton = TURN_PROOF_ACTIONS.some((a) => findActionButton(ACTION_BUTTON_RULES[a], zone));
    if (hasButton) return true;
  }
  return zoneFound ? false : null;
}

/**
 * 判断当前是否"轮到我行动"。
 * @param {object} rule TURN_INDICATOR_RULES：{actionZoneSelectors, selectors, textIncludes}
 * @param {Document|Element} [root=document]
 * @returns {boolean}
 */
export function isMyTurn(rule, root = document) {
  if (!rule) return false;

  // 0) 动作区判据（最可靠）：找到了动作区就以它为准，不再看文字（防止"轮到 XX"之类文字误判）。
  const zoneResult = checkActionZone(rule, root);
  if (zoneResult !== null) return zoneResult;

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
