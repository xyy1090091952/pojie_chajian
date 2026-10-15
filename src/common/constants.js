/**
 * 全局常量模块
 * ------------------------------------------------------------
 * 作用：把插件里"写死的字符串/规则"集中到一处（常量化），
 *       这样后面任何地方要改规则，只改这里一个文件即可，
 *       避免散落在各处导致不一致。
 *
 * 说明：这个文件是 ES Module，会被 background 和 panel 用 import 引入。
 *       （注意：inject/interceptor.js 因为运行在页面环境里、不能用 import，
 *        所以它内部复制了下面 CHANNEL.PAGE_SOURCE 这个字符串，两边必须一致。）
 */

// 插件对外显示的名字（和 manifest.json 的 name、面板标题保持一致）
export const EXTENSION_NAME = '德州托管助手';

// ============ 通信通道相关常量 ============
// 数据流向：页面(interceptor) --postMessage--> content --sendMessage--> background --port--> panel
export const CHANNEL = {
  // 页面脚本发给 content 脚本时，用这个 source 做标记（防止和页面自己的消息混淆）
  PAGE_SOURCE: 'DH_AUDIT_PAGE',
  // panel 和 background 之间长连接的名字
  PORT_NAME: 'DH_AUDIT_PANEL',
};

// content -> background 的消息类型
export const RUNTIME_MESSAGE = {
  CAPTURE: 'CAPTURE', // 抓到一条新的网络数据
  GET_DECISION: 'GET_DECISION', // 托管：轮到我了，向后台要一个"该做什么动作"的决策
  AUTOPILOT_PLAN: 'AUTOPILOT_PLAN', // 托管：决策已出、但还没动手（在拟人延迟里），先把"打算怎么做"预告给面板
  AUTOPILOT_ACTED: 'AUTOPILOT_ACTED', // 托管：已经执行了一个动作，上报给后台（再转给面板展示）
  AUTOPILOT_STATUS: 'AUTOPILOT_STATUS', // 托管：运行状态变化（等待中/思考中/跳过原因），面板顶部状态卡用
};

// background <-> panel 的消息类型
export const PANEL_MESSAGE = {
  GET_SNAPSHOT: 'GET_SNAPSHOT', // panel 打开时，向后台要一份当前全部数据
  SNAPSHOT: 'SNAPSHOT', // 后台回传的全部数据
  NEW_RECORD: 'NEW_RECORD', // 后台广播：来了一条新数据
  CLEAR: 'CLEAR', // 清空
  AUTOPILOT_STATE: 'AUTOPILOT_STATE', // 后台广播：托管会话的完整状态（状态/预告/历史/统计），面板整块重绘
  RESET_STATS: 'RESET_STATS', // 面板请求：清空本场统计与动作历史
};

// 托管运行状态（面板顶部状态卡显示用）
export const AUTOPILOT_STATUS = {
  OFF: 'off', // 托管关闭
  WAITING: 'waiting', // 托管开着，等轮到我
  THINKING: 'thinking', // 轮到我了，正在思考/拟人延迟中
  ACTED: 'acted', // 刚执行完一个动作
  SKIPPED: 'skipped', // 轮到我但没法托管（数据不足/找不到按钮），等下一轮
};

// 状态 -> 面板显示文字
export const AUTOPILOT_STATUS_LABELS = {
  [AUTOPILOT_STATUS.OFF]: '托管已关闭',
  [AUTOPILOT_STATUS.WAITING]: '等待轮到你…',
  [AUTOPILOT_STATUS.THINKING]: '轮到你了，思考中…',
  [AUTOPILOT_STATUS.ACTED]: '已出手，等待下一步',
  [AUTOPILOT_STATUS.SKIPPED]: '这一步没能托管',
};

// 面板"动作历史"最多保留几条（存在 chrome.storage.session，关浏览器即清空）
export const AUTOPILOT_HISTORY_LIMIT = 30;

// 托管会话在 chrome.storage.session 里的键名：
//   MV3 后台闲置约 30 秒会被浏览器休眠、内存清空，存一份在 session 存储里，醒来后能接着显示。
export const AUTOPILOT_SESSION_KEY = 'autopilot_session';

// 数据方向（是客户端发出去的，还是服务器发下来的）
// 测泄露时，我们最关心 INBOUND（服务器 -> 客户端）里有没有别人的牌。
export const DIRECTION = {
  INBOUND: 'inbound', // 服务器 -> 浏览器（收到）
  OUTBOUND: 'outbound', // 浏览器 -> 服务器（发出）
};

// 数据传输方式
export const TRANSPORT = {
  WEBSOCKET: 'websocket',
  FETCH: 'fetch',
  XHR: 'xhr',
  SSE: 'sse', // 服务器推送事件（EventSource）—— River 游戏的主数据通道
};

// ============ 运行参数 ============
export const CONFIG = {
  // 最多保存多少条消息（环形缓冲，超过就丢最老的，防止内存无限增长）
  MAX_MESSAGES: 2000,
};

// ============ 扑克牌识别规则 ============
// 牌面点数（T = 10）。有的服务器用 "10"，有的用 "T"，这里都兼容。
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

// 花色字母 -> 中文名 + 符号 + 颜色，用于界面展示
export const SUITS = {
  s: { name: '黑桃', symbol: '♠', color: '#222' },
  h: { name: '红心', symbol: '♥', color: '#d33' },
  d: { name: '方块', symbol: '♦', color: '#d33' },
  c: { name: '梅花', symbol: '♣', color: '#222' },
};

// 一张牌的字符串正则：点数(2-9 / 10 / T J Q K A) + 花色(s h d c)，大小写都认。
// 例：As Kd Th 10c 2s
export const CARD_REGEX = /^(10|[2-9]|[tjqka])([shdc])$/i;

// 字段名关键词 -> 分类。遍历服务器数据时，一旦某个 key 名字里包含这些词，
// 就把它的值重点当作"牌"来解析，并打上对应标签。
// 这是启发式判断（靠经验猜），不同游戏字段名可能不同，可按需在这里加词。
export const KEY_HINTS = [
  // 注意：River 这款游戏里，每个玩家的底牌放在 "cards" 字段，所以把 cards/card 归到底牌。
  { category: 'hole', label: '底牌', keywords: ['hole', 'pocket', 'hand', 'holecard', 'privatecard', 'cards', 'card'] },
  { category: 'board', label: '公共牌', keywords: ['board', 'community', 'flop', 'turn', 'river', 'publiccard'] },
  { category: 'deck', label: '牌堆/未发牌', keywords: ['deck', 'remain', 'undealt', 'burn', 'stock'] },
];

// ============ 胜率计算（Equity）相关常量 ============
// 说明：下面这些是"胜率计算器"功能用到的参数。
//   这个功能只用你合法能看到的数据（你自己的底牌 + 已翻开的公共牌 + 还有几个对手没弃牌），
//   用蒙特卡洛模拟（随机发很多次牌、比大小、数赢的比例）算出你的胜率。
//   它和 PokerStove / Equilab 这类公开胜率计算器原理一样，不涉及任何对手的隐藏牌。
export const EQUITY = {
  // 蒙特卡洛模拟次数：发多少次牌来统计。次数越多越准，但越慢。
  // 1 万次在毫秒级就能算完，精度已经足够（误差约 ±1%）。
  SIMULATIONS: 10000,

  // 面板里数据频繁变化时，防抖等待毫秒数：
  //   牌局状态可能一秒内连续更新好几次，没必要每次都重算。
  //   等它"安静"这么久再算一次，避免浪费算力、也让界面不闪。
  DEBOUNCE_MS: 300,

  // 支持的最大对手数（德州最多 9 人桌 => 最多 8 个对手）。
  // 对手越多，要给他们随机发的牌越多，剩余牌不够就没法模拟。
  MAX_OPPONENTS: 8,

  // 跟注建议的判定阈值（都是"胜率 - 盈亏平衡胜率"的差值，单位：百分点）：
  //   - 胜率明显高于平衡点 => 建议跟注/加注
  //   - 差不多 => 临界，自己斟酌
  //   - 明显低于 => 建议弃牌
  CALL_MARGIN: 5, // 高出盈亏平衡点 5 个点以上 => 跟注划算
  FOLD_MARGIN: -5, // 低于盈亏平衡点 5 个点以上 => 跟注不划算
};

// ============ 对手「牌组范围 / 风格」配置 ============
// 为什么要有它（讲人话）：
//   以前算胜率时，我们把对手当成"随便两张牌"。但现实里还没弃牌、还在跟你的人，
//   手里往往是比随机更强的牌。如果仍假设对手随机，就会【高估】你的胜率。
//   所以这里给对手几种"打牌风格"：越紧的对手只玩越强的牌，你的胜率算出来就越低、越真实。
//
// percent 的含义：对手只会玩"全部起手牌里最强的前百分之几"。
//   例如 25 表示"只玩最强的前 25% 起手牌"（典型的紧凶玩家）。
//   100 表示"任意两张牌都玩"（等于回到老的纯随机假设）。
// id 用于界面下拉框和状态记录；percent 交给胜率引擎做过滤，二者解耦。
//
// decision 的含义（档位②·群体默认画像用）：同一个风格，不只影响"胜率算多少"，
//   也影响"托管该怎么取舍"。这就是"看桌子性质下菜"：
//   - callThreshold：跟注门槛的偏移（百分点）。负数=更舍得跟（面对爱弃牌的紧对手，
//     可以多偷鸡/多下注施压）；正数=更谨慎（面对爱跟注的松对手，边缘牌别乱跟）。
//   - bluffBias：诈唬/半诈唬倾向。>1 更爱诈唬（紧对手爱弃牌，诈唬更容易成功）；
//     <1 收敛诈唬（松对手爱跟注，诈唬是送钱）。
//   - valueStretch：价值下注倾向。>1 更爱用成手价值下注要钱（松对手爱付钱，多榨价值）。
//   这些只是"温和的旋钮"，不改变策略主干，拿不到风格时一律用中性值 1 / 0。
export const OPPONENT_STYLES = [
  {
    id: 'random',
    label: '随机（任意牌）',
    percent: 100,
    desc: '不预设对手，把对手当成随便两张牌（最乐观）。',
    decision: { callThreshold: 0, bluffBias: 1, valueStretch: 1 },
  },
  {
    id: 'loose',
    label: '松（爱玩牌）',
    percent: 85,
    desc: '对手爱入池、手里牌偏杂。',
    // 松对手爱跟注：少诈唬（送钱）、多榨价值、边缘牌跟注门槛抬高一点。
    decision: { callThreshold: 2, bluffBias: 0.5, valueStretch: 1.2 },
  },
  {
    id: 'normal',
    label: '标准（常规）',
    percent: 50,
    desc: '多数休闲局的中间水平（推荐）。',
    decision: { callThreshold: 0, bluffBias: 1, valueStretch: 1 },
  },
  {
    id: 'tight',
    label: '紧（只玩好牌）',
    percent: 25,
    desc: '对手只玩较强起手牌，你的胜率更低也更贴近现实。',
    // 紧对手爱弃牌：诈唬更易成功、可更舍得施压（门槛略降）；但对手一旦来钱要尊重。
    decision: { callThreshold: -1, bluffBias: 1.6, valueStretch: 0.9 },
  },
];

// 「自动识别」选项：不预设对手，由机器人边打边记（见 opponent-model.js），样本够了自动判断松紧。
//   它不是一种真正的"风格"（没有 percent），而是"让机器人替你选"，所以单独定义、不放进 OPPONENT_STYLES。
export const OPPONENT_STYLE_AUTO = 'auto';
export const OPPONENT_STYLE_AUTO_OPTION = {
  id: OPPONENT_STYLE_AUTO,
  label: '自动识别（推荐）',
  desc: '机器人边打边记对手的入池频率，观察够了自动判断这桌是松还是紧；样本不够时先按"标准"算。',
};

// 自动识别还没观察够样本时，临时按哪种风格算（标准，比纯随机更接近真实牌局）。
export const AUTO_FALLBACK_STYLE = 'normal';

// 面板"对手类型"下拉框的全部选项：自动识别 + 四种手选风格。
export const OPPONENT_STYLE_OPTIONS = [OPPONENT_STYLE_AUTO_OPTION, ...OPPONENT_STYLES];

// 默认对手类型：自动识别。
export const DEFAULT_OPPONENT_STYLE = OPPONENT_STYLE_AUTO;

// 小工具：按 id 取对手类型的中文名（查不到原样返回），面板和决策说明共用，避免界面里冒出英文 id。
export function getOpponentStyleLabel(styleId) {
  const found = OPPONENT_STYLE_OPTIONS.find((s) => s.id === styleId);
  return found ? found.label : styleId;
}

// 小工具：按风格 id 查对应的 percent（查不到就回退成"随机 100%"，保证不崩）。
export function getOpponentPercent(styleId) {
  const found = OPPONENT_STYLES.find((s) => s.id === styleId);
  return found ? found.percent : 100;
}

// 群体画像的"中性值"：拿不到风格、或字段缺失时统一用它，等于"不做任何偏移"。
//   集中成常量，避免各处散写 {callThreshold:0, bluffBias:1, valueStretch:1}。
export const NEUTRAL_DECISION_PROFILE = { callThreshold: 0, bluffBias: 1, valueStretch: 1 };

// 小工具：按风格 id 查"决策调节参数"（档位②群体画像用）。
//   查不到、或该风格没配 decision 时，一律回退中性值，保证策略逻辑不被污染。
export function getOpponentDecisionProfile(styleId) {
  const found = OPPONENT_STYLES.find((s) => s.id === styleId);
  return (found && found.decision) ? found.decision : NEUTRAL_DECISION_PROFILE;
}

// 牌型等级（数字越大越好）-> 中文名。
// 评估器把每手牌打分成"等级 + 关键点数"，这里只用于把等级翻译成人话显示。
// 等级定义见 poker-engine.js 的 HAND_RANK。
export const HAND_CATEGORY_NAMES = {
  9: '皇家同花顺',
  8: '同花顺',
  7: '四条',
  6: '葫芦',
  5: '同花',
  4: '顺子',
  3: '三条',
  2: '两对',
  1: '一对',
  0: '高牌',
};

// ============ 「自动托管 / 自动打牌」相关常量 ============
// 设计目标（讲人话）：
//   托管 = 插件根据算出来的胜率，自动帮你点"弃牌/过牌/跟注/加注"。
//   为了后面能换不同"大脑"（简单规则 / 复杂判断 / 接近人类的 GTO 策略），
//   我们把"用哪种大脑"做成配置档位，决策逻辑按档位分文件、可插拔。
//   —— 这就是"数据驱动 + 模块化"：换策略只改配置，不改调用方。

// 四种标准动作（动作枚举）。全插件统一用这几个常量，避免到处写字符串拼错。
export const POKER_ACTION = {
  FOLD: 'fold', // 弃牌
  CHECK: 'check', // 过牌（无需跟注时）
  CALL: 'call', // 跟注
  RAISE: 'raise', // 加注/下注
};

// 动作对应的中文名（只用于界面显示"最近动作"，和逻辑解耦）
export const POKER_ACTION_NAMES = {
  [POKER_ACTION.FOLD]: '弃牌',
  [POKER_ACTION.CHECK]: '过牌',
  [POKER_ACTION.CALL]: '跟注',
  [POKER_ACTION.RAISE]: '加注',
};

// 策略档位配置（数据驱动）：
//   id        —— 内部标识，面板下拉用它、decision-engine 按它选策略文件
//   label     —— 面板显示名
//   desc      —— 说明，帮你理解这档"大脑"大概怎么想
//   strategy  —— 对应 src/data/strategies/<strategy>-strategy.js 里的实现
//   available —— 是否已实现、可供选择。false 的档位在面板里置灰、不可选。
//                （以后把某档写好了，只把这里改成 true，面板自动放开，别处不用动。）
export const STRATEGY_TIERS = [
  {
    id: 'simple',
    label: '档位①·简单托管',
    desc: '只看胜率和底池赔率：赢面够大就跟/加注，明显不够就弃牌。稳健、好理解。',
    strategy: 'simple',
    available: true,
  },
  {
    id: 'complex',
    label: '档位②·复杂判断（推荐）',
    desc: '翻牌前看起手牌和位置，翻牌后综合牌型、听牌、牌面和对手下注大小来决定。目前最强的一档。',
    strategy: 'complex',
    available: true,
  },
  {
    id: 'gto',
    label: '档位③·策略算法（开发中）',
    desc: '引入接近 GTO 的混合频率与下注尺度，目标是长期能稳定战胜人类。',
    strategy: 'gto',
    available: false,
  },
];

// 默认档位：用目前最强的"复杂判断"档（简单档只作对照/保底）。
export const DEFAULT_STRATEGY_TIER = 'complex';

// 小工具：按档位 id 查配置（查不到回退到默认档，保证不崩）。
export function getStrategyTier(tierId) {
  return (
    STRATEGY_TIERS.find((t) => t.id === tierId) ||
    STRATEGY_TIERS.find((t) => t.id === DEFAULT_STRATEGY_TIER)
  );
}

// 整体打法倾向：控制“愿不愿意入池/跟注/半诈唬”，以及“诈唬下注打多大”。
//   这些参数只由复杂策略读取；简单策略保持原逻辑，避免两个档位互相污染。
//   bluffSizeMult —— 诈唬下注的放大系数（只作用于半诈唬/试探注这类"吓退"性质的下注，
//                    不影响价值下注；最终金额仍受牌桌合法范围与筹码封顶保护，不会误全下）。
export const AGGRESSION_PROFILES = [
  {
    id: 'cautious',
    label: '稳健',
    desc: '整体收紧：跟注和下注都要求更高的胜率，不主动半诈唬，输赢波动小。',
    decision: {
      thresholdShift: 2,
      preflopOddsShift: -4,
      valueGateShift: 3,
      allowSemiBluff: false,
      bluffSizeMult: 1.0, // 稳健档本就不诈唬，这里只做兜底，不生效
    },
  },
  {
    id: 'balanced',
    label: '均衡',
    desc: '标准门槛：有把握就下注要钱，有强听牌时适当施压（诈唬打 2/3 池级别，有压迫力）。',
    decision: {
      thresholdShift: 0,
      preflopOddsShift: 0,
      valueGateShift: 0,
      allowSemiBluff: true,
      bluffSizeMult: 1.0, // 诈唬按基准尺度（约 2/3 池）
    },
  },
  {
    id: 'aggressive',
    label: '激进',
    desc: '整体放宽：胜率稍低也敢跟、敢下注，诈唬打得更大（接近满池），更能把对手吓弃牌。',
    decision: {
      thresholdShift: -2,
      preflopOddsShift: 5,
      valueGateShift: -4,
      allowSemiBluff: true,
      bluffSizeMult: 1.25, // 诈唬在基准上再放大 25%，压迫力更强
    },
  },
];

export const DEFAULT_AGGRESSION_PROFILE = 'balanced';

export function getAggressionProfile(profileId) {
  return (
    AGGRESSION_PROFILES.find((profile) => profile.id === profileId) ||
    AGGRESSION_PROFILES.find((profile) => profile.id === DEFAULT_AGGRESSION_PROFILE)
  );
}

// 翻牌前「入池意愿」：看翻牌的费用很小时，要不要用一般甚至偏差的牌去看一张翻牌。
//   讲人话：只花 1~3 个大盲就能看到 3 张公共牌，万一中了两对/暗三/顺子，常常能从对手那里赢回很多（隐含赔率），
//   所以"便宜看牌"长期往往是赚的。但筹码太浅时中了也赢不回多少，所以还要求费用占剩余筹码的比例不能太高。
//   只由复杂策略读取。字段含义：
//     cheapMaxBb       —— 看牌费 ≤ 这么多个大盲，算"便宜"（略高于整数，避免 1.0 这种边界因为小数误差判错）
//     cheapMinScore    —— 便宜时，起手牌强度（Chen 分）≥ 这个值就去看。同花连张/同花A/口袋对子不受此限
//                         参考：72o=-1、94o=0、J5o=1、Q2o=2、96o=3、J8o=4、Q5s=4、KTo=6
//     cheapMaxStackPct —— 看牌费同时不能超过剩余筹码的这个百分比（筹码浅时不乱看）
//     fallbackStackPct —— 拿不到大盲数据时的备选判断：看牌费 ≤ 剩余筹码这个百分比算便宜
export const PREFLOP_ENTRY_PROFILES = [
  {
    id: 'standard',
    label: '标准',
    desc: '只差 1 个大盲以内，才用一般的牌去看翻牌；偏差的牌照样弃掉。',
    decision: { cheapMaxBb: 1.05, cheapMinScore: 4, cheapMaxStackPct: 10, fallbackStackPct: 2 },
  },
  {
    id: 'loose',
    label: '积极',
    desc: '看翻牌只要 ≤ 2 个大盲，除了最差的一批牌（如 72o、83o），都便宜去看一张。',
    decision: { cheapMaxBb: 2.05, cheapMinScore: 1, cheapMaxStackPct: 6, fallbackStackPct: 3 },
  },
  {
    id: 'wide',
    label: '很积极',
    desc: '看翻牌只要 ≤ 3 个大盲，几乎任何两张牌都去看。适合对手很少加注、被动的桌子。',
    decision: { cheapMaxBb: 3.05, cheapMinScore: -10, cheapMaxStackPct: 8, fallbackStackPct: 4 },
  },
];

export const DEFAULT_PREFLOP_ENTRY_PROFILE = 'standard';

export function getPreflopEntryProfile(profileId) {
  return (
    PREFLOP_ENTRY_PROFILES.find((profile) => profile.id === profileId) ||
    PREFLOP_ENTRY_PROFILES.find((profile) => profile.id === DEFAULT_PREFLOP_ENTRY_PROFILE)
  );
}

// 大牌下注方式：只作用于“强起手/三条及以上”等明确的价值下注。
//   半诈唬、保护下注和普通牌仍保持固定安全上限，避免“最大化”变成误全下。
export const VALUE_BET_PROFILES = [
  {
    id: 'standard',
    label: '标准',
    desc: '按常规尺度价值下注；强牌最多投入约 50%，超强牌最多约 75% 筹码。',
    decision: { sizeMultiplier: 1, strongStackCap: 0.5, monsterStackCap: 0.75 },
  },
  {
    id: 'pressure',
    label: '强势',
    desc: '大牌下注约放大 25%；强牌最多约 65%，超强牌最多约 85% 筹码。',
    decision: { sizeMultiplier: 1.25, strongStackCap: 0.65, monsterStackCap: 0.85 },
  },
  {
    id: 'maximize',
    label: '最大化',
    desc: '大牌下注约放大 50%；强牌最多约 80%，超强牌最多约 95% 筹码。',
    decision: { sizeMultiplier: 1.5, strongStackCap: 0.8, monsterStackCap: 0.95 },
  },
];

export const DEFAULT_VALUE_BET_PROFILE = 'standard';

export function getValueBetProfile(profileId) {
  return (
    VALUE_BET_PROFILES.find((profile) => profile.id === profileId) ||
    VALUE_BET_PROFILES.find((profile) => profile.id === DEFAULT_VALUE_BET_PROFILE)
  );
}

// ============ 下注尺度（bet-sizing.js 使用）============
// 讲人话：River 的金额框填的是"加注至"（本轮我一共下到多少），不是"再多下多少"。
//   所有策略都先说"我想再投入底池的百分之几 / 几个大盲"，再由 bet-sizing.js 统一换算成"加注至"金额，
//   并按筹码深度(SPR)决定是否直接全下、是否需要封顶。参数集中在这里方便调。
export const SIZING = {
  // —— 翻牌前（按大盲计）——
  OPEN_RAISE_BB: 2.5, // 无人加注时开池：加注至 2.5 个大盲
  OPEN_PER_LIMPER_BB: 1, // 前面每有 1 个人平跟，开池再多加 1 个大盲（惩罚平跟者）
  MAX_LIMPERS_COUNTED: 4, // 平跟人数最多按 4 个算，防止底池数据异常时开得离谱
  THREEBET_IP_MULT: 3, // 有位置时 3-bet：加注至 = 对手加注额 × 3
  THREEBET_OOP_MULT: 3.5, // 没位置/位置未知时 3-bet：× 3.5（没位置要打大一点）
  FOURBET_MULT: 2.3, // 面对 3-bet 再加注（4-bet）：× 2.3
  FOURBET_TRIGGER_BB: 6, // 对手"加注至"超过 6 个大盲，就认为面对的是 3-bet 以上

  // —— 筹码深度 / 封顶 ——
  // SPR = 剩余筹码 ÷ 底池。SPR 越小，说明筹码相对底池越浅，好牌越应该直接全下。
  STRONG_COMMIT_SPR: 2.5, // 强牌（三条~同花）：SPR ≤ 2.5 允许全下
  MONSTER_COMMIT_SPR: 4, // 超强牌（葫芦以上）：SPR ≤ 4 允许全下
  COMMIT_RATIO: 0.6, // 强牌本次投入已超过剩余筹码 60%：干脆全下（剩一点筹码没意义还暴露意图）
  NORMAL_STACK_CAP: 0.33, // 普通牌（顶对/半诈唬/保护注）：单次最多投入剩余筹码的 1/3
  NO_STACK_POT_CAP: 1.0, // 拿不到筹码数据时：普通牌单次最多投入 1 倍底池
  NO_STACK_POT_CAP_STRONG: 2.0, // 拿不到筹码数据时：强牌单次最多投入 2 倍底池
};

// ============ 对手范围收窄（opponent-range.js 使用）============
// 讲人话：对手真金白银下大注时，他手里通常是好牌。如果还按"他啥牌都玩"去算胜率，
//   胜率会被高估、导致乱跟。所以面对下注/加注时要收窄对手范围，分两层：
//   ① 翻牌前：按"对手加注 / 3-bet"把起手牌范围百分比乘一个 <1 的系数（factor）。
//   ② 翻牌后：光看起手牌不够（AK 是好起手牌，但在 J J 8 3 2 上没中，河牌很少下大注）。
//      所以按"对手这手牌在当前公共牌上中了什么"给它一个【下注可能性】权重（0~1），
//      模拟时按权重抽对手的牌：成手多抽、空气牌（诈唬）少抽，注越大/越是加注，空气和小对子越少。
//   权重表的 key 对应 hand-class.js 的成手分级 / 听牌强弱：
//     monster 葫芦以上 | strong 两对/三条/顺子/同花 | top_pair 顶对/超对 | weak_pair 小对子
//     none 没中（诈唬牌） | drawStrong 强听牌（同花/两头顺，河牌没有） | drawWeak 卡顺
//   一手牌既有成手又有听牌时，取两者里更大的权重。
export const RANGE_NARROWING = {
  MIN_PERCENT: 8, // 再怎么收窄，对手范围也不低于前 8%（避免把对手想成只有 AA）
  PREFLOP_RAISE_FACTOR: 0.55, // 翻牌前面对加注：对手范围 × 0.55
  PREFLOP_3BET_FACTOR: 0.3, // 翻牌前面对 3-bet 以上：× 0.3
  // 翻牌后面对下注：按"下注 ÷ 底池"分档（maxRatio 为上界，从小到大匹配第一档）
  POSTFLOP_BET_TIERS: [
    {
      maxRatio: 0.4,
      label: '小注',
      weights: { monster: 1, strong: 1, top_pair: 0.9, weak_pair: 0.6, none: 0.35, drawStrong: 0.8, drawWeak: 0.5 },
    },
    {
      maxRatio: 0.8,
      label: '中注',
      weights: { monster: 1, strong: 1, top_pair: 0.8, weak_pair: 0.35, none: 0.18, drawStrong: 0.65, drawWeak: 0.3 },
    },
    {
      maxRatio: Infinity,
      label: '大注',
      weights: { monster: 1, strong: 1, top_pair: 0.6, weak_pair: 0.15, none: 0.1, drawStrong: 0.5, drawWeak: 0.15 },
    },
  ],
  // 我先下注、对手再加注（翻牌后的"加注"）：这是最强的信号，小对子和空气几乎不会这么打。
  POSTFLOP_RAISE: {
    label: '加注',
    weights: { monster: 1, strong: 0.9, top_pair: 0.3, weak_pair: 0.05, none: 0.04, drawStrong: 0.4, drawWeak: 0.08 },
  },
  // 河牌没有后续牌可补，诈唬更少：在上面任一档的基础上，空气牌权重再 × 这个系数。
  RIVER_BLUFF_FACTOR: 0.8,
  // 多人底池里"下注的那个人"之外的其他对手：多半是跟注/待行动，范围比下注者宽，用这张表。
  POSTFLOP_CALLER_WEIGHTS: { monster: 1, strong: 1, top_pair: 0.9, weak_pair: 0.55, none: 0.2, drawStrong: 0.85, drawWeak: 0.45 },
};

// ============ 危险牌面降级（complex-strategy.js 使用）============
// 讲人话：转牌/河牌出现"容易组成大牌"的牌面时（已成同花、已成顺、公共牌成对可能有三条/葫芦），
//   对手真要来钱，往往手里已经是同花/顺子/三条这种大牌组。这时自己只有顶对及以下的"非强牌"，
//   面对下注就该更谨慎、更倾向弃牌 —— 所以给跟注门槛额外加几个点（penalty，单位：百分点）。
//   ⚠️ 只影响"非强牌"（顶对/小对子/未成手）；自己是三条、顺子、同花以上的强牌不受影响，照常跟/加。
export const BOARD_DANGER = {
  MIN_STREET: 4, // 从转牌(4 张公共牌)起才判断：翻牌还早、牌面没定型，不急着加严。
  // 同花威胁：牌面 4 张同色(strong) / 5 张同色(made) 时加门槛；只有 3 张同色(听牌 draw)不加。
  FLUSH: { made: 12, strong: 8 },
  // 顺子威胁：牌面高度连张(strong=3连 / made=4连)时加门槛；只是略带连张(draw)不加。
  STRAIGHT: { made: 10, strong: 6 },
  PAIRED: 6, // 公共牌成对：可能有人中三条/葫芦，加门槛。
  MAX_PENALTY: 20, // 多种威胁叠加时的上限，避免门槛被抬到离谱、把能跟的牌也全弃了。
};

// 托管运行参数：集中管理"自动打牌"的节奏与安全阀。
export const AUTOPILOT = {
  // 托管总开关的默认值：默认【关闭】。必须用户在面板上手动打开才会自动动作，
  //   避免一装上就乱点牌（安全第一，也符合"用户显式授权"原则）。
  DEFAULT_ENABLED: false,

  // 拟人化操作延迟区间（毫秒）：轮到你之后，不立刻点，而是随机等一会儿再点，
  //   让操作节奏像真人、而不是零延迟的机器。实际延迟会在 [MIN, MAX] 间随机取。
  ACTION_DELAY_MIN_MS: 1200,
  ACTION_DELAY_MAX_MS: 3500,

  // 加注尺度：当决策为"加注"时，下注额 = 当前底池 * 这个系数（1/2 池是常见稳健尺度）。
  //   具体是否采用、如何取整，交给策略/执行器处理，这里只给默认值。
  RAISE_POT_RATIO: 0.5,

  // 轮询间隔（毫秒）：执行器每隔这么久检查一次"是不是轮到我了"。
  //   不宜太频繁（费 CPU），也不宜太慢（错过操作窗口）。
  TURN_POLL_MS: 800,

  // 防重复：同一手牌、同一个决策动作，最短间隔多久才允许再点一次（毫秒）。
  //   防止因为页面状态抖动导致对同一个局面连点好几下。
  ACTION_COOLDOWN_MS: 2500,

  // 防重复（按局面指纹）：对【完全相同的局面】已经出过手，就不再出手；
  //   但如果过了这么久局面还没变（比如点击没被站点接收），允许重试一次，避免卡死。
  SAME_STATE_RETRY_MS: 8000,

  // 「房主·自动开始下一手」默认值：默认【开启】。
  //   注意：它受总开关管辖——只有托管总开关打开时才会生效，所以默认开也安全。
  //   作用：房主需要手动点"开始下一手"才能进下一局，这里替房主自动点，避免卡在局间。
  AUTO_NEXT_HAND: true,

  // "开始下一手"按钮的防重复间隔（毫秒）：比普通动作长一些，
  //   因为局间状态可能来回抖动，避免对同一个"开始"按钮连点。
  NEXT_HAND_COOLDOWN_MS: 4000,

  // 后台保活（keep-alive）：
  //   浏览器为了省电，会给"看不见的标签页"（切到别的标签、窗口最小化/失焦）的定时器狠狠降速——
  //   后台待几分钟后，setInterval 可能被压到"每分钟才跑一次"，托管循环等于挂在后台不动了。
  //   破解办法（业界通用技巧）：播放一段【完全静音】的音频，让浏览器以为"这个标签在放声音"
  //   而网开一面、不降速。副作用只有标签上出现一个小喇叭图标，完全听不到声音。
  //   ⚠️ 它【只能解决"后台标签降速"】。如果整台电脑睡眠，浏览器被系统挂起，所有网页脚本一律停摆，
  //      这不是插件能解决的，需要在系统层面阻止睡眠（见 README「后台运行与睡眠」）。
  KEEP_ALIVE: {
    ENABLED: true, // 总开关：是否启用后台保活（跟随托管开关自动启停）
    VOLUME: 0.0001, // 音量：极小到完全听不见，但足以让浏览器判定"这个标签在放声音"
    FREQUENCY_HZ: 1, // 振荡频率（Hz）：1Hz 远低于人耳能听到的范围，更保险地听不见
    // 浏览器规定：音频必须在"用户手势"之后才能播放。若开启托管那一下没有手势，
    //   就等用户下次点一下页面（任意处）再解锁——下面是用来"解锁"的交互事件。
    UNLOCK_EVENTS: ['pointerdown', 'keydown', 'click'],
  },
};

// ============ 「动作按钮」DOM 选择器规则 ============
// 说明：真正要"点按钮"时，得先在页面上找到对应按钮。不同站点按钮文字/结构不同，
//   所以把"怎么认按钮"的规则集中在这里（常量化）。执行器只管按规则找、不写死选择器。
//
// 匹配策略（按优先级）：
//   1) 先按 selectors 里的 CSS 选择器找（最精确，确认站点结构后在这里补）；
//   2) 找不到就退而求其次：遍历页面上的 <button>，看它的文字是否包含 textIncludes 里的词。
//
// "预选动作"按钮的排除词：很多牌桌在没轮到你时也会显示"自动过牌 / 过牌或弃牌"这类预选开关，
//   文字里同样含"弃牌/过牌"。它们不是真正的行动按钮，识别轮次和执行动作时都要排除。
export const PRE_ACTION_EXCLUDE_TEXT = ['自动', '预选', '/', 'auto'];

// 下面的 selectors 已用测试账号登录目标站（River，47.243.178.16）核对过真实 DOM：
//   - 底部动作区容器 class = ".table-action-zone"
//   - 跟注按钮 class 含 "is-call"（完整：button primary-action is-call）
//   - 加注按钮 class 含 "raise-trigger"（完整：button dark raise-trigger）
//   - 弃牌按钮只有通用 class "button"、没有专属类，所以不写精确选择器、只靠文字"弃牌"兜底
//   - 过牌（check）本次牌局没出现（当时面前有下注、只能跟注），同样先靠文字兜底
export const ACTION_BUTTON_RULES = {
  [POKER_ACTION.FOLD]: {
    // 弃牌按钮无专属 class（和别的按钮都叫 .button），精确选择器难以一意区分，
    //   直接交给文字兜底"弃牌"更稳，这里保持为空。
    selectors: [],
    textIncludes: ['弃牌', 'fold', 'Fold'],
    // 排除"自动弃牌/预选"这类没轮到你时也常驻的预选按钮（防止误判轮次、误点）。
    excludeText: PRE_ACTION_EXCLUDE_TEXT,
  },
  [POKER_ACTION.CHECK]: {
    // 过牌按钮本次未观察到（局面是"要跟注"），暂不写精确选择器，靠文字兜底。
    selectors: [],
    textIncludes: ['过牌', 'check', 'Check'],
    excludeText: PRE_ACTION_EXCLUDE_TEXT,
  },
  [POKER_ACTION.CALL]: {
    // 跟注按钮：River 用 .is-call 做专属标记（限定在动作区内，避免误伤别处）。
    selectors: ['.table-action-zone button.is-call'],
    textIncludes: ['跟注', 'call', 'Call'],
  },
  [POKER_ACTION.RAISE]: {
    // 加注按钮：River 用 .raise-trigger 做专属标记。
    //   注意它是"先展开操作条、再点一次提交"的两段式按钮，展开逻辑在执行器里处理。
    selectors: ['.table-action-zone button.raise-trigger'],
    textIncludes: ['加注', '下注', 'raise', 'Raise', 'bet', 'Bet'],
  },
};

// "轮到你了"的识别规则（按可靠度从高到低）：
//   1) actionZoneSelectors：River 底部动作区(.table-action-zone)里出现【可点的】弃牌/过牌/跟注按钮 => 轮到我；
//      这是最可靠的判据——没轮到你时这些按钮不会出现或是禁用的。
//   2) selectors：轮到我时会出现的高亮元素（待核对后补）；
//   3) textIncludes：页面上"轮到你"之类的提示文字兜底。
export const TURN_INDICATOR_RULES = {
  actionZoneSelectors: ['.table-action-zone'],
  selectors: [], // 例如：['.action-bar--active', '.your-turn']，待核对后补
  textIncludes: ['轮到你', '该你', 'your turn', 'Your Turn'],
};

// 「加注金额输入框」识别规则：决策是"加注"时，要先把金额填进这个框，再点加注按钮。
//   已核对目标站（River）真实 DOM：
//     - 金额输入框是 <input type="text" inputmode="numeric" aria-label="加注至金额">，
//       它在"加注操作条"浮层(.raise-popover)里，且该浮层是点击加注按钮后才出现（见执行器两段式逻辑）。
//     - 浮层里还有一个 <input type="range" class="raise-slider"> 滑块，它默认值可能停在 0 或最大，
//       【绝对不能】拿它当金额框去填——所以兜底里特意【不含 range】，只认 text / number，防误全下。
export const BET_INPUT_RULES = {
  // 精确优先：aria-label 命名最稳；再加 .raise-popover 下的文本框做备选。
  selectors: [
    'input[aria-label="加注至金额"]',
    '.raise-popover input[inputmode="numeric"]',
    '.raise-popover input[type="text"]',
  ],
  // 兜底：按 input 的 type 去找。只认 number / text，【刻意排除 range 滑块】以防误全下。
  fallbackInputTypes: ['number', 'text'],
};

// 「开始下一手 / 开局」按钮识别规则：房主需要点这个按钮才能进下一局。
//   和动作按钮同一套匹配策略：先 selectors 精确找，找不到按文字兜底。
//   已核对目标站（River）：局间推进按钮文字是"下一手"，开新局是"开始发牌"。
//
//   ⚠️ 血泪教训：这里【绝对不能】放"开始 / start / 重新开局 / 继续"这类过宽的词！
//   因为页面上常驻着"重新开始练习""重新开局"等【重置整局】的按钮，它们文字里也含"开始"，
//   英文 "restart" 里也含 "start" —— 一旦兜底命中，牌局进行中就会被反复误点重开。
//   所以：① textIncludes 只留"推进下一局"的精准词；
//        ② 再加 excludeText 排除闸，凡按钮含"重新/重开/重置/restart/reset"一律不认（防误点重置）。
export const NEXT_HAND_BUTTON_RULES = {
  selectors: [], // River 局间/开局按钮无稳定专属 class，靠下方文字兜底命中"下一手/开始发牌"
  textIncludes: [
    '开始下一手',
    '开始发牌',
    '下一手',
    '下一局',
    '再来一局',
    'next hand',
    'Next Hand',
    'deal',
    'Deal',
  ],
  // 排除闸：按钮文字只要含这些词，就【不】当作"下一手"（防误点"重新开始练习/重新开局"等重置按钮）。
  excludeText: ['重新', '重开', '重置', 'restart', 'reset'],
};

// 托管状态在 chrome.storage 里的键名（持久化用）。集中成常量，避免各处拼错字符串。
export const STORAGE_KEYS = {
  AUTOPILOT_ENABLED: 'autopilot_enabled', // 托管开关（true/false）
  STRATEGY_TIER: 'autopilot_strategy_tier', // 选中的策略档位 id
  OPPONENT_STYLE: 'autopilot_opponent_style', // 选中的对手牌力风格 id（决策与胜率共用）
  AGGRESSION_PROFILE: 'autopilot_aggression_profile', // 整体打法：稳健/均衡/激进
  VALUE_BET_PROFILE: 'autopilot_value_bet_profile', // 大牌下注：标准/强势/最大化
  PREFLOP_ENTRY_PROFILE: 'autopilot_preflop_entry_profile', // 入池意愿：标准/积极/很积极
  AUTO_NEXT_HAND: 'autopilot_auto_next_hand', // 房主：自动开始下一手（true/false）
};

// 托管配置项对照表：配置字段名 -> storage 键 -> 默认值（数据驱动：加一个配置只改这里）。
//   面板（写）和托管控制器（读）共用这一张表，保证两边认的是同一套配置。
export const AUTOPILOT_CONFIG_FIELDS = [
  { field: 'enabled', key: STORAGE_KEYS.AUTOPILOT_ENABLED, fallback: AUTOPILOT.DEFAULT_ENABLED },
  { field: 'tier', key: STORAGE_KEYS.STRATEGY_TIER, fallback: DEFAULT_STRATEGY_TIER },
  { field: 'opponentStyle', key: STORAGE_KEYS.OPPONENT_STYLE, fallback: DEFAULT_OPPONENT_STYLE },
  { field: 'aggressionProfile', key: STORAGE_KEYS.AGGRESSION_PROFILE, fallback: DEFAULT_AGGRESSION_PROFILE },
  { field: 'valueBetProfile', key: STORAGE_KEYS.VALUE_BET_PROFILE, fallback: DEFAULT_VALUE_BET_PROFILE },
  { field: 'preflopEntryProfile', key: STORAGE_KEYS.PREFLOP_ENTRY_PROFILE, fallback: DEFAULT_PREFLOP_ENTRY_PROFILE },
  { field: 'autoNextHand', key: STORAGE_KEYS.AUTO_NEXT_HAND, fallback: AUTOPILOT.AUTO_NEXT_HAND },
];

// 面板界面参数
export const PANEL_UI = {
  HISTORY_PREVIEW: 5, // 动作历史默认只显示最近几条，点"展开"看全部
  CLOCK_TICK_MS: 30000, // "本场时长"多久刷新一次
  RECONNECT_MS: 1000, // 和后台的连接断了（后台被休眠/重启）多久后重连
  CONFIRM_RESET_MS: 3000, // "重置统计"要连点两次确认，第二次点击的有效时间
};

// "开始下一手"在动作历史里的标识（它不是扑克动作，但要和扑克动作一起显示在历史里）
export const NEXT_HAND_ACTION = 'next_hand';

// 公共牌张数 -> 街道名称（面板显示"现在打到哪一街"用）
export const STREET_NAMES = { 0: '翻牌前', 3: '翻牌', 4: '转牌', 5: '河牌' };
