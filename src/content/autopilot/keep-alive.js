/**
 * 托管·后台保活（keep-alive）
 * ------------------------------------------------------------
 * 要解决的问题（讲人话）：
 *   浏览器为了省电，会给"看不见的标签页"（你切到别的标签、窗口最小化/失焦）里的
 *   setInterval 定时器狠狠降速——几分钟后可能被压到"每分钟才跑一次"。
 *   而我们的托管主循环（controller.js）正是靠 setInterval 每 0.8 秒看一眼"轮到我了吗"，
 *   一旦被降速，就等于托管挂在后台不动了。
 *
 * 破解办法（业界通用小技巧）：
 *   让这个标签页【播放一段完全静音的音频】。浏览器一看"这个标签在放声音"，
 *   就把它当成"用户还在用"，不再给它的定时器降速。
 *   副作用：标签上会出现一个小喇叭图标，但音量极小、频率极低，人耳完全听不到。
 *
 * ⚠️ 浏览器的"自动播放"限制（重点）：
 *   Chrome 规定——音频必须在【用户手势之后】才能创建/播放。否则一创建就会在控制台报：
 *     "The AudioContext was not allowed to start..."。
 *   所以本模块【不抢跑】：开启托管时若还没有页面手势，就【先不创建音频】，
 *   只挂一次性监听，等用户下次点一下游戏页面再创建并播放。这样控制台一条警告都不会有。
 *
 * ⚠️ 能力边界：它【只能解决"后台标签降速"】。
 *   如果整台电脑睡眠，浏览器被操作系统整体挂起，所有网页脚本一律停摆——
 *   这不是任何网页/插件能解决的，需要在系统层面阻止睡眠（见 README「后台运行与睡眠」）。
 *
 * 设计（单一职责 + 单例 + 懒加载）：
 *   - 只对外暴露 start / stop 两个方法，内部状态自管，避免散落全局变量。
 *   - 音频用 Web Audio 生成：振荡器(Oscillator) → 音量(Gain，开到极小) → 扬声器。
 *   - AudioContext 一律【等到用户手势时才创建】，杜绝自动播放警告。
 */

import { AUTOPILOT } from '../../common/constants.js';

const CFG = AUTOPILOT.KEEP_ALIVE;

// ============ 单例状态（集中管理，避免重复创建音频节点） ============
const state = {
  wantActive: false, // 外部是否希望保活（跟随托管开关；是真正的"意图"开关）
  audioCtx: null, // Web Audio 的音频上下文（整段静音的"播放器"）
  oscillator: null, // 振荡器节点：持续产生一个极低频的声音
  gain: null, // 音量节点：把音量压到几乎为 0
  running: false, // 是否已在真正播放（防止重复创建）
  unlockBound: false, // 是否已挂上"等用户手势解锁"的监听（防止重复挂）
};

/** 浏览器是否支持 Web Audio（极老的环境兜底，不支持就安静跳过）。 */
function audioSupported() {
  // 用索引写法读取 webkit 旧前缀，避免某些类型环境认不出 webkitAudioContext。
  return typeof window !== 'undefined' && (window.AudioContext || window['webkitAudioContext']);
}

/**
 * 当前页面是否已经有过"用户手势"。
 *   有手势才允许创建/播放音频；没有就必须等。navigator.userActivation 是标准 API，
 *   拿不到时（老浏览器）保守返回 false，走"等手势"的路径，绝不抢跑。
 */
function hasUserGesture() {
  const ua = typeof navigator !== 'undefined' ? navigator.userActivation : null;
  if (!ua) return false;
  return !!(ua.isActive || ua.hasBeenActive);
}

/**
 * 【只在确有用户手势时调用】真正建好"振荡器 → 音量 → 扬声器"的链路并发声。
 *   注意：调用方必须先确认 hasUserGesture() 或处于手势回调内，否则会触发自动播放警告。
 */
function startSilentTone() {
  if (state.running) return;
  if (!audioSupported()) return;

  // 1) 建音频上下文（相当于一个"播放器"）。兼容老式带 webkit 前缀的写法。
  const Ctx = window.AudioContext || window['webkitAudioContext'];
  if (!state.audioCtx) state.audioCtx = new Ctx();
  const ctx = state.audioCtx;

  // 2) 建"振荡器"（声源）和"音量旋钮"，把音量拧到几乎为 0。
  state.oscillator = ctx.createOscillator();
  state.gain = ctx.createGain();
  state.gain.gain.value = CFG.VOLUME; // 极小音量：听不见，但足以被判定为"在放声音"
  state.oscillator.frequency.value = CFG.FREQUENCY_HZ; // 极低频：更保险地听不到
  // 3) 接线：振荡器 → 音量 → 扬声器(destination)，然后开始发声。
  state.oscillator.connect(state.gain);
  state.gain.connect(ctx.destination);
  state.oscillator.start();

  // 4) 处于手势回调里，resume 是被允许的；恢复不了也不报错。
  if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
    ctx.resume().catch(() => {});
  }
  state.running = true;
}

/**
 * 挂一次性的"用户手势解锁"监听：
 *   没有手势时不碰音频，只等用户下次点一下游戏页面（任意处）/按键，
 *   在那个手势回调里再创建并播放音频——此时浏览器允许，不会报警告。
 */
function bindUnlockOnce() {
  if (state.unlockBound) return;
  state.unlockBound = true;

  const unlock = () => {
    removeUnlock(); // 先摘监听：解锁一次即可，避免长期占用
    if (state.wantActive) startSilentTone(); // 若这期间没被关掉，就在手势里起音
  };
  const removeUnlock = () => {
    for (const evt of CFG.UNLOCK_EVENTS) {
      window.removeEventListener(evt, unlock, true);
    }
    state.unlockBound = false;
  };

  for (const evt of CFG.UNLOCK_EVENTS) {
    // 用捕获阶段(true)监听，尽量早地拿到用户的第一个交互。
    window.addEventListener(evt, unlock, true);
  }
}

// ============ 对外接口 ============
/**
 * 开启后台保活（跟随托管开关调用）。
 *   幂等。时序安全：已有手势就立刻起音；没手势就只挂监听、等用户点一下，绝不抢跑报警告。
 */
export function startKeepAlive() {
  if (!CFG.ENABLED) return; // 配置里关掉了就什么都不做
  state.wantActive = true;
  if (state.running) return;

  if (hasUserGesture()) {
    startSilentTone(); // 已经有过手势：直接起音
  } else {
    bindUnlockOnce(); // 还没手势：等用户下次点页面再起音
  }
}

/**
 * 关闭后台保活（跟随托管关闭调用）。
 *   把音频链路拆掉、上下文关掉，释放资源，标签上的小喇叭图标随之消失。
 */
export function stopKeepAlive() {
  state.wantActive = false; // 先置意图为关：即便此刻还有待触发的手势监听，也不会再起音
  try {
    if (state.oscillator) {
      state.oscillator.stop();
      state.oscillator.disconnect();
    }
    if (state.gain) state.gain.disconnect();
    if (state.audioCtx && typeof state.audioCtx.close === 'function') {
      state.audioCtx.close().catch(() => {});
    }
  } catch {
    /* 拆链路时偶发的状态异常无所谓，直接忽略 */
  } finally {
    state.oscillator = null;
    state.gain = null;
    state.audioCtx = null;
    state.running = false;
  }
}
