// background/service-worker.js
// Manifest V3 service worker。
//
// 主要职责：扩展安装 / 更新 / 重新加载时，清掉旧的查询缓存。
// 原因：缓存键虽然带了数据版本（见 content/cache.js 的 DATA_VERSION），
// 但扩展重新加载后仍可能残留旧版本键；而且如果哪天忘了 +1 版本号，
// 用户就会看到"代码明明修好了、界面还是旧行为"。这里做一次兜底清理。

const CACHE_BASE_PREFIX = 'hmp:cache:';

// ── #74：收藏写入的唯一写者 ──
// 弹窗、详情卡片、多个标签页各自持有一份 favorites-store 与自己的写队列；
// 同时「整键回读-改-写」时后写者的快照可能更早，整条 items 会被覆盖（丢一条）。
// 这里让 SW 成为唯一写者：消息 {type:'hmp:fav', op, args, reqId} 进一条 promise 队列，
// 按 op + args 对最新库重放。store 代码用 importScripts 复用同一份，不复制逻辑。
// 先补 self.window 兜住模块里的 window 引用，并置位 __HMP_FAV_SW_HOST__ 让 store
// 知道自己就是写者（不再往自己发消息）。
self.window = self;
self.__HMP_FAV_SW_HOST__ = true;
try {
  importScripts('../shared/favorites-store.js');
} catch (e) {
  console.error('[HMP] 收藏数据层加载失败', e);
}

const FAV_MSG_TYPE = 'hmp:fav';
const FAV_WRITE_OPS = ['add', 'remove', 'move', 'createGroup', 'renameGroup', 'deleteGroup', 'replace'];
let favQueue = Promise.resolve();

function favStore() {
  return self.HMP && self.HMP.favoritesStore ? self.HMP.favoritesStore : null;
}

function runFavOp(msg) {
  const store = favStore();
  if (!store) return Promise.resolve({ ok: false, reason: 'store' });
  const op = msg.op;
  const args = Array.isArray(msg.args) ? msg.args : [];
  if (op === 'read') return Promise.resolve(store.read());
  if (FAV_WRITE_OPS.indexOf(op) < 0) return Promise.resolve({ ok: false, reason: 'op' });
  // store 在这个上下文里会走本地队列 + 写后回读校验（异常重试一次）
  return Promise.resolve(store[op].apply(null, args));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== FAV_MSG_TYPE) return;
  const job = favQueue.then(() => runFavOp(msg));
  favQueue = job.then(() => undefined, () => undefined);
  job.then(
    result => sendResponse({ reqId: msg.reqId, ok: true, result }),
    err => sendResponse({ reqId: msg.reqId, ok: false, error: String((err && err.message) || err) })
  );
  return true;   // 异步响应
});

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

// ── #43 点工具栏图标开独立小窗（常驻到关窗）──
// 不用侧边栏：windows.create 一个 440×640 的 popup 窗口；再点图标若窗口还在就聚焦。
// chrome.windows.* 不需要任何权限；windowId 用 storage.session 记（SW 重启也能找到），
// 没有 storage.session 的环境退化为内存变量，不影响再次打开。
const PANEL_WINDOW_KEY = 'hmp:panelWindowId';
let panelWindowIdMemory = null;

function getPanelWindowId(cb) {
  try {
    if (chrome.storage && chrome.storage.session) {
      chrome.storage.session.get([PANEL_WINDOW_KEY], items => {
        const v = items && items[PANEL_WINDOW_KEY];
        cb(v == null ? null : v);
      });
      return;
    }
  } catch (e) { /* 退化到内存 */ }
  cb(panelWindowIdMemory);
}

function rememberPanelWindowId(id) {
  panelWindowIdMemory = id;
  try {
    if (chrome.storage && chrome.storage.session) {
      chrome.storage.session.set({ [PANEL_WINDOW_KEY]: id });
    }
  } catch (e) { /* 忽略：下次点击会走 create */ }
}

function forgetPanelWindowId() {
  panelWindowIdMemory = null;
  try {
    if (chrome.storage && chrome.storage.session) {
      chrome.storage.session.remove(PANEL_WINDOW_KEY);
    }
  } catch (e) { /* 忽略 */ }
}

function createPanelWindow() {
  const url = chrome.runtime.getURL('popup/popup.html') + '?window=1';
  try {
    chrome.windows.create({ url, type: 'popup', width: 440, height: 640 }, win => {
      if (win && win.id != null) rememberPanelWindowId(win.id);
    });
  } catch (e) { console.log('[HMP] 打开小窗失败:', String(e && e.message || e)); }
}

function focusOrCreatePanel() {
  getPanelWindowId(id => {
    if (id == null) { createPanelWindow(); return; }
    try {
      chrome.windows.get(id, win => {
        const err = chrome.runtime.lastError;
        if (err || !win) { createPanelWindow(); return; }
        try {
          chrome.windows.update(id, { focused: true });
        } catch (e) { createPanelWindow(); }
      });
    } catch (e) { createPanelWindow(); }
  });
}

if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener(() => focusOrCreatePanel());
}

if (chrome.windows && chrome.windows.onRemoved) {
  chrome.windows.onRemoved.addListener(id => {
    getPanelWindowId(cur => {
      if (cur != null && (cur === id || String(cur) === String(id))) forgetPanelWindowId();
    });
  });
}

// ── 跨域请求代理 ──
// MV3 起内容脚本的 fetch 受宿主页面 CORS 约束，host_permissions 不再豁免。
// 高德接口带 Access-Control-Allow-Origin 所以直连能通，百度接口不带 → 被拦。
// service worker 属于扩展自身来源，配合 host_permissions 可正常跨域，
// 因此所有地图接口请求统一经这里转发。
const HTTP_TIMEOUT_MS = 2500;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'hmp-http' || typeof msg.url !== 'string') return;
  // SW 侧也加超时：内容脚本那边虽然有超时，但 SW 若挂住会占着消息通道，
  // 这里主动 abort 让失败尽快返回，内容脚本仍按"超时→重试 1 次"处理。
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS) : null;
  fetch(msg.url, { credentials: 'omit', signal: ctrl ? ctrl.signal : undefined })
    .then(r => r.text().then(text => ({ ok: true, status: r.status, text })))
    .catch(e => {
      const aborted = ctrl && ctrl.signal && ctrl.signal.aborted;
      return { ok: false, timeout: !!aborted, error: String((e && e.message) || e) };
    })
    .then(v => { if (timer) clearTimeout(timer); sendResponse(v); });
  return true;   // 异步响应：保持消息通道打开
});
