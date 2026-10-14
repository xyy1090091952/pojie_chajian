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
  AGGRESSION_PROFILES,
  DEFAULT_AGGRESSION_PROFILE,
  getAggressionProfile,
  VALUE_BET_PROFILES,
  DEFAULT_VALUE_BET_PROFILE,
  getValueBetProfile,
  AUTOPILOT,
  STORAGE_KEYS,
} from '../common/constants.js';
import { extractGameState } from '../data/game-state.js';
import { simulateEquity } from '../data/equity-engine.js';
import { evaluate, handName, detectDraws, parseCard } from '../data/poker-engine.js';
import { buildOpponentModel, resolveOpponentStyle } from '../data/opponent-model.js';

// ============ 本地状态 ============
const state = {
  records: [], // 全部抓包消息（唯一数据源）
  signature: '', // 上次算过的"局面指纹"，相同则跳过重算
  opponentStyle: DEFAULT_OPPONENT_STYLE, // 你手选的对手风格 id（下拉框的值）
  // —— 下面三个是"算出来的派生状态"，由 refreshOpponentPicture 统一刷新，别处只读不写 ——
  opponentModel: null, // 边打边记的最新档案（可能 null/不可靠）
  effectiveStyle: DEFAULT_OPPONENT_STYLE, // 最终生效的风格（喂给胜率）：手选 or 自动接管
  pictureSource: 'manual', // 生效风格来源：'manual'=你手选 / 'auto'=机器人观察接管
};

// ============ DOM 引用（集中获取） ============
const dom = {
  status: document.getElementById('status'),
  opponentStyle: document.getElementById('opponentStyle'), // 对手风格下拉框
  styleDesc: document.getElementById('styleDesc'), // 风格说明文字
  // —— 自动托管相关 ——
  autopilotEnabled: document.getElementById('autopilotEnabled'), // 托管开关
  autoNextHand: document.getElementById('autoNextHand'), // 房主：自动开始下一手开关
  strategyTier: document.getElementById('strategyTier'), // 策略档位下拉
  tierDesc: document.getElementById('tierDesc'), // 档位说明
  aggressionProfile: document.getElementById('aggressionProfile'), // 整体打法倾向
  valueBetProfile: document.getElementById('valueBetProfile'), // 大牌价值下注力度
  profileDesc: document.getElementById('profileDesc'), // 两项策略旋钮的说明
  lastAction: document.getElementById('lastAction'), // 最近动作容器
  lastActionBadge: document.getElementById('lastActionBadge'), // 动作徽标（跟注/弃牌…）
  lastActionReason: document.getElementById('lastActionReason'), // 动作理由
  nextPlan: document.getElementById('nextPlan'), // "接下来打算做"预告容器
  nextPlanBadge: document.getElementById('nextPlanBadge'), // 预告徽标
  nextPlanReason: document.getElementById('nextPlanReason'), // 预告理由
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
  // —— 对手画像状态卡（手选 + 边打边记 的统一展示） ——
  oppmodelBody: document.getElementById('oppmodelBody'), // 档案详情（观察手数/入池率/原因）
  pictureSource: document.getElementById('pictureSource'), // 来源徽标：你手选 / 机器人接管
  pictureStyle: document.getElementById('pictureStyle'), // 当前生效风格名（大字）
  pictureHint: document.getElementById('pictureHint'), // 一句话解释 + 怎么改回来
  pictureReset: document.getElementById('pictureReset'), // "改回自动"快捷按钮（仅手选时显示）
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
    refreshOpponentPicture(); // 重新判定"生效画像"并刷新状态卡
    scheduleCompute();
  });

  // 3) “改回自动”按钮：把下拉还原成默认档，等于把判断权交还给机器人（边打边记）。
  //    复用下拉的 change 处理：直接改 value 再手动触发一次，逻辑不重复。
  dom.pictureReset.addEventListener('click', () => {
    dom.opponentStyle.value = DEFAULT_OPPONENT_STYLE;
    dom.opponentStyle.dispatchEvent(new Event('change')); // 复用上面那套状态同步
  });
}

// 把当前选中风格的说明文字显示到选择条右侧
function updateStyleDesc() {
  const cur = OPPONENT_STYLES.find((s) => s.id === state.opponentStyle);
  dom.styleDesc.textContent = cur ? cur.desc : '';
}

// 小工具：按风格 id 取中文名（查不到就原样返回 id，保证不崩）。
function styleLabel(styleId) {
  const found = OPPONENT_STYLES.find((s) => s.id === styleId);
  return found ? found.label : styleId;
}

// ============ 自动托管：开关 + 档位配置（独立 UI 块，和胜率展示解耦） ============
// 数据流：面板写 chrome.storage.local → 内容世界的控制器读 storage 执行托管。
//   storage 是"单一数据源"，面板和托管永远看同一份配置，不会打架。
function initAutopilot() {
  // 1) 用常量里的档位列表动态生成下拉项（数据驱动，加档位只改 constants.js）。
  //    available=false 的档位（还没开发完）加 disabled，让它置灰、选不中。
  dom.strategyTier.innerHTML = STRATEGY_TIERS.map(
    (t) => `<option value="${t.id}"${t.available ? '' : ' disabled'}>${t.label}</option>`
  ).join('');
  dom.aggressionProfile.innerHTML = AGGRESSION_PROFILES.map(
    (profile) => `<option value="${profile.id}">${profile.label}</option>`
  ).join('');
  dom.valueBetProfile.innerHTML = VALUE_BET_PROFILES.map(
    (profile) => `<option value="${profile.id}">${profile.label}</option>`
  ).join('');

  // 2) 从 storage 读回上次的配置，回填到界面（没存过就用默认值）。
  chrome.storage.local.get(
    [
      STORAGE_KEYS.AUTOPILOT_ENABLED,
      STORAGE_KEYS.STRATEGY_TIER,
      STORAGE_KEYS.OPPONENT_STYLE,
      STORAGE_KEYS.AGGRESSION_PROFILE,
      STORAGE_KEYS.VALUE_BET_PROFILE,
      STORAGE_KEYS.AUTO_NEXT_HAND,
    ],
    (cfg) => {
      const enabled = cfg[STORAGE_KEYS.AUTOPILOT_ENABLED] ?? AUTOPILOT.DEFAULT_ENABLED;
      const style = cfg[STORAGE_KEYS.OPPONENT_STYLE] ?? DEFAULT_OPPONENT_STYLE;
      // 自动开始下一手：没存过时用常量默认值（默认开，受总开关管辖所以安全）。
      const autoNext = cfg[STORAGE_KEYS.AUTO_NEXT_HAND] ?? AUTOPILOT.AUTO_NEXT_HAND;

      // 档位：若存的是"不可用"的档（如 ②③还没开发），回退到默认档，避免下拉空白。
      let tier = cfg[STORAGE_KEYS.STRATEGY_TIER] ?? DEFAULT_STRATEGY_TIER;
      const tierConf = getStrategyTier(tier);
      if (!tierConf.available) tier = DEFAULT_STRATEGY_TIER;
      const aggression = getAggressionProfile(
        cfg[STORAGE_KEYS.AGGRESSION_PROFILE] ?? DEFAULT_AGGRESSION_PROFILE
      ).id;
      const valueBet = getValueBetProfile(
        cfg[STORAGE_KEYS.VALUE_BET_PROFILE] ?? DEFAULT_VALUE_BET_PROFILE
      ).id;

      dom.autopilotEnabled.checked = Boolean(enabled);
      dom.autoNextHand.checked = Boolean(autoNext);
      dom.strategyTier.value = tier;
      dom.aggressionProfile.value = aggression;
      dom.valueBetProfile.value = valueBet;
      updateTierDesc();
      updateProfileDesc();

      // 对手风格也从 storage 同步回来，保证一打开面板就和托管用的是同一个值。
      state.opponentStyle = style;
      dom.opponentStyle.value = style;
      updateStyleDesc();
      refreshOpponentPicture(); // 回填后立刻刷新状态卡，保证初始展示就正确
    }
  );

  // 3) 开关：用户一拨动就写入 storage（控制器监听 storage 变化会立即启停）。
  dom.autopilotEnabled.addEventListener('change', () => {
    chrome.storage.local.set({
      [STORAGE_KEYS.AUTOPILOT_ENABLED]: dom.autopilotEnabled.checked,
    });
  });

  // 3.1) 「自动开始下一手」开关：同样写 storage，控制器会实时读到新值。
  //      它只在托管总开关也打开时才真正生效（控制器里有判断）。
  dom.autoNextHand.addEventListener('change', () => {
    chrome.storage.local.set({
      [STORAGE_KEYS.AUTO_NEXT_HAND]: dom.autoNextHand.checked,
    });
  });

  // 4) 档位切换：写 storage + 刷新说明文字。
  dom.strategyTier.addEventListener('change', () => {
    chrome.storage.local.set({ [STORAGE_KEYS.STRATEGY_TIER]: dom.strategyTier.value });
    updateTierDesc();
    updateProfileDesc();
  });

  // 5) 两个策略旋钮分别持久化；控制器监听 storage 后会在下一次决策立即生效。
  dom.aggressionProfile.addEventListener('change', () => {
    chrome.storage.local.set({
      [STORAGE_KEYS.AGGRESSION_PROFILE]: dom.aggressionProfile.value,
    });
    updateProfileDesc();
  });

  dom.valueBetProfile.addEventListener('change', () => {
    chrome.storage.local.set({
      [STORAGE_KEYS.VALUE_BET_PROFILE]: dom.valueBetProfile.value,
    });
    updateProfileDesc();
  });
}

// 把当前选中档位的说明文字显示到下拉框下方
function updateTierDesc() {
  const cur = getStrategyTier(dom.strategyTier.value);
  dom.tierDesc.textContent = cur ? cur.desc : '';
}

// 两个旋钮放在同一段说明里，用户能同时看到“是否更敢打”和“大牌打多大”。
function updateProfileDesc() {
  const aggression = getAggressionProfile(dom.aggressionProfile.value);
  const valueBet = getValueBetProfile(dom.valueBetProfile.value);
  const enabled = dom.strategyTier.value === 'complex';
  dom.aggressionProfile.disabled = !enabled;
  dom.valueBetProfile.disabled = !enabled;
  dom.profileDesc.textContent = enabled
    ? `${aggression.desc} ${valueBet.desc}`
    : '这两项只在“档位②·复杂判断”下生效。';
}

// 把动作整理成一句"人话徽标"：加注/下注带上金额，其余只显示动作名。
//   例："加注 → 加注 40"、"跟注 → 跟注 20"、"弃牌 → 弃牌"。
//   预告和最近动作共用这套口径，保证两处显示一致（数据一致性）。
function formatActionBadge(info) {
  const name = info.label || info.action || '动作';
  // 只有加注/下注这类"要花钱"的动作才拼金额；金额为 0 或缺失就不拼。
  const amt = Number(info.amount) || 0;
  const isBet = info.action === 'raise' || info.action === 'call';
  if (isBet && amt > 0) return `${name} ${amt}`;
  return name;
}

// 显示"接下来打算做什么"（动手之前的预告，由后台转发 AUTOPILOT_PLAN 过来）。
//   这是在真正点击之前显示的——此时机器人正处于拟人延迟(1.2~3.5 秒)里，
//   你看到后如果不认同，还来得及自己接管操作。
function showNextPlan(plan) {
  if (!plan) return;
  dom.nextPlan.hidden = false;
  const eqText = plan.equity != null ? `（胜率 ${plan.equity}%）` : '';
  dom.nextPlanBadge.textContent = formatActionBadge(plan);
  dom.nextPlanReason.textContent = `准备${plan.reason || '执行此动作'}${eqText}`;
}

// 显示"最近一次托管动作"（由后台转发 AUTOPILOT_ACTION 过来）
function showLastAction(acted) {
  if (!acted) return;
  // 动作真正落地了 => 预告使命完成，隐藏预告区，避免"接下来"和"最近"重复刷屏。
  dom.nextPlan.hidden = true;
  dom.lastAction.hidden = false;
  const eqText = acted.equity != null ? `（胜率 ${acted.equity}%）` : '';
  dom.lastActionBadge.textContent = formatActionBadge(acted);
  dom.lastActionReason.textContent = `${acted.reason || ''}${eqText}`;
}

// ============ 对手画像状态卡：手选 + 边打边记 的统一展示 ============
// 为什么合并（讲人话）：
//   "你手选的画像"和"机器人边打边记学到的画像"本是同一件事的两种来源，
//   以前分两块显示，用户看不出谁在生效、也不知道去哪改。现在收成一张状态卡：
//     1) 用共享函数 resolveOpponentStyle 算出"此刻真正生效的是哪个画像、来自哪里"；
//     2) 把结果写进 state（派生状态单一来源），胜率计算直接复用，保证面板=托管；
//     3) 卡片顶部用徽标点明来源（你手选 / 机器人接管），并给出"改回来"的入口。
//
// 注意：这里只负责"刷新状态 + 渲染"，不触发胜率重算（由调用方决定），职责单一。
function refreshOpponentPicture() {
  // 1) 跑一遍边打边记（跨多手统计，和当前这手是否 ok 无关）。
  const model = buildOpponentModel(state.records);
  // 2) 用和托管【完全相同】的规则，算出最终生效的风格与来源（唯一真相）。
  const resolved = resolveOpponentStyle(state.opponentStyle, model);

  // 3) 写回派生状态：后续算胜率只认 effectiveStyle，彻底消除"面板和托管对不上"。
  state.opponentModel = model;
  state.effectiveStyle = resolved.style;
  state.pictureSource = resolved.source;

  renderPictureCard(resolved);
}

// 把"生效画像"的结论渲染成状态卡（纯展示，数据来自 refreshOpponentPicture 的结论）。
function renderPictureCard(resolved) {
  const isAuto = resolved.source === 'auto';
  const model = resolved.model;

  // —— 顶部徽标：一眼看出现在听谁的 ——
  dom.pictureSource.textContent = isAuto ? '机器人接管' : '你手选';
  dom.pictureSource.classList.toggle('picture__source--auto', isAuto);

  // —— 中间大字：当前真正生效的风格名 ——
  dom.pictureStyle.textContent = styleLabel(resolved.style);

  // —— 一句话解释：说清"为什么是它"，并指明怎么改 ——
  if (isAuto) {
    // 机器人接管：说明它观察了多少手、怎么判的；并告诉用户想接管就手动改下拉。
    dom.pictureHint.textContent =
      `机器人已观察够样本，自动按此画像计算。想自己定？在上方“对手牌力”里手动选即可。`;
  } else if (state.opponentStyle === DEFAULT_OPPONENT_STYLE) {
    // 手选=默认档，但自动还没接管：解释差多少手、现在先用默认。
    dom.pictureHint.textContent = model && model.reason
      ? `${model.reason}；暂按你选的「${styleLabel(resolved.style)}」计算。`
      : `样本积累中，暂按你选的「${styleLabel(resolved.style)}」计算。`;
  } else {
    // 手选=非默认档：机器人完全不插手，尊重你的选择。
    dom.pictureHint.textContent =
      `已尊重你手选的「${styleLabel(resolved.style)}」，机器人不自动接管。想交还机器人？点右侧“改回自动”。`;
  }

  // —— “改回自动”按钮：只有你手选了非默认档时才有意义（给个一键还原的入口）——
  const canReset = !isAuto && state.opponentStyle !== DEFAULT_OPPONENT_STYLE;
  dom.pictureReset.hidden = !canReset;

  // —— 详情行：边打边记的原始观察（观察手数/入池率/原因），没有就留观察中 ——
  dom.oppmodelBody.textContent = (model && model.reason) || '观察中…';
  dom.oppmodelBody.classList.toggle('oppmodel__body--active', isAuto);
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
  } else if (msg.type === PANEL_MESSAGE.AUTOPILOT_PLAN) {
    showNextPlan(msg.plan); // 托管"接下来打算做"的预告（动手之前）
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
  // 0) 先刷新"对手画像状态卡"：算出此刻真正生效的画像与来源（写入 state.effectiveStyle）。
  //    放最前、无条件执行：它跨多手统计，和当前这手是否 ok 无关。
  refreshOpponentPicture();

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
  //    opponentPercent：按【当前真正生效的画像】假设对手只玩多强的牌。
  //    关键：这里用 state.effectiveStyle（可能是你手选的，也可能是机器人接管的），
  //    和托管决策引擎走的是同一条规则，保证"面板看到的胜率"="机器人用的胜率"。
  const eq = simulateEquity({
    hole: ctx.hole,
    board: ctx.board,
    opponents: ctx.opponents,
    opponentPercent: getOpponentPercent(state.effectiveStyle),
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

  // —— 底部说明：按【当前真正生效的画像】更新文案，并标出来源（手选/机器人接管）——
  //    用 effectiveStyle 而非手选值，保证这句说明和上面的胜率数字口径一致。
  const effLabel = styleLabel(state.effectiveStyle);
  const sourceTag = state.pictureSource === 'auto' ? '机器人接管' : '你手选';
  dom.noteStyle.textContent = `按"对手${effLabel}"估算（${sourceTag}）`;

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
