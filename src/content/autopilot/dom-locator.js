/**
 * 托管·DOM 定位层（纯工具函数，运行在内容世界 / isolated world）
 * ------------------------------------------------------------
 * 职责（单一）：只负责"在页面上把元素找出来"，不做任何决策、不碰网络。
 *   - 找动作按钮（弃牌/过牌/跟注/加注）
 *   - 找加注金额输入框
 *   - 判断元素是否"可点"（看得见 + 没被禁用）
 *
 * 设计原则（和项目一致）：
 *   - 规则（怎么认按钮）由外部以参数传进来（来自 constants.js 的 *_RULES），
 *     这样本文件是"纯函数、无副作用"，极好测试、好复用。
 *   - 规则优先用 CSS 选择器（最精确），找不到再退回"按文字包含"兜底。
 */

/**
 * 判断元素是不是"可见的"：有尺寸、没被 display:none / visibility:hidden 藏起来。
 * @param {Element} el
 * @returns {boolean}
 */
export function isVisible(el) {
  if (!el || !(el instanceof Element)) return false;
  // offsetParent 为 null 多半是被隐藏了（但 position:fixed 例外，这里再用尺寸兜底）
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return false;
  }
  return true;
}

/**
 * 判断元素是不是"可以点的"：可见 + 没有 disabled / aria-disabled。
 * @param {Element} el
 * @returns {boolean}
 */
export function isActionable(el) {
  if (!isVisible(el)) return false;
  if (el.disabled === true) return false; // 原生 button/input 的禁用
  if (el.getAttribute('aria-disabled') === 'true') return false; // ARIA 禁用
  // 有的站点用 class 表示禁用（如 is-disabled / disabled），做一个宽松判断
  const cls = (el.className && String(el.className)) || '';
  if (/\b(is-)?disabled\b/i.test(cls)) return false;
  return true;
}

/**
 * 候选"可点击元素"集合：常见的按钮类元素。
 * 用一个相对克制的选择器，避免把整页所有 div 都当按钮扫（性能 + 误判）。
 */
const CLICKABLE_SELECTOR =
  'button, [role="button"], input[type="button"], input[type="submit"], a[role="button"]';

/** 取元素的可见文字（去掉首尾空白，便于做"包含"匹配） */
function textOf(el) {
  return (el.textContent || el.value || '').trim();
}

/**
 * 按规则找"某个动作"的按钮。
 * @param {object} rule   单个动作的规则：{ selectors: string[], textIncludes: string[], excludeText?: string[] }
 *   - excludeText：排除闸（可选）。按钮可见文字只要含其中任一词，就【不】算命中。
 *     用途：防止把"重新开始/重新开局/restart"这类重置按钮误认成"下一手"。
 * @param {Document|Element} [root=document] 搜索根（默认整页）
 * @returns {Element|null} 找到的"可点"按钮；找不到返回 null
 */
export function findActionButton(rule, root = document) {
  if (!rule) return null;

  // 排除词统一转小写，供两条匹配路径复用（精确选择器 & 文字兜底都要过这道闸）。
  const excludes = (rule.excludeText || []).map((w) => String(w).toLowerCase());
  // 小工具：这个元素的文字是否命中了"排除词"（命中则应被排除）。
  const isExcluded = (el) => {
    if (excludes.length === 0) return false;
    const t = textOf(el).toLowerCase();
    return excludes.some((w) => t.includes(w));
  };

  // 1) 先按 CSS 选择器找（最精确）。核对真实 DOM 后在 constants.js 里补 selectors。
  for (const sel of rule.selectors || []) {
    try {
      const el = root.querySelector(sel);
      // 即使选择器命中，也要过"排除闸"：防止精确选择器恰好选到重置类按钮。
      if (el && isActionable(el) && !isExcluded(el)) return el;
    } catch {
      // 选择器写错也不让整体崩，继续试下一个
    }
  }

  // 2) 兜底：扫一遍按钮类元素，看文字是否包含关键词（弃牌/跟注/fold/call…）。
  const words = (rule.textIncludes || []).map((w) => String(w).toLowerCase());
  if (words.length === 0) return null;
  const candidates = root.querySelectorAll(CLICKABLE_SELECTOR);
  for (const el of candidates) {
    if (!isActionable(el)) continue;
    const txt = textOf(el).toLowerCase();
    if (!txt) continue;
    if (isExcluded(el)) continue; // 命中排除词 => 跳过（如"重新开始练习"）
    if (words.some((w) => txt.includes(w))) return el;
  }
  return null;
}

/**
 * 按规则找"加注金额输入框"。
 * @param {object} rule {selectors:string[], fallbackInputTypes:string[]}
 * @param {Document|Element} [root=document]
 * @returns {HTMLInputElement|null}
 */
export function findBetInput(rule, root = document) {
  if (!rule) return null;

  // 1) 先按精确选择器
  for (const sel of rule.selectors || []) {
    try {
      const el = root.querySelector(sel);
      if (el && isVisible(el)) return el;
    } catch {
      /* 忽略坏选择器 */
    }
  }

  // 2) 兜底：按 input 类型找（number > range(滑块) > text）
  for (const type of rule.fallbackInputTypes || []) {
    const el = root.querySelector(`input[type="${type}"]`);
    if (el && isVisible(el)) return el;
  }
  return null;
}
