// content.js
// 识别用户当前查看的文保点位，并把数据广播给 card.js。
//
// 两条识别路径（互为备份）：
//   ① 劫持 window.fetch，从站点的 /api/v1/feature/{id} 响应里直接取数据（零额外请求）
//   ② 按 URL 里的 /geo/{id} 主动拉取 /api/v1/feature/{id}
//      —— 兜底：若站点改用 XHR、或响应结构变化导致 ① 失效，仍能工作
//
// 之所以要 ②：站点是「先拉数据 → 再渲染弹窗」，且详情面板的 DOM 结构、
// 请求方式都可能随站点更新而变化。只靠单一机制容易整体失效且难以察觉。

(function () {
  'use strict';
  if (window.__HMP_FETCH_HOOK_INSTALLED__) return;
  window.__HMP_FETCH_HOOK_INSTALLED__ = true;

  const FEATURE_RE = /\/api\/v1\/(?:feature|query)\/([^/?]+)/;
  // 详情面板路由：/zhcn/geo/<id>、/info/<id>、/detail/<id>
  const ROUTE_RE = /\/(?:zhcn|enus)\/(?:geo|info|detail)\/([^/?#]+)/;
  const HASH_RE = /\/(?:geo|info|detail)\/([^/?#]+)/;
  const FALLBACK_DELAY = 800;   // 劫持没拿到时，等这么久再自己去拉

  function toast(msg, level) {
    (level === 'warn' ? console.warn : console.log)('[HMP] ' + msg);
  }

  function tryDecode(body) {
    if (body == null) return null;
    try {
      return window.HMP.decoder.normalize(JSON.parse(body));
    } catch (e) {
      return null;
    }
  }

  function dispatchFeature(feature, source) {
    if (!feature || !feature.name) return;
    toast('获取点位成功（来源：' + source + '）：' + feature.name);
    window.dispatchEvent(new CustomEvent('hmp:poi-loaded', { detail: feature }));
  }

  // 「最近一次派发给 card.js 的 id」。
  // 注意必须是**单个 id**而不是"派发过的集合"：用户会 A → B → A 来回切，
  // 用集合记录的话，切回 A 时会认为"早就派发过"而不再派发，
  // 卡片就永久停在 B 上（实测：项目组 ↔ 子项目 来回点，表格再也回不来）。
  let lastDispatchedId = null;
  function announce(id, feature, source) {
    lastDispatchedId = id;
    lastHandledId = id;
    dispatchFeature(feature, source);
  }

  // ========== 原始 fetch（后续自用，避免被自己的钩子二次拦截）==========
  const origFetch = window.fetch.bind(window);

  // 已通过劫持拿到的 feature，按 id 缓存，供 URL 兜底路径复用
  const hijacked = new Map();   // id -> feature

  // ========== 路径 ①：劫持 fetch ==========
  // 这里只负责「缓存」，不盲目派发：切换点位时，上一个点位的响应可能晚于导航返回，
  // 若此时直接派发，卡片会被钉回旧点位；而 URL 兜底又会因为 hijacked 里已有该 id
  // 而跳过，于是卡片永久停在上一个点位。派发一律由 checkUrl 按当前 URL 决定。
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input
      : input instanceof Request ? input.url
      : (input && input.url) || '';

    const response = await origFetch(input, init);

    const m = url.match(FEATURE_RE);
    if (!m) return response;

    const id = m[1];
    response.clone().text().then(text => {
      const decoded = tryDecode(text);
      if (!decoded || !decoded.name) return;
      hijacked.set(id, decoded);
      if (!currentGeoId()) {
        // 路由形态变了、认不出 id：退回到「谁回来就派发谁」
        dispatchFeature(decoded, 'fetch 劫持');
      } else if (currentGeoId() === id && lastDispatchedId !== id) {
        // 正是当前点位：立刻派发，省掉兜底路径的等待
        announce(id, decoded, 'fetch 劫持');
      }
      // 其余情况（响应先于导航返回）只缓存，交给 checkUrl 在 URL 到位后派发
    }).catch(() => { /* 读不到就算了，交给 URL 兜底 */ });

    return response;
  };

  // ========== 路径 ②：按 URL 主动拉取 ==========
  function currentGeoId() {
    const m = location.pathname.match(ROUTE_RE);
    if (m) return m[1];
    const h = location.hash.match(HASH_RE);
    return h ? h[1] : null;
  }

  function localeOf() {
    return location.pathname.indexOf('/enus') === 0 ? 'enus' : 'zhcn';
  }

  async function fetchFeatureById(id) {
    const url = location.origin + '/api/v1/feature/' + encodeURIComponent(id) +
      '?locale=' + localeOf();
    const r = await origFetch(url, { credentials: 'omit' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return tryDecode(await r.text());
  }

  let lastHandledId = null;

  async function checkUrl() {
    const id = currentGeoId();
    if (!id) return;

    // 劫持已经拿到 → 不发多余请求。注意这里必须补一次派发：
    // 响应可能先于导航返回，当时只做了缓存。
    if (hijacked.has(id)) {
      // 可能只是缓存过（响应先于导航返回），也可能用户从别处切回来了 —— 都要补派发
      if (lastDispatchedId !== id) announce(id, hijacked.get(id), 'fetch 劫持');
      return;
    }

    if (id === lastHandledId) return;   // 兜底拉取已发起过
    lastHandledId = id;

    // 给 ① 一点时间（它和本站请求是同一次导航触发的）
    await new Promise(res => setTimeout(res, FALLBACK_DELAY));
    if (hijacked.has(id)) {                  // ① 赶上了
      // 但用户可能已经切走，不能把旧点位派发到新点位上
      if (currentGeoId() === id && lastDispatchedId !== id) announce(id, hijacked.get(id), 'fetch 劫持');
      return;
    }
    if (currentGeoId() !== id) return;       // 用户已经切走

    try {
      const feature = await fetchFeatureById(id);
      if (feature && feature.name) {
        hijacked.set(id, feature);
        // 拉取期间用户可能又切走了，再确认一次
        if (currentGeoId() === id) announce(id, feature, 'URL 兜底');
      } else {
        toast('按 URL 拉取到空数据（id=' + id + '）', 'warn');
      }
    } catch (e) {
      toast('按 URL 拉取点位失败（id=' + id + '）：' + e.message, 'warn');
    }
  }

  // 路由变化：React Router 用 pushState，不触发 popstate，所以两个都挂
  window.addEventListener('popstate', () => setTimeout(checkUrl, 30));
  const origPush = history.pushState.bind(history);
  history.pushState = function (...args) {
    const r = origPush(...args);
    setTimeout(checkUrl, 30);
    return r;
  };
  const origReplace = history.replaceState.bind(history);
  history.replaceState = function (...args) {
    const r = origReplace(...args);
    setTimeout(checkUrl, 30);
    return r;
  };

  // 兜底轮询（400ms，开销可忽略）：覆盖任何漏掉的路由变化方式
  setInterval(checkUrl, 400);
  checkUrl();

  // 供 card.js 按 id 拉取点位：文物组的子项目（members）只带 kid/name/geom，
  // 但 kid 就是子项目自己的 feature id，拉一次能拿到它自己的地址与简介。
  window.HMP.featureApi = { fetchById: fetchFeatureById };

  // ========== 调试入口 ==========
  // 注意：card.js 也往 HMP.debug 上挂了 inspect，这里必须"合并"而不是覆盖
  window.HMP.debug = Object.assign(window.HMP.debug || {}, {
    /** 手动触发一次点位加载（用于排查） */
    fire(poi) {
      window.dispatchEvent(new CustomEvent('hmp:poi-loaded', { detail: poi }));
    },
    /** 概览 */
    status() {
      return {
        已注入: true,
        模块: Object.keys(window.HMP || {}),
        当前路由: location.href,
        识别到的点位id: currentGeoId(),
        已缓存点位: Array.from(hijacked.keys()),
      };
    },
    /** DOM 现场诊断（由 card.js 提供） */
    inspect() {
      return window.HMP.card && window.HMP.card.inspect
        ? window.HMP.card.inspect()
        : { 错误: 'card.js 未加载' };
    }
  });

  toast('content script 已加载。控制台可执行 HMP.debug.inspect() 查看诊断。');
})();
