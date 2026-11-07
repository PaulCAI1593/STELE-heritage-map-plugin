// content/map-filter.js — #61 地图「只显示收藏」（isolated world）
//
// 在 STELE 地图右下角（图例按钮上方）加一个控件：点按钮进入「只显示收藏」并展开分组面板，
// 每个分组一个开关；再点按钮还原。过滤执行在 MAIN world 的 map-bridge.js（CustomEvent 通信）。
// 只读收藏数据，不改 schema、不持久化过滤模式。
(function () {
  'use strict';
  if (window.__HMP_MAP_FILTER_LOADED__) return;
  window.__HMP_MAP_FILTER_LOADED__ = true;

  var KEY = 'hmp:favorites:v1';
  var CMD_EVENT = 'hmp:map-filter';
  var ACK_EVENT = 'hmp:map-filter-ack';
  var READY_EVENT = 'hmp:map-filter-ready';
  var PING_EVENT = 'hmp:map-filter-ping';
  var TOKEN = 'hmpmf-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  var DEFAULT_GROUPS = [
    { id: 'g-been', name: '已去', system: true, createdAt: 0 },
    { id: 'g-want', name: '想去', system: true, createdAt: 1 },
  ];
  var BRIDGE_TIMEOUT = 600;
  var FALLBACK_RIGHT = 10;      // #63 量不到站点「图例」时的兜底定位
  var FALLBACK_BOTTOM = 76;
  var LEGEND_GAP = 8;           // 按钮底边与图例顶边的间隙

  // ---------------------------------------------------------------- 纯逻辑
  // 兼容 store.read() 的输出与 raw storage 值（schema 1/2）
  function normalizeLibrary(raw) {
    var src = raw && typeof raw === 'object' ? raw : {};
    var groups = Array.isArray(src.groups) && src.groups.length
      ? src.groups.filter(function (g) { return g && typeof g.id === 'string' && g.id; })
        .map(function (g) {
          return { id: g.id, name: String(g.name || ''), system: !!g.system, createdAt: Number(g.createdAt) || 0 };
        })
      : DEFAULT_GROUPS.map(function (g) { return { id: g.id, name: g.name, system: true, createdAt: g.createdAt }; });
    var items = Array.isArray(src.items)
      ? src.items.filter(function (it) {
        return it && typeof it.steleId === 'string' && it.steleId && typeof it.groupId === 'string';
      }).map(function (it) { return { steleId: it.steleId, groupId: it.groupId, name: String(it.name || '') }; })
      : [];
    return { groups: groups, items: items };
  }

  function groupIds(lib) { return lib.groups.map(function (g) { return g.id; }); }

  // 勾选分组的并集（同一个 steleId 只出现一次；全关 → 空集，表示全部隐藏）
  function computeKids(lib, checkedIds) {
    var want = {};
    (checkedIds || []).forEach(function (id) { want[id] = true; });
    var seen = {};
    var out = [];
    lib.items.forEach(function (it) {
      if (!want[it.groupId] || seen[it.steleId]) return;
      seen[it.steleId] = true;
      out.push(it.steleId);
    });
    return out;
  }

  function countByGroup(lib) {
    var counts = {};
    lib.items.forEach(function (it) { counts[it.groupId] = (counts[it.groupId] || 0) + 1; });
    return counts;
  }

  function freshState() { return { mode: 'off', panelOpen: false, checked: [] }; }

  // 状态机（任务书 §二）。返回 { state, effect }，effect = null | {cmd:'apply', kids} | {cmd:'clear'}
  function next(state, action, lib) {
    var s = { mode: state.mode, panelOpen: state.panelOpen, checked: state.checked.slice() };
    var type = action && action.type;
    if (type === 'button') {
      if (s.mode === 'off') {
        s.mode = 'on';
        s.panelOpen = true;
        s.checked = groupIds(lib);                       // 进入 on：默认全选
        return { state: s, effect: { cmd: 'apply', kids: computeKids(lib, s.checked) } };
      }
      s.mode = 'off';                                    // on 再点按钮（面板开/合都一样）= 还原
      s.panelOpen = false;
      s.checked = [];
      return { state: s, effect: { cmd: 'clear', kids: [] } };
    }
    if (type === 'toggle-group') {
      if (s.mode !== 'on') return { state: s, effect: null };
      var i = s.checked.indexOf(action.id);
      if (i >= 0) s.checked.splice(i, 1); else s.checked.push(action.id);
      return { state: s, effect: { cmd: 'apply', kids: computeKids(lib, s.checked) } };
    }
    if (type === 'close-panel') {
      s.panelOpen = false;                               // 点外部 / Esc：只收面板，不还原
      return { state: s, effect: null };
    }
    if (type === 'library') {                            // 收藏数据变化：不改勾选，实时重算
      var ids = groupIds(lib);
      s.checked = s.checked.filter(function (id) { return ids.indexOf(id) >= 0; });
      return { state: s, effect: s.mode === 'on' ? { cmd: 'apply', kids: computeKids(lib, s.checked) } : null };
    }
    return { state: s, effect: null };
  }

  // 面板脚注：已选组数 / 总组数 / 选中点位（同一 steleId 去重）
  function summary(lib, checkedIds) {
    var ids = groupIds(lib);
    var checked = (checkedIds || []).filter(function (id) { return ids.indexOf(id) >= 0; });
    return { selectedGroups: checked.length, totalGroups: ids.length, points: computeKids(lib, checked).length };
  }

  // #63 定位：按钮底边 = 站点「图例」顶边 - LEGEND_GAP，右边缘与图例右边缘对齐；量不到回退。
  function positionFor(legend, vw, vh) {
    var w = Number(vw) || 0, h = Number(vh) || 0;
    if (!legend || !w || !h) return { right: FALLBACK_RIGHT, bottom: FALLBACK_BOTTOM };
    return {
      right: Math.max(0, Math.round((w - legend.right) * 10) / 10),
      bottom: Math.max(0, Math.round((h - legend.top + LEGEND_GAP) * 10) / 10),
    };
  }

  var core = {
    TOKEN: TOKEN, KEY: KEY, DEFAULT_GROUPS: DEFAULT_GROUPS,
    normalizeLibrary: normalizeLibrary, groupIds: groupIds, computeKids: computeKids,
    countByGroup: countByGroup, summary: summary, positionFor: positionFor,
    FALLBACK: { right: FALLBACK_RIGHT, bottom: FALLBACK_BOTTOM, gap: LEGEND_GAP },
    freshState: freshState, next: next, buildCommand: buildCommand,
    // #62 只读调试口（测试用）：桥是否已就位、是否走了降级
    __bridge: function () {
      return { seen: bridgeSeen, injectTried: injectTried, usedFallback: usedFallback, pending: !!pending };
    },
  };

  // ---------------------------------------------------------------- 收藏数据
  // 优先复用内容侧已加载的 HMP.favoritesStore；否则直接读 storage（兼容 schema 1/2）
  function readLibrary() {
    var store = window.HMP && window.HMP.favoritesStore;
    if (store && typeof store.read === 'function') {
      return Promise.resolve().then(function () { return store.read(); })
        .then(normalizeLibrary)
        .catch(fallbackRead);
    }
    return fallbackRead();
  }

  function fallbackRead() {
    return new Promise(function (resolve) {
      var done = false;
      function finish(raw) {
        if (done) return;
        done = true;
        try { resolve(normalizeLibrary(raw)); } catch (e) { resolve(normalizeLibrary(null)); }
      }
      try {
        var local = window.chrome && window.chrome.storage && window.chrome.storage.local;
        if (!local || typeof local.get !== 'function') return finish(null);
        var p = local.get(KEY, function (obj) { finish(obj && obj[KEY]); });
        if (p && typeof p.then === 'function') p.then(function (obj) { finish(obj && obj[KEY]); }, function () { finish(null); });
      } catch (e) { finish(null); }
    });
  }

  // ---------------------------------------------------------------- 桥通信
  var bridgeSeen = false;
  var injectTried = false;
  var usedFallback = false;
  var pending = null;
  var timer = 0;
  var lastAckInstances = -1;

  function bridgeInSameWorld() {
    // 只有「world:'MAIN' 不被支持、桥被当 isolated 脚本执行」时才会为真
    return !!window.__HMP_MAP_BRIDGE_LOADED__;
  }

  function injectBridge() {
    try {
      var url = window.chrome && window.chrome.runtime && window.chrome.runtime.getURL
        ? window.chrome.runtime.getURL('content/map-bridge.js') : '';
      if (!url || !document || !document.documentElement) return false;
      var s = document.createElement('script');
      s.src = url;
      s.onerror = function () { showNotice('当前浏览器版本不支持地图过滤'); };
      (document.head || document.documentElement).appendChild(s);
      return true;
    } catch (e) { return false; }
  }

  function buildCommand(cmd, kids) {
    return { cmd: cmd, kids: (kids || []).slice(), token: TOKEN };
  }

  function send(effect) {
    try {
      window.dispatchEvent(new CustomEvent(CMD_EVENT, { detail: buildCommand(effect.cmd, effect.kids) }));
    } catch (e) {}
  }

  // #62：桥在 document_start 派发的 READY 早于本脚本（document_idle）注册监听，必丢。
  // 主动 PING 让桥立即回一次 READY，得到「桥已就位」的确定证明。
  function pingBridge() {
    try { window.dispatchEvent(new CustomEvent(PING_EVENT, { detail: {} })); } catch (e) {}
  }

  function scheduleCheck() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      if (!pending) return;
      if (!bridgeSeen) pingBridge();   // #62 兜底：ACK 丢了也先要一次「桥就位」证明（同步返回）
      if (bridgeSeen && !usedFallback) { pending = null; return; }   // 桥在，ack 可能迟到/丢失，不打扰用户
      if (injectTried) {
        pending = null;
        showNotice('当前浏览器版本不支持地图过滤');
        restoreUiOnly();
        return;
      }
      injectTried = true;
      usedFallback = injectBridge();
      if (usedFallback) { send(pending); scheduleCheck(); return; }
      pending = null;
      showNotice('当前浏览器版本不支持地图过滤');
      restoreUiOnly();
    }, BRIDGE_TIMEOUT);
  }

  function runEffect(effect) {
    if (!effect) return;
    pending = { cmd: effect.cmd, kids: effect.kids || [] };
    lastAckInstances = -1;
    send(pending);
    scheduleCheck();
  }

  // ---------------------------------------------------------------- Shadow DOM UI
  var UI = null;   // { host, root, btn, panel, rows, empty, none, notice }
  var state = freshState();
  var lib = normalizeLibrary(null);

  // #63 造型按 `02-design/总监-0.6.0-地图控件/mock.html`；文字色在 mock 基础上加深，
  // 以满足验收的对比度 ≥4.5（#8A8F98 → #6B7079 = 4.98，#9AA0A6 → #70757D = 4.64）。
  var CSS = [
    ':host{all:initial;position:fixed;right:10px;bottom:76px;z-index:30;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;color:#2B3035;line-height:1.4}',
    '.wrap{display:flex;flex-direction:column;align-items:flex-end;gap:8px}',
    '.panel{display:none;width:232px;box-sizing:border-box;padding:6px 6px 0;background:#fff;border-radius:8px;box-shadow:0 0 0 1px rgba(0,0,0,.07),0 8px 24px rgba(0,0,0,.14)}',
    '.panel.is-open{display:block;animation:hmp-mf-in .14s ease-out}',
    '@keyframes hmp-mf-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}',
    '@media (prefers-reduced-motion: reduce){.panel.is-open{animation:none}}',
    '.ptitle{padding:7px 10px 3px;font-size:11.5px;font-weight:600;letter-spacing:.06em;color:#6B7079}',
    '.row{position:relative;display:flex;align-items:center;gap:9px;height:38px;box-sizing:border-box;padding:0 10px;border-radius:5px;cursor:pointer;font-size:13px;color:#2B3035}',
    '.row:hover{background:#F5F5F4}',
    '.row input{position:absolute;width:1px;height:1px;margin:0;opacity:0;pointer-events:none}',
    '.box{width:16px;height:16px;box-sizing:border-box;border:1.5px solid #C2C6CC;border-radius:4px;background:#fff;flex:0 0 auto;position:relative}',
    '.row input:checked + .box{background:#2B3035;border-color:#2B3035}',
    '.row input:checked + .box::after{content:"";position:absolute;left:4.5px;top:1.5px;width:4px;height:8px;border:solid #fff;border-width:0 1.7px 1.7px 0;transform:rotate(45deg)}',
    '.row input:focus-visible + .box{outline:2px solid #1F5FA8;outline-offset:2px}',
    '.gname{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.gcount{flex:0 0 auto;font-size:12px;color:#70757D;font-variant-numeric:tabular-nums}',
    '.pfoot{display:flex;justify-content:space-between;gap:8px;margin:4px -6px 0;padding:8px 12px;border-top:1px solid #EFEFED;font-size:11.5px;color:#6B7079}',
    '.pfoot[hidden]{display:none}',
    '.pfoot b{font-weight:600;color:#5F6469}',
    '.pfoot .pts.is-none{color:#B23A2E}',
    '.hint{font-size:12.5px;color:#6B7079;line-height:1.6;padding:14px 12px 16px;text-align:center}',
    '.hint span{display:block}',
    '.hint[hidden]{display:none}',
    '.btn{display:flex;align-items:center;gap:6px;height:36px;box-sizing:border-box;padding:0 12px;background:#fff;border:0;border-radius:4px;box-shadow:0 0 0 1px rgba(0,0,0,.10),0 1px 3px rgba(0,0,0,.10);color:#2B3035;font-family:inherit;font-size:13px;font-weight:500;line-height:1;cursor:pointer}',
    '.btn:hover{background:#F6F6F5}',
    '.btn:focus-visible{outline:2px solid #1F5FA8;outline-offset:2px}',
    '.btn.is-on{background:#2B3035;color:#fff;box-shadow:0 0 0 1px #2B3035,0 1px 3px rgba(0,0,0,.18)}',
    '.btn.is-on:hover{background:#2B3035}',
    '.btn svg{width:15px;height:15px;flex:0 0 auto}',
    '.badge{display:none;min-width:18px;height:18px;padding:0 5px;box-sizing:border-box;border-radius:9px;background:rgba(255,255,255,.18);color:#fff;font-size:11px;font-weight:600;line-height:18px;text-align:center;font-variant-numeric:tabular-nums}',
    '.btn.is-on .badge{display:inline-block}',
  ].join('\n');

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function svgIcon() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    [['M8 2 2.2 5 8 8l5.8-3L8 2Z'], ['m2.2 8 5.8 3 5.8-3'], ['m2.2 11 5.8 3 5.8-3']].forEach(function (d) {
      var p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d[0]);
      svg.appendChild(p);
    });
    return svg;
  }

  // #63：量站点右下角「图例」按钮（文本含「图例」、贴右下、可见），用于按钮对齐定位。
  function findLegend() {
    try {
      if (!document || typeof document.querySelectorAll !== 'function') return null;
      var nodes = document.querySelectorAll('button,[role="button"],a,div,span');
      var vw = window.innerWidth || 0;
      var vh = window.innerHeight || 0;
      var best = null;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (UI && n === UI.host) continue;
        var t = (n.textContent || '').trim();
        if (!t || t.length > 12 || t.indexOf('图例') < 0) continue;
        var r = n.getBoundingClientRect();
        if (r.width < 30 || r.width > 220 || r.height < 24 || r.height > 56) continue;
        if (r.right < vw * 0.6 || r.top < vh * 0.7) continue;
        if (best && !(t.length < best.len || (t.length === best.len && r.right > best.rect.right))) continue;
        best = { len: t.length, rect: r };
      }
      return best ? best.rect : null;
    } catch (e) { return null; }
  }

  function positionUi() {
    if (!UI) return null;
    var legend = findLegend();
    var pos = positionFor(legend, window.innerWidth, window.innerHeight);
    UI.host.style.right = pos.right + 'px';
    UI.host.style.bottom = pos.bottom + 'px';
    return { legend: legend, position: pos };
  }

  function buildUi() {
    if (!document || !document.body || typeof document.createElement !== 'function') return false;
    var host = document.createElement('div');
    host.id = 'hmp-map-filter';
    if (typeof host.attachShadow !== 'function') return false;
    var root = host.attachShadow({ mode: 'open' });

    var style = el('style');
    style.textContent = CSS;
    root.appendChild(style);

    var wrap = el('div', 'wrap');
    var panel = el('div', 'panel');
    panel.setAttribute('id', 'hmp-mf-panel');
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', '按分组显示收藏');
    panel.setAttribute('aria-hidden', 'true');
    panel.appendChild(el('div', 'ptitle', '按分组显示'));

    var rows = el('div', 'rows');
    panel.appendChild(rows);
    var empty = el('div', 'hint');
    empty.appendChild(el('span', null, '收藏夹是空的'));
    empty.appendChild(el('span', null, '先在地图详情页收藏点位'));
    empty.hidden = true;
    panel.appendChild(empty);

    // #63 脚注：左「已选 X/Y 组」，右「共 N 个点位」；N=0 时右侧写「未选择分组」
    var pfoot = el('div', 'pfoot');
    var selText = el('span', 'sel');
    selText.appendChild(document.createTextNode('已选 '));
    var selB = el('b');
    selText.appendChild(selB);
    selText.appendChild(document.createTextNode(' 组'));
    var ptsText = el('span', 'pts');
    var ptsB = el('b');
    pfoot.appendChild(selText);
    pfoot.appendChild(ptsText);
    panel.appendChild(pfoot);

    var notice = el('div', 'hint');
    notice.hidden = true;
    panel.appendChild(notice);

    var btn = el('button', 'btn');
    btn.type = 'button';
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', 'hmp-mf-panel');
    btn.setAttribute('aria-pressed', 'false');
    btn.appendChild(svgIcon());
    btn.appendChild(el('span', 'label', '只显示收藏'));
    var badge = el('span', 'badge', '0');   // #63 选中点位数（仅 on 态显示）
    badge.setAttribute('aria-hidden', 'true');
    btn.appendChild(badge);

    wrap.appendChild(panel);
    wrap.appendChild(btn);
    root.appendChild(wrap);
    document.body.appendChild(host);

    UI = { host: host, root: root, btn: btn, badge: badge, panel: panel, rows: rows, empty: empty,
      pfoot: pfoot, selB: selB, pts: ptsText, ptsB: ptsB, notice: notice };

    // #63 定位：贴合站点「图例」按钮（同一右缘、其上 8px）；量不到用 CSS 兜底值。
    positionUi();
    window.addEventListener('resize', positionUi);
    [0, 600, 1500].forEach(function (d) { setTimeout(positionUi, d); });

    btn.addEventListener('click', function () { dispatch({ type: 'button' }); });
    document.addEventListener('pointerdown', function (e) {
      if (!UI || !state.panelOpen) return;
      var path = e && e.composedPath ? e.composedPath() : [];
      if (path.indexOf(UI.host) >= 0) return;
      dispatch({ type: 'close-panel' });
    }, true);
    document.addEventListener('keydown', function (e) {
      if (e && (e.key === 'Escape' || e.key === 'Esc') && state.panelOpen) dispatch({ type: 'close-panel' });
    });
    return true;
  }

  function render() {
    if (!UI) return;
    var on = state.mode === 'on';
    var hasItems = lib.items.length > 0;
    var sum = summary(lib, state.checked);
    UI.btn.classList.toggle('is-on', on);
    UI.btn.setAttribute('aria-expanded', String(state.panelOpen));
    UI.btn.setAttribute('aria-pressed', String(on));
    UI.badge.textContent = String(sum.points);
    UI.panel.classList.toggle('is-open', state.panelOpen);
    UI.panel.setAttribute('aria-hidden', String(!state.panelOpen));

    UI.rows.textContent = '';
    UI.empty.hidden = hasItems;
    UI.rows.hidden = !hasItems;
    if (hasItems) {
      var counts = countByGroup(lib);
      lib.groups.forEach(function (g) {
        var row = el('label', 'row');
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = state.checked.indexOf(g.id) >= 0;
        cb.addEventListener('change', function () { dispatch({ type: 'toggle-group', id: g.id }); });
        row.appendChild(cb);
        row.appendChild(el('span', 'box'));   // #63 自绘勾选框（原生 input 视觉隐藏，保留可访问性）
        row.appendChild(el('span', 'gname', g.name));
        row.appendChild(el('span', 'gcount', String(counts[g.id] || 0)));
        UI.rows.appendChild(row);
      });
    }

    // 脚注：已选 X/Y 组 + 共 N 个点位（N=0 显示「未选择分组」）
    UI.pfoot.hidden = !hasItems;
    UI.selB.textContent = sum.selectedGroups + '/' + sum.totalGroups;
    UI.pts.textContent = '';
    UI.pts.className = 'pts';
    if (sum.points === 0) {
      UI.pts.textContent = '未选择分组';
      UI.pts.className = 'pts is-none';
    } else {
      UI.pts.appendChild(document.createTextNode('共 '));
      UI.pts.appendChild(UI.ptsB);
      UI.ptsB.textContent = String(sum.points);
      UI.pts.appendChild(document.createTextNode(' 个点位'));
    }
    if (on && !hasItems && !UI.notice.textContent) UI.notice.hidden = true;
  }

  function showNotice(text) {
    if (!UI) return;
    UI.notice.textContent = text;
    UI.notice.hidden = false;
  }

  function restoreUiOnly() {
    state = freshState();
    render();
  }

  function dispatch(action) {
    var r = next(state, action, lib);
    state = r.state;
    render();
    runEffect(r.effect);
  }

  // 收藏数据变化：新增/删除的 kid 落在勾选分组时实时重算，不改勾选
  function watchStorage() {
    try {
      var onChanged = window.chrome && window.chrome.storage && window.chrome.storage.onChanged;
      if (!onChanged || typeof onChanged.addListener !== 'function') return;
      onChanged.addListener(function (changes, area) {
        if (area && area !== 'local') return;
        if (!changes || !changes[KEY]) return;
        readLibrary().then(function (nextLib) {
          lib = nextLib;
          dispatch({ type: 'library' });
        });
      });
    } catch (e) {}
  }

  window.addEventListener(ACK_EVENT, function (ev) {
    var d = ev && ev.detail;
    if (!d || d.token !== TOKEN) return;
    bridgeSeen = true;
    if (typeof d.instances === 'number') {
      lastAckInstances = d.instances;
      if (usedFallback && d.cmd === 'apply' && d.instances === 0) showNotice('当前浏览器版本不支持地图过滤');
    }
    if (pending && d.cmd === pending.cmd) pending = null;
  });
  window.addEventListener(READY_EVENT, function () { bridgeSeen = true; });
  // #62：监听已就位，马上 ping 一次（桥在 MAIN world 的 document_start 一定先于本脚本）
  pingBridge();

  function boot() {
    if (!buildUi()) return;                  // 无 DOM（测试/异常环境）时只保留 core
    // 旧 Chrome：MAIN world 不支持，桥被当 isolated 脚本跑了 → 主动注入页面世界副本
    if (bridgeInSameWorld()) { injectTried = true; usedFallback = injectBridge(); }
    watchStorage();
    readLibrary().then(function (nextLib) {
      lib = nextLib;
      render();
      // 桥若在 filter 之后才就绪（或需要注入），把当前状态补发一次
      if (state.mode === 'on') runEffect({ cmd: 'apply', kids: computeKids(lib, state.checked) });
    });
  }

  if (typeof document !== 'undefined' && document) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  window.HMP = window.HMP || {};
  window.HMP.mapFilter = core;
})();
