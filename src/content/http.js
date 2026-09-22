// content/http.js
// 统一的跨域请求入口。
//
// 为什么需要它：
//   Chrome 从 MV3 起**移除了内容脚本绕过 CORS 的能力**
//   （见 Chromium 的 "Changes to Cross-Origin Requests in Chrome Extension
//     Content Scripts"）。内容脚本里的 fetch 受**宿主页面**的 CORS 策略约束，
//   host_permissions 不再能让它豁免。
//
//   而两家地图接口的 CORS 策略不同：
//     · 高德 restapi.amap.com   → 带 Access-Control-Allow-Origin，直连可通
//     · 百度 api.map.baidu.com  → 不带，请求被浏览器拦下
//   于是百度侧三路全空。更糟的是各路径把异常吞掉了，卡片只报
//   "三路均未搜到候选"，长期被误判为参数问题。
//
// 做法：统一改走 background service worker —— 它属于扩展自身来源，
//       配合 host_permissions 不受页面 CORS 限制。
//
// 用法：const text = await window.HMP.http.fetchText(url);

(function () {
  'use strict';
  window.HMP = window.HMP || {};

  const MSG_TYPE = 'hmp-http';

  function sendViaBackground(url) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: MSG_TYPE, url }, resp => {
        // 读 lastError 必须在回调里立刻读，否则会被下一次调用清掉
        const err = chrome.runtime.lastError;
        if (err) { resolve({ ok: false, error: err.message || String(err) }); return; }
        resolve(resp || { ok: false, error: 'service worker 无响应' });
      });
    });
  }

  window.HMP.http = {
    MSG_TYPE,

    /**
     * 取 URL 的响应文本。
     * 优先走 service worker；不可用时退回直连（至少不比过去差）。
     * @param {string} url
     * @returns {Promise<string>}
     */
    async fetchText(url) {
      const hasBg = typeof chrome !== 'undefined' && chrome.runtime &&
        typeof chrome.runtime.sendMessage === 'function';

      if (hasBg) {
        try {
          const resp = await sendViaBackground(url);
          if (resp && resp.ok) return resp.text;
          console.warn('[HMP] 经 service worker 请求失败（' +
            (resp && resp.error) + '），改用直连');
        } catch (e) {
          console.warn('[HMP] service worker 消息异常（' + e.message + '），改用直连');
        }
      }

      const r = await fetch(url, { credentials: 'omit' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      // 标准 fetch 都实现了 text()；少数 fetch 替身（如测试桩、部分 polyfill）
      // 只提供 json()，这里兼容一下，避免因响应对象的实现差异而整体失效。
      if (typeof r.text === 'function') return r.text();
      return JSON.stringify(await r.json());
    },
  };
})();
