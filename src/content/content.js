/**
 * 内容脚本（content script，运行在"隔离世界"）
 * ------------------------------------------------------------
 * 职责（单一）：当"桥梁"。
 *   1) 把 inject/interceptor.js 以 <script> 形式塞进页面世界（让它能劫持原生 API）。
 *   2) 监听页面世界通过 postMessage 抛出来的抓包数据，转发给 background。
 *
 * 为什么需要它：
 *   - 页面世界能拿到真·WebSocket，但拿不到 chrome.runtime（没法跟后台通信）。
 *   - content script 能用 chrome.runtime，但拿不到真·WebSocket。
 *   两边各有所长，用 postMessage 搭桥，正好互补。
 */

// 这几个常量必须与 constants.js 保持一致。
// content script 用普通 <script> 加载、不走模块打包，这里直接内联以避免引入构建工具。
const PAGE_SOURCE = 'DH_AUDIT_PAGE';
const RUNTIME_CAPTURE = 'CAPTURE';

// —— 第一步：把注入脚本插进页面世界 ——
// 用 chrome.runtime.getURL 拿到插件内文件的真实地址，再作为 <script src> 注入。
// 注入完成后立刻移除标签（脚本已经执行，不需要留在 DOM 里）。
(function injectInterceptor() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('src/inject/interceptor.js');
  script.onload = function () {
    this.remove();
  };
  // 尽量早地注入，赶在页面建立 WebSocket 之前
  (document.head || document.documentElement).appendChild(script);
})();

// —— 第二步：接收页面抛来的数据，转发给后台 ——
window.addEventListener('message', function (event) {
  // 只处理本页面、且带我们标记的消息，忽略其它一切
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== PAGE_SOURCE || !data.record) return;

  // 转发给 background。用 catch 兜底：后台偶尔在 reload 时连接会短暂断开。
  try {
    chrome.runtime.sendMessage({ type: RUNTIME_CAPTURE, record: data.record }).catch(() => {});
  } catch (e) {
    // service worker 处于未就绪状态时可能抛错，忽略即可，下一条还会再发
  }
});

// —— 第三步：加载"自动托管"控制器（运行在隔离世界）——
// 为什么用动态 import()：
//   manifest 里注册的 content script 是普通脚本、不能用静态 import。
//   但在隔离世界里可以用动态 import() 加载"扩展内的 ES 模块"（需在
//   web_accessible_resources 里登记）。这样托管各模块仍保持 ES Module 分层，
//   不必把常量/逻辑抄一遍，符合"模块化 + 常量集中"的原则。
(function loadAutopilot() {
  const url = chrome.runtime.getURL('src/content/autopilot/controller.js');
  // 托管默认是关闭的，加载进来也不会乱动；它会自己读 storage 决定要不要跑。
  import(url).catch(() => {
    // 加载失败不影响抓包/胜率主功能，忽略即可
  });
})();
