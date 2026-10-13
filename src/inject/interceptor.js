/**
 * 注入脚本（运行在"页面世界 / main world"里）
 * ------------------------------------------------------------
 * 职责（单一）：劫持页面原生的 WebSocket / fetch / XMLHttpRequest，
 *   把每一笔收发的数据"复制一份"通过 window.postMessage 抛出去。
 *   它绝不修改、不拦截业务数据，只做"旁路镜像"，不影响游戏正常运行。
 *
 * 为什么必须注入到页面世界：
 *   content script 默认跑在隔离环境，拿不到页面真正的 window.WebSocket。
 *   只有把这段代码注入页面自身的执行环境，才能替换到真正被游戏使用的构造函数。
 *
 * 注意：这里不能 import 其它模块（页面环境没有模块系统），
 *   所以把需要的两个常量字符串直接写死，必须与 constants.js 中的值保持一致：
 *   - PAGE_SOURCE 对应 CHANNEL.PAGE_SOURCE
 */
(function () {
  'use strict';

  // 和 constants.js 的 CHANNEL.PAGE_SOURCE 必须一致
  const PAGE_SOURCE = 'DH_AUDIT_PAGE';
  const DIRECTION = { INBOUND: 'inbound', OUTBOUND: 'outbound' };
  const TRANSPORT = { WEBSOCKET: 'websocket', FETCH: 'fetch', XHR: 'xhr', SSE: 'sse' };

  // 统一的"抛数据"函数：把一条抓到的记录发给 content 脚本
  function emit(direction, transport, url, payload) {
    try {
      // payload 可能是 Blob/ArrayBuffer，这类二进制先转成可读文本
      if (payload instanceof ArrayBuffer) {
        payload = '[二进制 ArrayBuffer，长度 ' + payload.byteLength + ']';
      } else if (typeof Blob !== 'undefined' && payload instanceof Blob) {
        payload = '[二进制 Blob，大小 ' + payload.size + ']';
      } else if (typeof payload !== 'string') {
        // 其它非字符串尽量转字符串
        try {
          payload = JSON.stringify(payload);
        } catch {
          payload = String(payload);
        }
      }
      window.postMessage(
        {
          source: PAGE_SOURCE, // 打标记，content 只认这个来源
          record: { direction, transport, url, payload, timestamp: Date.now() },
        },
        '*'
      );
    } catch (e) {
      // 旁路工具绝不能把页面搞崩，出错就静默
    }
  }

  // ============ 1) 劫持 WebSocket ============
  const NativeWebSocket = window.WebSocket;
  if (NativeWebSocket) {
    function HookedWebSocket(url, protocols) {
      // 照常创建真正的 WebSocket
      const ws = protocols !== undefined ? new NativeWebSocket(url, protocols) : new NativeWebSocket(url);

      // 监听"收到的消息"（服务器 -> 客户端），这是查泄露最关键的方向
      ws.addEventListener('message', function (event) {
        emit(DIRECTION.INBOUND, TRANSPORT.WEBSOCKET, url, event.data);
      });

      // 包一层 send，记录"发出去的消息"（客户端 -> 服务器）
      const nativeSend = ws.send;
      ws.send = function (data) {
        emit(DIRECTION.OUTBOUND, TRANSPORT.WEBSOCKET, url, data);
        return nativeSend.apply(this, arguments);
      };

      return ws;
    }
    // 让包装后的构造函数在原型、静态常量上和原生一致，避免游戏代码报错
    HookedWebSocket.prototype = NativeWebSocket.prototype;
    HookedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
    HookedWebSocket.OPEN = NativeWebSocket.OPEN;
    HookedWebSocket.CLOSING = NativeWebSocket.CLOSING;
    HookedWebSocket.CLOSED = NativeWebSocket.CLOSED;
    window.WebSocket = HookedWebSocket;
  }

  // ============ 2) 劫持 fetch ============
  const nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      // 记录请求体（如果有）
      if (init && init.body) emit(DIRECTION.OUTBOUND, TRANSPORT.FETCH, url, init.body);

      return nativeFetch.apply(this, arguments).then(function (resp) {
        // clone 一份响应来读，否则会把流读空、影响页面
        resp
          .clone()
          .text()
          .then(function (text) {
            emit(DIRECTION.INBOUND, TRANSPORT.FETCH, url, text);
          })
          .catch(function () {});
        return resp;
      });
    };
  }

  // ============ 3) 劫持 XMLHttpRequest ============
  const NativeXHR = window.XMLHttpRequest;
  if (NativeXHR) {
    const open = NativeXHR.prototype.open;
    const send = NativeXHR.prototype.send;

    NativeXHR.prototype.open = function (method, url) {
      this.__dh_url = url; // 把 url 暂存到实例上，send/返回时用
      return open.apply(this, arguments);
    };

    NativeXHR.prototype.send = function (body) {
      const self = this;
      if (body) emit(DIRECTION.OUTBOUND, TRANSPORT.XHR, self.__dh_url, body);

      this.addEventListener('load', function () {
        try {
          emit(DIRECTION.INBOUND, TRANSPORT.XHR, self.__dh_url, self.responseText);
        } catch {}
      });
      return send.apply(this, arguments);
    };
  }

  // ============ 4) 劫持 EventSource（SSE，服务器实时推送） ============
  // 关键：River 这款游戏用 SSE（/api/rooms/{code}/events）持续推送整桌状态，
  // 里面就包含 players[].cards、board 等牌局数据。
  // SSE 是"长连接 + 持续流"，普通 fetch hook 读不到，必须单独监听每条 message。
  const NativeEventSource = window.EventSource;
  if (NativeEventSource) {
    function HookedEventSource(url, config) {
      const es = config !== undefined ? new NativeEventSource(url, config) : new NativeEventSource(url);

      // 监听默认的 message 事件（data: ... 不带 event: 名字时走这里）
      es.addEventListener('message', function (event) {
        emit(DIRECTION.INBOUND, TRANSPORT.SSE, url, event.data);
      });

      // 有些服务器会用具名事件（event: xxx）。这里包装 addEventListener，
      // 把业务代码注册的每一类事件也顺带镜像一份，做到不漏。
      const nativeAddEventListener = es.addEventListener.bind(es);
      es.addEventListener = function (type, listener, options) {
        if (type !== 'message' && type !== 'open' && type !== 'error') {
          nativeAddEventListener(type, function (event) {
            if (event && 'data' in event) {
              emit(DIRECTION.INBOUND, TRANSPORT.SSE, url + '#' + type, event.data);
            }
          });
        }
        return nativeAddEventListener(type, listener, options);
      };

      return es;
    }
    HookedEventSource.prototype = NativeEventSource.prototype;
    HookedEventSource.CONNECTING = NativeEventSource.CONNECTING;
    HookedEventSource.OPEN = NativeEventSource.OPEN;
    HookedEventSource.CLOSED = NativeEventSource.CLOSED;
    window.EventSource = HookedEventSource;
  }

  // 控制台留个记号，方便你确认注入成功
  console.log('%c[德州数据审计器] 已注入，正在镜像 WebSocket / fetch / XHR / SSE 流量', 'color:#0a0');
})();
