/**
 * 数据层：「托管会话」（状态 / 预告 / 动作历史 / 本场统计）
 * ------------------------------------------------------------
 * 讲人话：面板顶部要显示"托管在干嘛"、"接下来打算怎么做"、"最近做了什么"、"本场赢了多少"。
 *   这些信息来自内容脚本的零散上报，如果让面板自己东拼西凑，很容易对不上。
 *   所以统一放在后台这一个对象里维护，每次变化就把【整份快照】推给面板重绘——
 *   面板永远只显示后台这一份数据（单一数据源），开几个面板看到的都一样。
 *
 * 这里只有纯数据操作（不碰 chrome API），后台负责持久化和广播，便于单独测试。
 */

import {
  AUTOPILOT_STATUS,
  AUTOPILOT_STATUS_LABELS,
  AUTOPILOT_HISTORY_LIMIT,
  POKER_ACTION,
} from '../common/constants.js';

/** 一份全新的统计（重置统计时也用它） */
function createStats() {
  return {
    since: Date.now(), // 统计开始时间
    actions: 0, // 托管出手次数（不含"开始下一手"）
    counts: {
      [POKER_ACTION.FOLD]: 0,
      [POKER_ACTION.CHECK]: 0,
      [POKER_ACTION.CALL]: 0,
      [POKER_ACTION.RAISE]: 0,
    },
    allIns: 0, // 全下次数
    nextHands: 0, // 自动开始下一手次数
    startStack: null, // 第一次出手时的筹码（拿不到筹码数据时为 null）
    currentStack: null, // 最近一次出手时的筹码
    profit: null, // 盈亏 = 最近筹码 - 起始筹码（拿不到为 null）
  };
}

/** 新建一个托管会话 */
export function createSession() {
  return {
    status: AUTOPILOT_STATUS.OFF,
    statusText: AUTOPILOT_STATUS_LABELS[AUTOPILOT_STATUS.OFF],
    detail: '', // 状态补充说明（如"跳过"的原因）
    updatedAt: Date.now(),
    plan: null, // 预告：决策已出、还没点
    history: [], // 最近动作（新的在前）
    stats: createStats(),
  };
}

/**
 * 更新运行状态。
 * @param {object} session
 * @param {{status:string, detail?:string, at?:number}} msg
 */
export function applyStatus(session, msg) {
  const status = Object.values(AUTOPILOT_STATUS).includes(msg.status) ? msg.status : AUTOPILOT_STATUS.WAITING;
  session.status = status;
  session.statusText = AUTOPILOT_STATUS_LABELS[status];
  session.detail = msg.detail || '';
  session.updatedAt = msg.at || Date.now();
  if (status === AUTOPILOT_STATUS.OFF) session.plan = null; // 关了就没有预告
  return session;
}

/** 更新预告（传 null 清空） */
export function applyPlan(session, plan) {
  session.plan = plan || null;
  return session;
}

/**
 * 记录一次真正执行的动作：进历史 + 进统计。
 * @param {object} session
 * @param {object} acted controller 上报的动作 {action, label, amount, allIn, reason, stack, at, ...}
 */
export function applyActed(session, acted) {
  if (!acted) return session;
  session.history.unshift(acted);
  if (session.history.length > AUTOPILOT_HISTORY_LIMIT) {
    session.history.length = AUTOPILOT_HISTORY_LIMIT;
  }

  const stats = session.stats;
  if (acted.action in stats.counts) {
    stats.actions += 1;
    stats.counts[acted.action] += 1;
    if (acted.allIn) stats.allIns += 1;
  } else {
    stats.nextHands += 1; // 非扑克动作：目前只有"开始下一手"
  }

  // 盈亏：用"出手前的剩余筹码"推算（只在拿得到筹码数据时）。
  //   注意：中途买入/补码会让这个数不准，面板会提示"仅供参考"。
  const stack = Number(acted.stack);
  if (Number.isFinite(stack) && stack > 0) {
    if (stats.startStack == null) stats.startStack = stack;
    stats.currentStack = stack;
    stats.profit = stats.currentStack - stats.startStack;
  }
  return session;
}

/** 清空本场统计和历史（状态和预告保留） */
export function resetStats(session) {
  session.history = [];
  session.stats = createStats();
  return session;
}

/**
 * 从持久化数据恢复会话（后台被浏览器休眠后重启时用）。字段缺失就用默认值补齐。
 * @param {object} saved
 */
export function restoreSession(saved) {
  const fresh = createSession();
  if (!saved || typeof saved !== 'object') return fresh;
  return {
    ...fresh,
    ...saved,
    history: Array.isArray(saved.history) ? saved.history.slice(0, AUTOPILOT_HISTORY_LIMIT) : [],
    stats: { ...fresh.stats, ...(saved.stats || {}), counts: { ...fresh.stats.counts, ...(saved.stats?.counts || {}) } },
  };
}
