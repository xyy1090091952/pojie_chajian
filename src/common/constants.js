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

// 插件对外显示的名字
export const EXTENSION_NAME = '德州胜率助手';

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
  AUTOPILOT_ACTED: 'AUTOPILOT_ACTED', // 托管：已经执行了一个动作，上报给后台（再转给面板展示）
};

// background <-> panel 的消息类型
export const PANEL_MESSAGE = {
  GET_SNAPSHOT: 'GET_SNAPSHOT', // panel 打开时，向后台要一份当前全部数据
  SNAPSHOT: 'SNAPSHOT', // 后台回传的全部数据
  NEW_RECORD: 'NEW_RECORD', // 后台广播：来了一条新数据
  CLEAR: 'CLEAR', // 清空
  AUTOPILOT_ACTION: 'AUTOPILOT_ACTION', // 后台广播：托管刚刚执行了某个动作（面板显示"最近动作"）
};

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
export const OPPONENT_STYLES = [
  { id: 'random', label: '随机（任意牌）', percent: 100, desc: '不预设对手，把对手当成随便两张牌（最乐观）。' },
  { id: 'loose', label: '松（爱玩牌）', percent: 85, desc: '对手爱入池、手里牌偏杂。' },
  { id: 'normal', label: '标准（常规）', percent: 50, desc: '多数休闲局的中间水平（推荐）。' },
  { id: 'tight', label: '紧（只玩好牌）', percent: 25, desc: '对手只玩较强起手牌，你的胜率更低也更贴近现实。' },
];

// 默认对手风格：用"标准"，比纯随机更接近真实牌局。
export const DEFAULT_OPPONENT_STYLE = 'normal';

// 小工具：按风格 id 查对应的 percent（查不到就回退成"随机 100%"，保证不崩）。
export function getOpponentPercent(styleId) {
  const found = OPPONENT_STYLES.find((s) => s.id === styleId);
  return found ? found.percent : 100;
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
//   id       —— 内部标识，面板下拉用它、decision-engine 按它选策略文件
//   label    —— 面板显示名
//   desc     —— 说明，帮你理解这档"大脑"大概怎么想
//   strategy —— 对应 src/data/strategies/<strategy>-strategy.js 里的实现
// 现在只实现了档位①(simple)，②③先占位、desc 里标注"开发中"，便于后续扩展。
export const STRATEGY_TIERS = [
  {
    id: 'simple',
    label: '档位①·简单托管',
    desc: '只看胜率和底池赔率：赢面够大就跟/加注，明显不够就弃牌。稳健、好理解。',
    strategy: 'simple',
  },
  {
    id: 'complex',
    label: '档位②·复杂判断（开发中）',
    desc: '在简单规则上叠加听牌、位置、对手人数等因素做更细的取舍。',
    strategy: 'complex',
  },
  {
    id: 'gto',
    label: '档位③·策略算法（开发中）',
    desc: '引入接近 GTO 的混合频率与下注尺度，目标是长期能稳定战胜人类。',
    strategy: 'gto',
  },
];

// 默认档位：从最稳妥、最好理解的"简单托管"开始。
export const DEFAULT_STRATEGY_TIER = 'simple';

// 小工具：按档位 id 查配置（查不到回退到默认档，保证不崩）。
export function getStrategyTier(tierId) {
  return (
    STRATEGY_TIERS.find((t) => t.id === tierId) ||
    STRATEGY_TIERS.find((t) => t.id === DEFAULT_STRATEGY_TIER)
  );
}

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
};

// ============ 「动作按钮」DOM 选择器规则 ============
// 说明：真正要"点按钮"时，得先在页面上找到对应按钮。不同站点按钮文字/结构不同，
//   所以把"怎么认按钮"的规则集中在这里（常量化）。执行器只管按规则找、不写死选择器。
//
// 匹配策略（按优先级）：
//   1) 先按 selectors 里的 CSS 选择器找（最精确，确认站点结构后在这里补）；
//   2) 找不到就退而求其次：遍历页面上的 <button>，看它的文字是否包含 textIncludes 里的词。
// 注意：selectors 现在先留空/占位，等用浏览器核对目标站真实 DOM 后再填精确值。
export const ACTION_BUTTON_RULES = {
  [POKER_ACTION.FOLD]: {
    selectors: [], // 例如：['.btn-fold', '[data-action="fold"]']，待核对后补
    textIncludes: ['弃牌', 'fold', 'Fold'],
  },
  [POKER_ACTION.CHECK]: {
    selectors: [],
    textIncludes: ['过牌', 'check', 'Check'],
  },
  [POKER_ACTION.CALL]: {
    selectors: [],
    textIncludes: ['跟注', 'call', 'Call'],
  },
  [POKER_ACTION.RAISE]: {
    selectors: [],
    textIncludes: ['加注', '下注', 'raise', 'Raise', 'bet', 'Bet'],
  },
};

// "轮到你了"的识别规则：页面轮到当前玩家行动时，通常会出现特定文案或高亮元素。
//   同样先给文案候选，CSS 选择器等核对真实 DOM 后再补精确值。
export const TURN_INDICATOR_RULES = {
  selectors: [], // 例如：['.action-bar--active', '.your-turn']，待核对后补
  textIncludes: ['轮到你', '该你', 'your turn', 'Your Turn'],
};

// 「加注金额输入框」识别规则：决策是"加注"时，要先把金额填进这个框，再点加注按钮。
//   不同站点可能用 number / range(滑块) / text 输入框，这里都兼容；
//   selectors 先留空，核对真实 DOM 后可补精确值（最优先）。
export const BET_INPUT_RULES = {
  selectors: [], // 例如：['input.bet-amount', '[data-role="raise-input"]']，待核对后补
  // 兜底：按 input 的 type 去找（优先 number，其次滑块 range，再次普通 text）。
  fallbackInputTypes: ['number', 'range', 'text'],
};

// 托管状态在 chrome.storage 里的键名（持久化用）。集中成常量，避免各处拼错字符串。
export const STORAGE_KEYS = {
  AUTOPILOT_ENABLED: 'autopilot_enabled', // 托管开关（true/false）
  STRATEGY_TIER: 'autopilot_strategy_tier', // 选中的策略档位 id
  OPPONENT_STYLE: 'autopilot_opponent_style', // 选中的对手牌力风格 id（决策与胜率共用）
};
