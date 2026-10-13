/**
 * 面板逻辑（panel.js）
 * ------------------------------------------------------------
 * 职责：
 *   1) 和 background 建立长连接，拿初始快照 + 实时接收新数据。
 *   2) 维护本地状态（records），根据过滤条件渲染界面。
 *   3) 顶部两张卡片汇总"底牌"和"公共牌/未翻开牌"；下方列原始消息。
 *
 * 状态管理原则：
 *   - records 是本面板的唯一数据源（single source of truth）。
 *   - 所有渲染都基于 records + 过滤条件重新计算，避免界面和数据不一致。
 */

import { CHANNEL, PANEL_MESSAGE, DIRECTION } from '../common/constants.js';

// ============ 本地状态 ============
const state = {
  records: [], // 全部消息（唯一数据源）
  filterText: '', // 关键词过滤
  inboundOnly: false, // 是否只看服务器下发
};

// ============ DOM 引用（集中获取，便于管理） ============
const dom = {
  filterInput: document.getElementById('filterInput'),
  inboundOnly: document.getElementById('inboundOnly'),
  clearBtn: document.getElementById('clearBtn'),
  holeCards: document.getElementById('holeCards'),
  holeCount: document.getElementById('holeCount'),
  boardCards: document.getElementById('boardCards'),
  boardCount: document.getElementById('boardCount'),
  leakHint: document.getElementById('leakHint'),
  logList: document.getElementById('logList'),
  totalCount: document.getElementById('totalCount'),
};

// ============ 与后台建立长连接 ============
const port = chrome.runtime.connect({ name: CHANNEL.PORT_NAME });

// 打开面板时，先向后台要一份当前全部数据
port.postMessage({ type: PANEL_MESSAGE.GET_SNAPSHOT });

// 接收后台推送
port.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === PANEL_MESSAGE.SNAPSHOT) {
    // 全量快照：直接替换本地数据
    state.records = msg.records || [];
    render();
  } else if (msg.type === PANEL_MESSAGE.NEW_RECORD) {
    // 增量：追加一条后重渲染
    state.records.push(msg.record);
    render();
  }
});

// ============ 交互事件 ============
dom.filterInput.addEventListener('input', (e) => {
  state.filterText = e.target.value.trim().toLowerCase();
  render();
});
dom.inboundOnly.addEventListener('change', (e) => {
  state.inboundOnly = e.target.checked;
  render();
});
dom.clearBtn.addEventListener('click', () => {
  port.postMessage({ type: PANEL_MESSAGE.CLEAR });
});

// ============ 过滤：根据条件得出要显示的记录 ============
function getVisibleRecords() {
  return state.records.filter((r) => {
    if (state.inboundOnly && r.direction !== DIRECTION.INBOUND) return false;
    if (state.filterText) {
      // 在 url 和原始内容里搜关键词
      const haystack = (r.url + ' ' + safeStringify(r.payload)).toLowerCase();
      if (!haystack.includes(state.filterText)) return false;
    }
    return true;
  });
}

// ============ 主渲染：每次数据或过滤变化都整体重算一遍 ============
function render() {
  const visible = getVisibleRecords();
  renderSummary(visible);
  renderLog(visible);
  dom.totalCount.textContent = `共 ${visible.length} 条`;
}

/** 渲染顶部两张汇总卡片 */
function renderSummary(records) {
  // 把所有记录里解析出来的牌，按分类汇总去重
  const holeMap = new Map(); // 底牌：raw -> card
  const boardMap = new Map(); // 公共牌/牌堆：raw -> card

  for (const r of records) {
    for (const card of r.cards || []) {
      if (card.category === 'hole') holeMap.set(card.raw, card);
      else if (card.category === 'board' || card.category === 'deck') boardMap.set(card.raw, card);
    }
  }

  dom.holeCards.innerHTML = renderChips([...holeMap.values()]);
  dom.boardCards.innerHTML = renderChips([...boardMap.values()]);
  dom.holeCount.textContent = holeMap.size;
  dom.boardCount.textContent = boardMap.size;

  // 泄露提示：抓到服务器下发的、带底牌/牌堆的消息，就提醒可能泄露
  updateLeakHint(records);
}

/** 根据是否抓到敏感牌，显示/隐藏泄露提示 */
function updateLeakHint(records) {
  const leaked = records.some(
    (r) =>
      r.direction === DIRECTION.INBOUND &&
      (r.cards || []).some((c) => c.category === 'hole' || c.category === 'deck')
  );
  if (leaked) {
    dom.leakHint.hidden = false;
    dom.leakHint.textContent =
      '⚠️ 检测到服务器向客户端下发了「底牌」或「牌堆/未发牌」类数据。' +
      '若其中包含其他玩家的底牌或未翻开的牌，说明存在信息泄露，应在服务端修复——不该发给客户端的隐藏信息不要下发。';
  } else {
    dom.leakHint.hidden = true;
  }
}

/** 渲染原始消息列表 */
function renderLog(records) {
  // 为性能考虑，只渲染最近 300 条（从新到旧）
  const recent = records.slice(-300).reverse();
  dom.logList.innerHTML = recent.map(renderLogItem).join('');

  // 给每条消息的"展开/折叠"绑定点击
  dom.logList.querySelectorAll('.log-item__payload-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pre = btn.parentElement.parentElement.querySelector('.log-item__payload');
      pre.classList.toggle('open');
    });
  });
}

/** 单条消息的 HTML */
function renderLogItem(r) {
  const isIn = r.direction === DIRECTION.INBOUND;
  const dirTag = isIn
    ? '<span class="tag tag--in">服务器下发</span>'
    : '<span class="tag tag--out">客户端发出</span>';
  const transportTag = `<span class="tag tag--transport">${r.transport}</span>`;
  const time = new Date(r.timestamp).toLocaleTimeString('zh-CN', { hour12: false });

  const cardsHtml = (r.cards || []).length ? `<div class="log-item__cards">${renderChips(r.cards)}</div>` : '';

  return `
    <li class="log-item">
      <div class="log-item__meta">
        ${dirTag}${transportTag}
        <span class="muted">${time}</span>
        <button class="log-item__payload-toggle btn" style="padding:2px 8px;font-size:11px;">展开原文</button>
      </div>
      <div class="log-item__url">${escapeHtml(r.url || '')}</div>
      ${cardsHtml}
      <pre class="log-item__payload">${escapeHtml(safeStringify(r.payload))}</pre>
    </li>`;
}

/** 把一组牌对象渲染成彩色小芯片 */
function renderChips(cards) {
  if (!cards.length) return '<span class="muted">—</span>';
  return cards
    .map(
      (c) =>
        `<span class="chip" style="color:${c.color}">${escapeHtml(c.display)}` +
        `<span class="card-label">${escapeHtml(c.label)}</span></span>`
    )
    .join('');
}

// ============ 工具函数 ============
function safeStringify(v) {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// 防止把抓来的数据当 HTML 执行（安全：避免 XSS 把面板搞乱）
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
