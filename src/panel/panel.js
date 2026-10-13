/**
 * 面板逻辑（panel.js）—— 纯胜率展示
 * ------------------------------------------------------------
 * 职责（单一、简单）：
 *   1) 和后台保持长连接，拿到抓包数据（唯一数据源）。
 *   2) 从数据里抽出"当前这手牌"的局面，算出胜率。
 *   3) 把牌面、胜率圆环、牌型、听牌展示出来。
 *
 * 状态管理原则：
 *   - records 是唯一数据源；局面一变（指纹变化）才重算，避免重复计算和界面乱跳。
 */

import {
  CHANNEL,
  PANEL_MESSAGE,
  EQUITY,
  HAND_CATEGORY_NAMES,
  SUITS,
  OPPONENT_STYLES,
  DEFAULT_OPPONENT_STYLE,
  getOpponentPercent,
  STRATEGY_TIERS,
  DEFAULT_STRATEGY_TIER,
  getStrategyTier,
  AUTOPILOT,
  STORAGE_KEYS,
} from '../common/constants.js';
import { extractGameState } from '../data/game-state.js';
import { simulateEquity } from '../data/equity-engine.js';
import { evaluate, handName, detectDraws, parseCard } from '../data/poker-engine.js';

// ============ 本地状态 ============
const state = {
  records: [], // 全部抓包消息（唯一数据源）
  signature: '', // 上次算过的"局面指纹"，相同则跳过重算
  opponentStyle: DEFAULT_OPPONENT_STYLE, // 当前选中的对手风格 id（影响胜率高低）
};

// ============ DOM 引用（集中获取） ============
const dom = {
  status: document.getElementById('status'),
  opponentStyle: document.getElementById('opponentStyle'), // 对手风格下拉框
  styleDesc: document.getElementById('styleDesc'), // 风格说明文字
  // —— 自动托管相关 ——
  autopilotEnabled: document.getElementById('autopilotEnabled'), // 托管开关
  strategyTier: document.getElementById('strategyTier'), // 策略档位下拉
  tierDesc: document.getElementById('tierDesc'), // 档位说明
  lastAction: document.getElementById('lastAction'), // 最近动作容器
  lastActionBadge: document.getElementById('lastActionBadge'), // 动作徽标（跟注/弃牌…）
  lastActionReason: document.getElementById('lastActionReason'), // 动作理由
  empty: document.getElementById('empty'),
  body: document.getElementById('body'),
  myCards: document.getElementById('myCards'),
  boardCards: document.getElementById('boardCards'),
  gauge: document.getElementById('gauge'),
  winValue: document.getElementById('winValue'),
  win: document.getElementById('win'),
  tie: document.getElementById('tie'),
  lose: document.getElementById('lose'),
  handName: document.getElementById('handName'),
  opponents: document.getElementById('opponents'),
  draws: document.getElementById('draws'),
  samples: document.getElementById('samples'),
  noteStyle: document.getElementById('noteStyle'), // 底部说明里的"按xx牌力估算"
};

// ============ 对手风格下拉框：初始化 + 切换时重算 ============
// 为什么单独抽出来：这是一块独立的 UI 交互逻辑，和"抓包→算胜率"解耦，便于维护。
function initStyleSelector() {
  // 1) 用常量里的风格列表动态生成下拉项（数据驱动，新增风格只改 constants.js）
  dom.opponentStyle.innerHTML = OPPONENT_STYLES.map(
    (s) => `<option value="${s.id}">${s.label}</option>`
  ).join('');
  dom.opponentStyle.value = state.opponentStyle;
  updateStyleDesc();

  // 2) 用户切换风格：更新状态 + 清指纹强制重算（因为同一局面、不同风格结果不同）
  dom.opponentStyle.addEventListener('change', () => {
    state.opponentStyle = dom.opponentStyle.value;
    state.signature = ''; // 关键：清掉指纹，否则局面没变会被"去重"跳过，看不到变化
    // 同步写入 storage：托管决策（后台）也要用同一个对手风格，保证"面板显示"和"托管决策"一致。
    chrome.storage.local.set({ [STORAGE_KEYS.OPPONENT_STYLE]: state.opponentStyle });
    updateStyleDesc();
    scheduleCompute();
  });
}

// 把当前选中风格的说明文字显示到选择条右侧
function updateStyleDesc() {
  const cur = OPPONENT_STYLES.find((s) => s.id === state.opponentStyle);
  dom.styleDesc.textContent = cur ? cur.desc : '';
}

// ============ 自动托管：开关 + 档位配置（独立 UI 块，和胜率展示解耦） ============
// 数据流：面板写 chrome.storage.local → 内容世界的控制器读 storage 执行托管。
//   storage 是"单一数据源"，面板和托管永远看同一份配置，不会打架。
function initAutopilot() {
  // 1) 用常量里的档位列表动态生成下拉项（数据驱动，加档位只改 constants.js）。
  dom.strategyTier.innerHTML = STRATEGY_TIERS.map(
    (t) => `<option value="${t.id}">${t.label}</option>`
  ).join('');

  // 2) 从 storage 读回上次的配置，回填到界面（没存过就用默认值）。
  chrome.storage.local.get(
    [
      STORAGE_KEYS.AUTOPILOT_ENABLED,
      STORAGE_KEYS.STRATEGY_TIER,
      STORAGE_KEYS.OPPONENT_STYLE,
    ],
    (cfg) => {
      const enabled = cfg[STORAGE_KEYS.AUTOPILOT_ENABLED] ?? AUTOPILOT.DEFAULT_ENABLED;
      const tier = cfg[STORAGE_KEYS.STRATEGY_TIER] ?? DEFAULT_STRATEGY_TIER;
      const style = cfg[STORAGE_KEYS.OPPONENT_STYLE] ?? DEFAULT_OPPONENT_STYLE;

      dom.autopilotEnabled.checked = Boolean(enabled);
      dom.strategyTier.value = tier;
      updateTierDesc();

      // 对手风格也从 storage 同步回来，保证一打开面板就和托管用的是同一个值。
      state.opponentStyle = style;
      dom.opponentStyle.value = style;
      updateStyleDesc();
    }
  );

  // 3) 开关：用户一拨动就写入 storage（控制器监听 storage 变化会立即启停）。
  dom.autopilotEnabled.addEventListener('change', () => {
    chrome.storage.local.set({
      [STORAGE_KEYS.AUTOPILOT_ENABLED]: dom.autopilotEnabled.checked,
    });
  });

  // 4) 档位切换：写 storage + 刷新说明文字。
  dom.strategyTier.addEventListener('change', () => {
    chrome.storage.local.set({ [STORAGE_KEYS.STRATEGY_TIER]: dom.strategyTier.value });
    updateTierDesc();
  });
}

// 把当前选中档位的说明文字显示到下拉框下方
function updateTierDesc() {
  const cur = getStrategyTier(dom.strategyTier.value);
  dom.tierDesc.textContent = cur ? cur.desc : '';
}

// 显示"最近一次托管动作"（由后台转发 AUTOPILOT_ACTION 过来）
function showLastAction(acted) {
  if (!acted) return;
  dom.lastAction.hidden = false;
  const eqText = acted.equity != null ? `（胜率 ${acted.equity}%）` : '';
  dom.lastActionBadge.textContent = acted.label || acted.action || '动作';
  dom.lastActionReason.textContent = `${acted.reason || ''}${eqText}`;
}

// ============ 启动：先把对手风格下拉框建好 ============
initStyleSelector();
initAutopilot(); // 再把"自动托管"控制区建好并回填上次配置

// ============ 与后台建立长连接 ============
const port = chrome.runtime.connect({ name: CHANNEL.PORT_NAME });
port.postMessage({ type: PANEL_MESSAGE.GET_SNAPSHOT }); // 打开面板先要一份全量数据

port.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === PANEL_MESSAGE.SNAPSHOT) {
    state.records = msg.records || []; // 全量快照：直接替换
    scheduleCompute();
  } else if (msg.type === PANEL_MESSAGE.NEW_RECORD) {
    state.records.push(msg.record); // 增量：追加一条
    scheduleCompute();
  } else if (msg.type === PANEL_MESSAGE.AUTOPILOT_ACTION) {
    showLastAction(msg.acted); // 托管刚执行了一个动作，显示出来
  }
});

// ============ 胜率计算（防抖 + 指纹去重） ============
// 牌局状态一秒可能更新好几次，没必要每次都算：
//   - 防抖：安静一会儿再算，避免频繁计算。
//   - 指纹：牌面没变就直接跳过。
let timer = null;
function scheduleCompute() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(compute, EQUITY.DEBOUNCE_MS);
}

function compute() {
  // 1) 从抓包数据里抽出当前局面（数据层负责认字段、容错）
  const ctx = extractGameState(state.records);
  if (!ctx.ok) {
    showEmpty(ctx.reason);
    return;
  }

  // 2) 局面没变就不重复算
  if (ctx.signature === state.signature) return;
  state.signature = ctx.signature;

  // 3) 算胜率（蒙特卡洛模拟）
  //    opponentPercent：按当前"对手风格"假设对手只玩多强的牌，范围越窄你的胜率越低、越真实。
  const eq = simulateEquity({
    hole: ctx.hole,
    board: ctx.board,
    opponents: ctx.opponents,
    opponentPercent: getOpponentPercent(state.opponentStyle),
  });
  if (!eq.ok) {
    showEmpty(eq.reason);
    return;
  }

  // 4) 渲染
  render(ctx, eq);
}

// ============ 渲染 ============
function showEmpty(reason) {
  dom.empty.hidden = false;
  dom.body.hidden = true;
  dom.status.textContent = reason || '等待牌局…';
  state.signature = ''; // 清掉指纹，等有数据时能重新触发
}

function render(ctx, eq) {
  dom.empty.hidden = true;
  dom.body.hidden = false;
  dom.status.textContent = '实时计算';

  // —— 牌面 ——
  dom.myCards.innerHTML = renderCards(ctx.hole);
  dom.boardCards.innerHTML = ctx.board.length ? renderCards(ctx.board) : '<span class="card card--empty">待发</span>';

  // —— 胜率圆环（颜色随高低变化：高=绿，中=黄，低=红）——
  dom.gauge.style.setProperty('--pct', eq.win);
  dom.gauge.style.setProperty('--color', winColor(eq.win));
  dom.winValue.textContent = `${eq.win}%`;
  dom.win.textContent = eq.win;
  dom.tie.textContent = eq.tie;
  dom.lose.textContent = eq.lose;
  dom.samples.textContent = eq.samples.toLocaleString('zh-CN');

  // —— 底部说明：按当前对手风格实时更新文案（让你知道这个数字的前提）——
  const curStyle = OPPONENT_STYLES.find((s) => s.id === state.opponentStyle);
  dom.noteStyle.textContent = curStyle ? `按"对手${curStyle.label}"估算` : '估算';

  // —— 当前牌型 ——
  const made = evaluate([...ctx.hole, ...ctx.board]);
  dom.handName.textContent = handName(made, HAND_CATEGORY_NAMES);

  // —— 对手人数 ——
  dom.opponents.textContent = `${ctx.opponents} 人`;

  // —— 听牌提示 ——
  const draws = detectDraws([...ctx.hole, ...ctx.board]);
  if (draws.length) {
    dom.draws.hidden = false;
    dom.draws.innerHTML = draws.map((d) => `<span class="draw-tag">${escapeHtml(d)}</span>`).join('');
  } else {
    dom.draws.hidden = true;
    dom.draws.innerHTML = '';
  }
}

/** 把牌字符串数组（如 ["9h","8d"]）渲染成白色扑克牌小块 */
function renderCards(cards) {
  return cards
    .map((raw) => {
      const c = parseCard(raw);
      if (!c) return '';
      const meta = SUITS[c.s] || { symbol: '?', color: '#222' };
      // 点数转成好看的显示（11->J，14->A，10 保持 10）
      const rankChar = displayRank(c.r);
      return `<span class="card" style="color:${meta.color}">${rankChar}${meta.symbol}</span>`;
    })
    .join('');
}

// 把点数数字转成显示字符：11->J 12->Q 13->K 14->A 10->10 其余原样
function displayRank(r) {
  const map = { 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
  return map[r] || String(r);
}

// 胜率配色：>=60% 绿、>=35% 黄、否则红
function winColor(win) {
  if (win >= 60) return '#3ddc84';
  if (win >= 35) return '#ffc857';
  return '#ff6b6b';
}

// 防 XSS：把抓来的数据里的尖括号转义
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
