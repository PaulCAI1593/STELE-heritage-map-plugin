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
// 超时与重试（2026-11 起）：
//   单次请求（含 SW 消息往返）最多等 2500ms；超时或网络类失败**只重试 1 次**。
//   HTTP 4xx/5xx 属业务错误，不重试。
//   超时抛出的错误带 code='HMP_TIMEOUT'，上层据此把"请求超时"与
//   "三路均未搜到候选"区分开（卡片文案不混）。
//
// 用法：const text = await window.HMP.http.fetchText(url);

(function () {
  'use strict';
  window.HMP = window.HMP || {};

  const MSG_TYPE = 'hmp-http';
  // 单次请求超时（毫秒）
  const TIMEOUT_MS = 2500;
  // 额外重试次数：0 = 不重试，1 = 失败后再试一次（最多 2 次请求）
  const RETRY_MAX = 1;

  /** 超时错误：带可判别 code，供上层区分"超时"与"没搜到"。 */
  function makeTimeoutError(what) {
    const e = new Error('请求超时（' + what + '，' + TIMEOUT_MS + 'ms）');
    e.code = 'HMP_TIMEOUT';
    e.timeout = true;
    e.timeoutMs = TIMEOUT_MS;
    return e;
  }

  /** 给任意 Promise 套单次超时；超时拒绝为 HMP_TIMEOUT。 */
  function withTimeout(promise, what) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(makeTimeoutError(what));
      }, TIMEOUT_MS);
      Promise.resolve(promise).then(
        v => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); },
        e => { if (settled) return; settled = true; clearTimeout(timer); reject(e); }
      );
    });
  }

  function sendViaBackground(url) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: MSG_TYPE, url }, resp => {
          // 读 lastError 必须在回调里立刻读，否则会被下一次调用清掉
          const err = chrome.runtime.lastError;
          if (err) { resolve({ ok: false, error: err.message || String(err) }); return; }
          resolve(resp || { ok: false, error: 'service worker 无响应' });
        });
      } catch (e) {
        resolve({ ok: false, error: (e && e.message) || String(e) });
      }
    });
  }

  /** 单次尝试：优先 SW；SW 明确失败（非超时）时退回直连。 */
  async function requestOnce(url, hasBg) {
    if (hasBg) {
      let resp;
      try {
        resp = await withTimeout(sendViaBackground(url), 'service worker');
      } catch (e) {
        // 超时：可重试，直接抛给上层（不再叠加直连，避免单次尝试耗时翻倍）
        if (e && e.code === 'HMP_TIMEOUT') throw e;
        resp = { ok: false, error: (e && e.message) || String(e) };
      }
      if (resp && resp.ok) return resp.text;
      // SW 明确失败（如未授予该域 host 权限）：退回直连，至少不比过去差
      console.warn('[HMP] 经 service worker 请求失败（' +
        (resp && resp.error) + '），改用直连');
    }

    const r = await withTimeout(fetch(url, { credentials: 'omit' }), '直连');
    if (!r.ok) {
      const e = new Error('HTTP ' + r.status);
      e.code = 'HMP_HTTP';
      e.status = r.status;
      throw e;
    }
    // 标准 fetch 都实现了 text()；少数 fetch 替身（如测试桩、部分 polyfill）
    // 只提供 json()，这里兼容一下，避免因响应对象的实现差异而整体失效。
    if (typeof r.text === 'function') return r.text();
    return JSON.stringify(await r.json());
  }

  window.HMP.http = {
    MSG_TYPE,
    TIMEOUT_MS,
    RETRY_MAX,

    /**
     * 取 URL 的响应文本。
     * 单次超时 2500ms；超时/网络失败重试 1 次；HTTP 4xx/5xx 不重试。
     * @param {string} url
     * @returns {Promise<string>}
     * @throws {Error} code='HMP_TIMEOUT' | 'HMP_HTTP'
     */
    async fetchText(url) {
      const hasBg = typeof chrome !== 'undefined' && chrome.runtime &&
        typeof chrome.runtime.sendMessage === 'function';

      let lastErr = null;
      for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
        try {
          const text = await requestOnce(url, hasBg);
          if (attempt > 0) {
            console.log('[HMP] 请求已重试 ' + attempt + ' 次后成功');
          }
          return text;
        } catch (e) {
          lastErr = e;
          // 业务错误（HTTP 状态码）不重试：重试也只会得到同样的响应
          const retryable = !e || e.code !== 'HMP_HTTP';
          if (!retryable || attempt >= RETRY_MAX) break;
          console.warn('[HMP] 请求失败（' + ((e && e.message) || e) +
            '），重试 1 次');
        }
      }
      throw lastErr;
    },
  };
})();
