/**
 * 面板逻辑（panel.js）
 * ------------------------------------------------------------
 * 面板只做三件事（职责单一）：
 *   1) 显示托管会话：状态 / 预告 / 最近动作 / 本场统计 —— 数据来自后台（单一数据源），整块重绘。
 *   2) 显示当前牌局：机器人建议 + 牌面 + 胜率 —— 用抓包记录现场算（和托管用的是同一个决策引擎）。
 *   3) 读写配置：开关、档位、打法…… 全部存在 chrome.storage.local（单一配置源），托管控制器读同一份。
 *
 * 数据流（讲人话）：
 *   后台 --port--> 面板：抓包记录（SNAPSHOT / NEW_RECORD）、托管会话（AUTOPILOT_STATE）
 *   面板 --storage--> 托管：配置改了写 storage，托管和后台都在监听，马上生效
 */

import {
  CHANNEL,
  PANEL_MESSAGE,
  EQUITY,
  CONFIG,
  PANEL_UI,
  HAND_CATEGORY_NAMES,
  POKER_ACTION,
  POKER_ACTION_NAMES,
  NEXT_HAND_ACTION,
  AUTOPILOT_STATUS,
  AUTOPILOT_STATUS_LABELS,
  AUTOPILOT_CONFIG_FIELDS,
  OPPONENT_STYLE_OPTIONS,
  DEFAULT_OPPONENT_STYLE,
  AUTO_FALLBACK_STYLE,
  getOpponentStyleLabel,
  STRATEGY_TIERS,
  DEFAULT_STRATEGY_TIER,
  getStrategyTier,
  AGGRESSION_PROFILES,
  getAggressionProfile,
  VALUE_BET_PROFILES,
  getValueBetProfile,
  PREFLOP_ENTRY_PROFILES,
  getPreflopEntryProfile,
} from '../common/constants.js';
import { extractGameState } from '../data/game-state.js';
import { potOdds } from '../data/equity-engine.js';
import { evaluate, handName, detectDraws, parseCard } from '../data/poker-engine.js';
import { buildOpponentModel, resolveOpponentStyle } from '../data/opponent-model.js';
import { decide } from '../data/decision-engine.js';
import {
  escapeHtml,
  actionText,
  actionBadge,
  renderCards,
  winColor,
  formatTime,
  formatDuration,
  formatSigned,
  streetName,
} from './ui-helpers.js';

// ============ 本地状态（集中管理） ============
// 说明：config 是 storage 的"镜像"（只读，改配置一律写 storage，再由监听回填），
//       session 是后台推来的托管会话（只读，整份替换）。
const state = {
  records: [], // 全部抓包记录（来自后台）
  config: Object.fromEntries(AUTOPILOT_CONFIG_FIELDS.map((c) => [c.field, c.fallback])), // 当前配置
  session: null, // 托管会话（后台推来的整份快照）
  computeKey: '', // 上次算过的"局面 + 配置"指纹，相同就不重算
  // —— 派生状态：由 refreshOpponentPicture 统一刷新，别处只读 ——
  effectiveStyle: AUTO_FALLBACK_STYLE, // 此刻实际按哪种对手算（一定是真实风格，不会是 auto）
  opponentResolved: null, // resolveOpponentStyle 的完整结果（来源 / 是否已用上观察结果）
  opponentModel: null, // 边打边记的对手档案
  // —— 纯界面状态 ——
  connected: false, // 是否连着后台
  historyExpanded: false, // 动作历史是否展开全部
  resetArmedUntil: 0, // "重置统计"第一次点击后，在这个时间之前再点一次才真正重置
};

// ============ DOM 引用（集中获取） ============
const $ = (id) => document.getElementById(id);
const dom = {
  conn: $('conn'),
  // 托管状态卡
  hero: $('hero'),
  heroStatus: $('heroStatus'),
  heroDetail: $('heroDetail'),
  plan: $('plan'),
  planBadge: $('planBadge'),
  planReason: $('planReason'),
  // 当前牌局
  empty: $('empty'),
  emptyText: $('emptyText'),
  table: $('table'),
  street: $('street'),
  adviceBadge: $('adviceBadge'),
  adviceReason: $('adviceReason'),
  adviceRange: $('adviceRange'),
  myCards: $('myCards'),
  boardCards: $('boardCards'),
  draws: $('draws'),
  gauge: $('gauge'),
  winValue: $('winValue'),
  win: $('win'),
  tie: $('tie'),
  lose: $('lose'),
  handName: $('handName'),
  opponents: $('opponents'),
  pot: $('pot'),
  toCall: $('toCall'),
  breakeven: $('breakeven'),
  equityNote: $('equityNote'),
  // 本场统计
  resetStats: $('resetStats'),
  statProfit: $('statProfit'),
  statActions: $('statActions'),
  statDuration: $('statDuration'),
  statCounts: $('statCounts'),
  // 最近动作
  history: $('history'),
  historyEmpty: $('historyEmpty'),
  toggleHistory: $('toggleHistory'),
  // 策略设置
  settingsSummary: $('settingsSummary'),
  autopilotEnabled: $('autopilotEnabled'),
  autoNextHand: $('autoNextHand'),
  strategyTier: $('strategyTier'),
  tierDesc: $('tierDesc'),
  preflopEntryProfile: $('preflopEntryProfile'),
  entryDesc: $('entryDesc'),
  aggressionProfile: $('aggressionProfile'),
  aggressionDesc: $('aggressionDesc'),
  valueBetProfile: $('valueBetProfile'),
  valueBetDesc: $('valueBetDesc'),
  opponentStyle: $('opponentStyle'),
  styleDesc: $('styleDesc'),
  oppStatus: $('oppStatus'), // 对手类型下方的一行状态：此刻实际按哪种对手算
};

// 每个配置字段对应哪个控件、控件是开关还是下拉（数据驱动：加配置只改这里 + constants）
const CONFIG_CONTROLS = [
  { field: 'enabled', el: dom.autopilotEnabled, type: 'checkbox' },
  { field: 'autoNextHand', el: dom.autoNextHand, type: 'checkbox' },
  { field: 'tier', el: dom.strategyTier, type: 'select' },
  { field: 'preflopEntryProfile', el: dom.preflopEntryProfile, type: 'select' },
  { field: 'aggressionProfile', el: dom.aggressionProfile, type: 'select' },
  { field: 'valueBetProfile', el: dom.valueBetProfile, type: 'select' },
  { field: 'opponentStyle', el: dom.opponentStyle, type: 'select' },
];

// 只在"档位②·复杂判断"下生效的旋钮：其它档位时置灰，说明文字换成这句提示
const COMPLEX_ONLY_TIER = 'complex';
const COMPLEX_ONLY_HINT = '只在"档位②·复杂判断"下生效。';

// 本场统计里"各动作次数"小标签的显示顺序
const COUNT_CHIPS = [
  { key: POKER_ACTION.FOLD, label: POKER_ACTION_NAMES[POKER_ACTION.FOLD] },
  { key: POKER_ACTION.CHECK, label: POKER_ACTION_NAMES[POKER_ACTION.CHECK] },
  { key: POKER_ACTION.CALL, label: POKER_ACTION_NAMES[POKER_ACTION.CALL] },
  { key: POKER_ACTION.RAISE, label: POKER_ACTION_NAMES[POKER_ACTION.RAISE] },
];

// ============================================================
// 一、配置（storage 是唯一配置源）
// ============================================================

/** 把常量里的选项列表填进下拉框（数据驱动：新增选项只改 constants.js） */
function fillSelect(el, items) {
  el.innerHTML = items
    .map((it) => `<option value="${escapeHtml(it.id)}"${it.available === false ? ' disabled' : ''}>${escapeHtml(it.label)}</option>`)
    .join('');
}

/**
 * 把 storage 里读到的原始值"洗"成合法值（防止存了已下线的档位/选项导致下拉空白）。
 * @param {object} raw {field: value}
 */
function normalizeConfig(raw) {
  const cfg = { ...raw };
  const tier = getStrategyTier(cfg.tier);
  cfg.tier = tier.available ? tier.id : DEFAULT_STRATEGY_TIER;
  cfg.aggressionProfile = getAggressionProfile(cfg.aggressionProfile).id;
  cfg.valueBetProfile = getValueBetProfile(cfg.valueBetProfile).id;
  cfg.preflopEntryProfile = getPreflopEntryProfile(cfg.preflopEntryProfile).id;
  // 对手类型：认识的值（自动识别 / 四种手选）原样保留，不认识的按默认（自动识别）
  if (!OPPONENT_STYLE_OPTIONS.some((s) => s.id === cfg.opponentStyle)) cfg.opponentStyle = DEFAULT_OPPONENT_STYLE;
  cfg.enabled = Boolean(cfg.enabled);
  cfg.autoNextHand = Boolean(cfg.autoNextHand);
  return cfg;
}

/** 写一个配置项到 storage（界面不直接改 state，等 storage 监听回填，保证只有一个真相） */
function writeConfig(field, value) {
  const def = AUTOPILOT_CONFIG_FIELDS.find((c) => c.field === field);
  if (def) chrome.storage.local.set({ [def.key]: value });
}

/** 启动时：读一次全部配置 */
function loadConfig() {
  chrome.storage.local.get(
    AUTOPILOT_CONFIG_FIELDS.map((c) => c.key),
    (saved) => {
      const raw = {};
      for (const { field, key, fallback } of AUTOPILOT_CONFIG_FIELDS) raw[field] = saved[key] ?? fallback;
      applyConfig(raw);
    }
  );
}

/** storage 变化（本面板 / 其它面板改的）都走这里回填 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const raw = { ...state.config };
  let touched = false;
  for (const { field, key, fallback } of AUTOPILOT_CONFIG_FIELDS) {
    if (key in changes) {
      raw[field] = changes[key].newValue ?? fallback;
      touched = true;
    }
  }
  if (touched) applyConfig(raw);
});

/** 配置变了：更新 state → 控件 → 说明文字 → 重算建议 */
function applyConfig(raw) {
  state.config = normalizeConfig(raw);
  renderConfigControls();
  refreshOpponentPicture();
  renderSession(); // 开关变化会影响状态卡的提示文字
  scheduleCompute();
}

/** 把配置值回填到控件上，并刷新各项说明（每个下拉只配自己那一行说明） */
function renderConfigControls() {
  const cfg = state.config;
  for (const { field, el, type } of CONFIG_CONTROLS) {
    if (type === 'checkbox') el.checked = cfg[field];
    else el.value = cfg[field];
  }

  // 档位说明
  dom.tierDesc.textContent = getStrategyTier(cfg.tier).desc;

  // 入池意愿 / 打法倾向 / 大牌下注：只有"复杂判断"档用得上，其它档置灰并提示
  const entry = getPreflopEntryProfile(cfg.preflopEntryProfile);
  const aggression = getAggressionProfile(cfg.aggressionProfile);
  const valueBet = getValueBetProfile(cfg.valueBetProfile);
  const knobsOn = cfg.tier === COMPLEX_ONLY_TIER;
  const complexKnobs = [
    { select: dom.preflopEntryProfile, desc: dom.entryDesc, profile: entry },
    { select: dom.aggressionProfile, desc: dom.aggressionDesc, profile: aggression },
    { select: dom.valueBetProfile, desc: dom.valueBetDesc, profile: valueBet },
  ];
  for (const knob of complexKnobs) {
    knob.select.disabled = !knobsOn;
    knob.desc.textContent = knobsOn ? knob.profile.desc : COMPLEX_ONLY_HINT;
  }

  // 对手类型说明（选项里含"自动识别"）
  const style = OPPONENT_STYLE_OPTIONS.find((s) => s.id === cfg.opponentStyle);
  dom.styleDesc.textContent = style ? style.desc : '';

  // 折叠时也能看到的摘要："复杂判断 · 入池积极 · 均衡 · 标准下注"
  const tierShort = getStrategyTier(cfg.tier).label.replace(/^档位.·/, '').replace(/（.*）$/, '');
  dom.settingsSummary.textContent = knobsOn
    ? `${tierShort} · 入池${entry.label} · ${aggression.label} · ${valueBet.label}下注`
    : tierShort;
}

/** 绑定控件事件：一律只写 storage */
function initConfigControls() {
  fillSelect(dom.strategyTier, STRATEGY_TIERS);
  fillSelect(dom.preflopEntryProfile, PREFLOP_ENTRY_PROFILES);
  fillSelect(dom.aggressionProfile, AGGRESSION_PROFILES);
  fillSelect(dom.valueBetProfile, VALUE_BET_PROFILES);
  fillSelect(dom.opponentStyle, OPPONENT_STYLE_OPTIONS); // 第一项是"自动识别（推荐）"

  for (const { field, el, type } of CONFIG_CONTROLS) {
    el.addEventListener('change', () => writeConfig(field, type === 'checkbox' ? el.checked : el.value));
  }
}

// ============================================================
// 二、对手类型（自动识别 / 手选，和托管共用同一条规则）
// ============================================================

/** 重新判定"此刻按哪种对手计算"，写入派生状态并刷新那一行状态 */
function refreshOpponentPicture() {
  const model = buildOpponentModel(state.records);
  const resolved = resolveOpponentStyle(state.config.opponentStyle, model);
  state.opponentModel = model;
  state.effectiveStyle = resolved.style;
  state.opponentResolved = resolved;
  renderOppStatus(resolved);
}

/**
 * 对手类型下方的一行状态，告诉你"此刻实际按哪种对手在算"：
 *   - 自动识别 + 样本够：已观察 10 手，平均入池率 50%，判断偏「松」→ 按「松」算（绿色）
 *   - 自动识别 + 样本不够：样本偏少（已观察 3 手…）→ 先按「标准」算
 *   - 手选：按你选的「紧」算，机器人不会自动改
 */
function renderOppStatus(resolved) {
  const label = getOpponentStyleLabel(resolved.style);
  const model = resolved.model;
  let text;
  if (resolved.source === 'manual') {
    text = `按你选的「${label}」算，机器人不会自动改。`;
  } else if (resolved.learned) {
    text = `${model.reason}，就按它来算。`; // reason 里已经带了风格名，不再重复
  } else {
    const why = model && model.reason ? model.reason : '还在观察';
    text = `${why} → 先按「${label}」算，观察够了会自动切换。`;
  }
  dom.oppStatus.textContent = text;
  dom.oppStatus.classList.toggle('opp-status--learned', resolved.learned);
}

// ============================================================
// 三、托管会话（状态卡 / 预告 / 统计 / 历史）—— 后台推什么就画什么
// ============================================================

/** 状态卡下方的说明文字：告诉你"现在怎么回事、你该做什么" */
function statusDetail(session) {
  const last = session.history[0];
  switch (session.status) {
    case AUTOPILOT_STATUS.OFF:
      return '打开右侧开关，轮到你时会自动替你出牌。';
    case AUTOPILOT_STATUS.THINKING:
      return '已经想好了，正在模拟真人思考（1~3 秒）后出手。';
    case AUTOPILOT_STATUS.ACTED:
      return last ? `刚才：${actionText(last)}（${formatTime(last.at)}）` : '已出手。';
    case AUTOPILOT_STATUS.SKIPPED:
      return session.detail || '这一步没托管成功，会在下一轮再试。必要时请手动操作。';
    case AUTOPILOT_STATUS.WAITING:
    default:
      return session.detail || '轮到你时会自动出牌。请保持牌桌页面打开。';
  }
}

/** 整块重绘托管会话相关的区域 */
function renderSession() {
  const session = state.session;
  if (!session) return;

  // —— 状态卡 ——
  // 后台的会话状态和开关同步，但面板刚改开关的一瞬间可能还没同步回来：以开关为准，避免闪"已关闭"
  const status = !state.config.enabled ? AUTOPILOT_STATUS.OFF : session.status;
  dom.hero.className = `hero hero--${status}`;
  dom.heroStatus.textContent = AUTOPILOT_STATUS_LABELS[status] || session.statusText;
  dom.heroDetail.textContent = statusDetail({ ...session, status });

  // —— 预告 ——
  const plan = status === AUTOPILOT_STATUS.OFF ? null : session.plan;
  dom.plan.hidden = !plan;
  if (plan) {
    dom.planBadge.innerHTML = actionBadge(plan);
    const eqText = plan.equity != null ? `（胜率 ${plan.equity}%）` : '';
    dom.planReason.textContent = `${plan.reason || ''}${eqText}`;
  }

  renderStats(session.stats);
  renderHistory(session.history);
}

/** 本场统计 */
function renderStats(stats) {
  if (!stats) return;
  const profit = stats.profit;
  dom.statProfit.textContent = profit == null ? '—' : formatSigned(profit);
  dom.statProfit.className = `stats__value${profit > 0 ? ' value--pos' : profit < 0 ? ' value--neg' : ''}`;
  dom.statProfit.title = profit == null
    ? '还拿不到你的筹码数据'
    : `起始 ${stats.startStack} → 最近 ${stats.currentStack}（按每次出手前的筹码估算，中途补码会不准）`;
  dom.statActions.textContent = String(stats.actions || 0);
  dom.statDuration.textContent = formatDuration(Date.now() - (stats.since || Date.now()));

  const chips = COUNT_CHIPS.map((c) => ({ label: c.label, n: stats.counts?.[c.key] || 0 }));
  chips.push({ label: '全下', n: stats.allIns || 0 });
  chips.push({ label: '自动开局', n: stats.nextHands || 0 });
  dom.statCounts.innerHTML = chips
    .map((c) => `<span class="count-chip">${escapeHtml(c.label)}<b>${c.n}</b></span>`)
    .join('');
}

/** 最近动作列表（默认只显示前几条） */
function renderHistory(history) {
  const list = Array.isArray(history) ? history : [];
  dom.historyEmpty.hidden = list.length > 0;
  dom.toggleHistory.hidden = list.length <= PANEL_UI.HISTORY_PREVIEW;
  dom.toggleHistory.textContent = state.historyExpanded ? '收起' : `展开全部（${list.length}）`;

  const shown = state.historyExpanded ? list : list.slice(0, PANEL_UI.HISTORY_PREVIEW);
  dom.history.innerHTML = shown
    .map((item) => {
      // 开局动作没有街道；扑克动作显示"翻牌 · 12:03:05"
      const street = item.action === NEXT_HAND_ACTION || item.street == null ? '' : `${streetName(item.street)} · `;
      const eqText = item.equity != null ? `（胜率 ${item.equity}%）` : '';
      return `<li class="history__item">
        <div class="history__top">${actionBadge(item)}<span class="history__meta">${escapeHtml(street + formatTime(item.at))}</span></div>
        <div class="history__reason">${escapeHtml((item.reason || '') + eqText)}</div>
      </li>`;
    })
    .join('');
}

/** 统计/历史区的按钮 */
function initSessionControls() {
  dom.toggleHistory.addEventListener('click', () => {
    state.historyExpanded = !state.historyExpanded;
    if (state.session) renderHistory(state.session.history);
  });

  // 重置统计：点两次才生效，防止手滑
  dom.resetStats.addEventListener('click', () => {
    const now = Date.now();
    if (now < state.resetArmedUntil) {
      state.resetArmedUntil = 0;
      sendToBackground({ type: PANEL_MESSAGE.RESET_STATS });
      setResetButton(false);
      return;
    }
    state.resetArmedUntil = now + PANEL_UI.CONFIRM_RESET_MS;
    setResetButton(true);
    setTimeout(() => {
      if (Date.now() >= state.resetArmedUntil) setResetButton(false);
    }, PANEL_UI.CONFIRM_RESET_MS);
  });

  // 定时刷新"已托管 xx 分钟"
  setInterval(() => {
    if (state.session) renderStats(state.session.stats);
  }, PANEL_UI.CLOCK_TICK_MS);
}

/** 切换"重置"按钮的确认态 */
function setResetButton(armed) {
  dom.resetStats.textContent = armed ? '再点一次确认' : '重置';
  dom.resetStats.classList.toggle('link-btn--confirm', armed);
}

// ============================================================
// 四、当前牌局：机器人建议 + 胜率（和托管用同一个决策引擎）
// ============================================================

let computeTimer = null;
/** 防抖：牌局数据一秒可能来好几条，安静一会儿再算 */
function scheduleCompute() {
  if (computeTimer) clearTimeout(computeTimer);
  computeTimer = setTimeout(compute, EQUITY.DEBOUNCE_MS);
}

function compute() {
  refreshOpponentPicture(); // 对手画像跨多手统计，每次都刷新

  // 1) 抽出当前局面
  const ctx = extractGameState(state.records);
  if (!ctx.ok) {
    showEmpty(ctx.reason);
    return;
  }

  // 2) 局面和配置都没变就不重算（蒙特卡洛比较费时）
  const cfg = state.config;
  const key = [
    ctx.signature,
    cfg.tier,
    cfg.preflopEntryProfile,
    cfg.aggressionProfile,
    cfg.valueBetProfile,
    state.effectiveStyle,
  ].join('#');
  if (key === state.computeKey) return;
  state.computeKey = key;

  // 3) 跑决策引擎：得到"建议动作 + 胜率"。
  //    和托管走的是同一个函数、同一份配置，所以"面板建议"= 托管轮到你时会做的事。
  const decision = decide(ctx, {
    tier: cfg.tier,
    opponentStyle: cfg.opponentStyle,
    aggressionProfile: cfg.aggressionProfile,
    valueBetProfile: cfg.valueBetProfile,
    preflopEntryProfile: cfg.preflopEntryProfile,
    opponentModel: state.opponentModel,
  });
  if (!decision.ok) {
    showEmpty(decision.reason);
    return;
  }

  renderTable(ctx, decision);
}

/** 没有可显示的牌局 */
function showEmpty(reason) {
  dom.empty.hidden = false;
  dom.table.hidden = true;
  dom.emptyText.textContent = reason || '进入牌桌、拿到你的两张底牌后，这里会显示胜率和建议。';
  state.computeKey = ''; // 清掉指纹，等有数据时能重新触发
}

/** 渲染当前牌局 */
function renderTable(ctx, decision) {
  dom.empty.hidden = true;
  dom.table.hidden = false;

  // —— 机器人建议 ——
  dom.street.textContent = streetName(ctx.board.length);
  dom.adviceBadge.innerHTML = actionBadge(decision, 'act--lg');
  dom.adviceReason.textContent = decision.reason || '';
  dom.adviceRange.hidden = !decision.rangeNote;
  dom.adviceRange.textContent = decision.rangeNote ? `对手范围：${decision.rangeNote}` : '';

  // —— 牌面 ——
  dom.myCards.innerHTML = renderCards(ctx.hole, parseCard);
  dom.boardCards.innerHTML = ctx.board.length
    ? renderCards(ctx.board, parseCard)
    : '<span class="pcard pcard--empty">还没发</span>';
  const draws = detectDraws([...ctx.hole, ...ctx.board]);
  dom.draws.hidden = draws.length === 0;
  dom.draws.innerHTML = draws.map((d) => `<span class="draw-tag">${escapeHtml(d)}</span>`).join('');

  // —— 胜率（用决策引擎算出的那一份，保证和建议口径一致）——
  const eq = decision.equity;
  if (eq) {
    dom.gauge.style.setProperty('--pct', eq.win);
    dom.gauge.style.setProperty('--color', winColor(eq.win));
    dom.winValue.textContent = `${eq.win}%`;
    dom.win.textContent = eq.win;
    dom.tie.textContent = eq.tie;
    dom.lose.textContent = eq.lose;
  } else {
    dom.gauge.style.setProperty('--pct', 0);
    dom.winValue.textContent = '--';
    dom.win.textContent = dom.tie.textContent = dom.lose.textContent = '--';
  }

  // —— 关键数字 ——
  dom.handName.textContent = handName(evaluate([...ctx.hole, ...ctx.board]), HAND_CATEGORY_NAMES);
  dom.opponents.textContent = `${ctx.opponents} 人`;
  dom.pot.textContent = ctx.pot > 0 ? String(ctx.pot) : '—';
  dom.toCall.textContent = ctx.toCall > 0 ? String(ctx.toCall) : '0（可过牌）';
  const odds = potOdds(ctx.pot, ctx.toCall);
  dom.breakeven.textContent = ctx.toCall > 0 && odds.ok ? `跟注回本需胜率 ${odds.breakevenPct}%` : '';

  // —— 胜率怎么来的 ——
  //   你手选 => "你选的"；自动识别且已看够 => "自动识别"；自动识别但样本不够 => "自动识别中"
  const resolved = state.opponentResolved;
  let sourceTag = '你选的';
  if (resolved && resolved.source === 'auto') sourceTag = resolved.learned ? '自动识别' : '自动识别中';
  const samples = eq ? `，${eq.samples.toLocaleString('zh-CN')} 次模拟` : '';
  dom.equityNote.textContent = `按对手「${getOpponentStyleLabel(state.effectiveStyle)}」估算（${sourceTag}${samples}），仅供参考。`;
}

// ============================================================
// 五、和后台的长连接（断了自动重连）
// ============================================================

let port = null;

/** 给后台发消息（没连上就忽略） */
function sendToBackground(msg) {
  try {
    if (port) port.postMessage(msg);
  } catch {
    /* 连接刚断，等重连 */
  }
}

/** 连接状态小圆点 */
function setConnected(ok) {
  state.connected = ok;
  dom.conn.textContent = ok ? '已连接' : '重连中…';
  dom.conn.classList.toggle('conn--ok', ok);
  dom.conn.classList.toggle('conn--off', !ok);
}

/** 建立连接：连上先要一份全量数据；断了（后台被浏览器休眠）稍后重连 */
function connect() {
  try {
    port = chrome.runtime.connect({ name: CHANNEL.PORT_NAME });
  } catch {
    setConnected(false);
    setTimeout(connect, PANEL_UI.RECONNECT_MS);
    return;
  }
  setConnected(true);
  port.onMessage.addListener(onBackgroundMessage);
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError; // 读一下，避免控制台报"未处理的错误"
    port = null;
    setConnected(false);
    setTimeout(connect, PANEL_UI.RECONNECT_MS);
  });
  port.postMessage({ type: PANEL_MESSAGE.GET_SNAPSHOT });
}

/** 处理后台推来的消息 */
function onBackgroundMessage(msg) {
  if (!msg) return;
  switch (msg.type) {
    case PANEL_MESSAGE.SNAPSHOT:
      state.records = msg.records || []; // 全量：直接替换
      state.computeKey = '';
      scheduleCompute();
      break;
    case PANEL_MESSAGE.NEW_RECORD:
      state.records.push(msg.record); // 增量：追加一条
      // 和后台一样只留最近 N 条，防止面板开久了内存越涨越多
      if (state.records.length > CONFIG.MAX_MESSAGES) state.records.shift();
      scheduleCompute();
      break;
    case PANEL_MESSAGE.AUTOPILOT_STATE:
      state.session = msg.session; // 托管会话：整份替换后重绘
      renderSession();
      break;
    default:
      break;
  }
}

// ============ 启动 ============
initConfigControls();
initSessionControls();
loadConfig();
connect();
