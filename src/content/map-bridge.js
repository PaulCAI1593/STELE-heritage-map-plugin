// content/map-bridge.js — #61 地图「只显示收藏」的 MAIN world 桥
//
// 站点是 React 18 + mapbox-gl 1.7.0（UMD，挂 window.mapboxgl 全局），地图实例不在 DOM 里。
// 本脚本在 document_start 拦 window.mapboxgl 的赋值（setter）+ Proxy 包 Map 构造拿到实例，
// 收 isolated 侧发来的 CustomEvent('hmp:map-filter')，对全部 ^hc_site* 层与 hc_traditional_village
// 同时 setFilter；clear 时置回 null。
//
// 只读站点、不改站点行为；异常一律吞掉，不向页面抛错。
// 降级：旧 Chrome（<111，不支持 world:"MAIN"）由 isolated 侧用 <script> 注入本文件到页面世界。
(function () {
  'use strict';
  if (window.__HMP_MAP_BRIDGE_LOADED__) return;
  window.__HMP_MAP_BRIDGE_LOADED__ = true;

  var CMD_EVENT = 'hmp:map-filter';
  var ACK_EVENT = 'hmp:map-filter-ack';
  var READY_EVENT = 'hmp:map-filter-ready';
  var VILLAGE_LAYER = 'hc_traditional_village';
  var LAYER_PREFIX = 'hc_site';
  var MAX_INSTANCES = 8;

  var instances = [];
  var state = null;          // { token, kids: [] } —— 当前 apply 状态
  var boundToken = null;     // 首个合法命令的 token 绑定本页
  var wrapped = null;        // 当前包过的 mapboxgl
  var installed = false;

  function matchLayer(id) {
    if (typeof id !== 'string') return false;
    return id === VILLAGE_LAYER || id.indexOf(LAYER_PREFIX) === 0;
  }

  function buildFilter(kids) {
    return ['in', ['get', 'kid'], ['literal', (kids || []).slice()]];
  }

  function layersOf(map) {
    try {
      var style = map && map.getStyle && map.getStyle();
      return (style && style.layers) || [];
    } catch (e) { return []; }
  }

  // 对一张地图的全部文保层设同一个过滤表达式；返回设成功的层数
  function applyToMap(map, kids) {
    var layers = layersOf(map);
    var count = 0;
    for (var i = 0; i < layers.length; i++) {
      var id = layers[i] && layers[i].id;
      if (!matchLayer(id)) continue;
      try { map.setFilter(id, buildFilter(kids)); count++; } catch (e) { /* 单层失败不影响其它层 */ }
    }
    return count;
  }

  function clearOnMap(map) {
    var layers = layersOf(map);
    var count = 0;
    for (var i = 0; i < layers.length; i++) {
      var id = layers[i] && layers[i].id;
      if (!matchLayer(id)) continue;
      try { map.setFilter(id, null); count++; } catch (e) {}
    }
    return count;
  }

  function reapplyToMap(map) {
    if (!state) return;
    applyToMap(map, state.kids);
  }

  function track(map) {
    if (!map || instances.indexOf(map) >= 0 || instances.length >= MAX_INSTANCES) return;
    instances.push(map);
    try {
      // 站点切样式 / 二次加载后 filter 会丢，补设
      map.on('style.load', function () { reapplyToMap(map); });
      map.on('styledata', function () { reapplyToMap(map); });
    } catch (e) {}
    // 新建实例时若已处于 apply 状态（站点二次创建地图），立刻补设
    reapplyToMap(map);
  }

  function wrapMapboxgl(gl) {
    if (!gl || typeof gl !== 'object') return gl;
    if (wrapped && gl === wrapped) return wrapped;
    try {
      var OrigMap = gl.Map;
      if (typeof OrigMap !== 'function') return gl;
      var MapProxy = new Proxy(OrigMap, {
        construct: function (target, args) {
          var inst = Reflect.construct(target, args, target);
          track(inst);
          return inst;
        },
      });
      var glProxy = new Proxy(gl, {
        get: function (t, k) {
          if (k === 'Map') return MapProxy;
          return Reflect.get(t, k);
        },
      });
      return glProxy;
    } catch (e) {
      return gl;
    }
  }

  function install() {
    if (installed) return true;
    try {
      var desc = Object.getOwnPropertyDescriptor(window, 'mapboxgl');
      if (desc && desc.configurable === false) return false;
    } catch (e) {}
    try {
      var current = null;
      Object.defineProperty(window, 'mapboxgl', {
        configurable: true,
        enumerable: true,
        get: function () { return current; },
        set: function (v) { current = wrapMapboxgl(v); wrapped = current; },
      });
      installed = true;
      return true;
    } catch (e) { return false; }
  }

  function ack(detail) {
    try {
      window.dispatchEvent(new CustomEvent(ACK_EVENT, { detail: detail }));
    } catch (e) {}
  }

  function onCommand(ev) {
    var d = ev && ev.detail;
    if (!d || (d.cmd !== 'apply' && d.cmd !== 'clear')) return;
    if (typeof d.token !== 'string' || !d.token) return;
    if (boundToken === null) boundToken = d.token;
    if (d.token !== boundToken) return;      // 非法 token（非本页）忽略

    var kids = Array.isArray(d.kids) ? d.kids.filter(function (x) { return typeof x === 'string' && x; }) : [];
    var layers = 0;
    if (d.cmd === 'apply') {
      state = { token: d.token, kids: kids.slice() };
      for (var i = 0; i < instances.length; i++) layers += applyToMap(instances[i], kids);
      ack({ token: d.token, cmd: 'apply', ok: true, kids: kids.length, instances: instances.length, layers: layers });
    } else {
      state = null;
      for (var j = 0; j < instances.length; j++) layers += clearOnMap(instances[j]);
      ack({ token: d.token, cmd: 'clear', ok: true, kids: 0, instances: instances.length, layers: layers });
    }
  }

  install();
  try { window.addEventListener(CMD_EVENT, onCommand); } catch (e) {}
  try { window.dispatchEvent(new CustomEvent(READY_EVENT, { detail: {} })); } catch (e) {}

  // 只读调试口（证据脚本 / 排障用），不改变站点行为
  try {
    window.__HMP_MAP_BRIDGE__ = {
      version: 1,
      matchLayer: matchLayer,
      instances: function () { return instances.slice(); },
      state: function () { return state ? { kids: state.kids.slice(), token: state.token } : null; },
      installed: function () { return installed; },
    };
  } catch (e) {}
})();
