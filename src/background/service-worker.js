// background/service-worker.js
// Manifest V3 service worker。
//
// 主要职责：扩展安装 / 更新 / 重新加载时，清掉旧的查询缓存。
// 原因：缓存键虽然带了数据版本（见 content/cache.js 的 DATA_VERSION），
// 但扩展重新加载后仍可能残留旧版本键；而且如果哪天忘了 +1 版本号，
// 用户就会看到"代码明明修好了、界面还是旧行为"。这里做一次兜底清理。

const CACHE_BASE_PREFIX = 'hmp:cache:';

function clearQueryCache(reason) {
  chrome.storage.local.get(null, items => {
    const keys = Object.keys(items || {}).filter(k => k.startsWith(CACHE_BASE_PREFIX));
    if (!keys.length) {
      console.log('[HMP] 无缓存需清理（' + reason + '）');
      return;
    }
    chrome.storage.local.remove(keys, () => {
      console.log('[HMP] 已清理 ' + keys.length + ' 条查询缓存（' + reason + '）');
    });
  });
}

chrome.runtime.onInstalled.addListener(details => {
  const reason = (details && details.reason) || 'unknown';
  console.log('[HMP] onInstalled:', reason);
  // install / update 时旧缓存可能来自不同版本，清掉以免误导
  if (reason === 'install' || reason === 'update') {
    clearQueryCache(reason);
  }
});

// 扩展被手动「重新加载」时也会走到这里（MV3 下 SW 每次启动都会执行顶层代码）
self.addEventListener('activate', () => {
  console.log('[HMP] service worker activated');
});

console.log('[HMP] service worker 已启动');

// ── 跨域请求代理 ──
// MV3 起内容脚本的 fetch 受宿主页面 CORS 约束，host_permissions 不再豁免。
// 高德接口带 Access-Control-Allow-Origin 所以直连能通，百度接口不带 → 被拦。
// service worker 属于扩展自身来源，配合 host_permissions 可正常跨域，
// 因此所有地图接口请求统一经这里转发。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'hmp-http' || typeof msg.url !== 'string') return;
  fetch(msg.url, { credentials: 'omit' })
    .then(r => r.text().then(text => ({ ok: true, status: r.status, text })))
    .catch(e => ({ ok: false, error: String((e && e.message) || e) }))
    .then(sendResponse);
  return true;   // 异步响应：保持消息通道打开
});
