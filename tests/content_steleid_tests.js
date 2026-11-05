// tests/content_steleid_tests.js
// #32a · steleId 出口：feature 载荷不被污染，id 通过独立公开出口暴露
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const env = require('./_env');
const { check, finish } = env.makeChecker('content-steleid');

const SRC = path.join(__dirname, '..', 'src', 'content');
const code = fs.readFileSync(path.join(SRC, 'content.js'), 'utf8');
const BODY = JSON.stringify({ name: '故宫', feature_type: '博物馆', address: '景山前街4号' });

function makeSandbox() {
  const events = [];
  const timers = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Math, Number, String, Array, Object, JSON, Promise, Map, Set,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    setInterval: () => 0,
    setTimeout: (fn) => { timers.push(fn); return 0; },
    history: { state: null, pushState() {}, replaceState() {}, back() {} },
    location: {
      href: 'http://stele.geogv.org/zhcn/geo/abc',
      pathname: '/zhcn/geo/abc', hash: '', search: '',
      origin: 'http://stele.geogv.org',
    },
  };
  sandbox.window = sandbox;
  sandbox.window.HMP = { decoder: { normalize: x => x } };
  sandbox.window.addEventListener = () => {};
  sandbox.window.dispatchEvent = (e) => { events.push(e); return true; };
  sandbox.fetch = async (url) => ({
    ok: true, status: 200,
    clone() { return { text: async () => BODY }; },
    async text() { return BODY; },
  });
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { sandbox, events };
}

(async () => {
  const { sandbox, events } = makeSandbox();
  const HMP = sandbox.window.HMP;

  check('加载后暴露 HMP.content.currentSteleId()', HMP.content && typeof HMP.content.currentSteleId === 'function');
  check('未派发时按 URL 回退', HMP.content.currentSteleId() === 'abc');

  // 模拟站点自己的请求经过劫持钩子 → 缓存并按当前 URL 派发
  await sandbox.fetch('/api/v1/feature/abc');
  await new Promise(r => setTimeout(r, 20));

  check('劫持派发一次 hmp:poi-loaded', events.length === 1, String(events.length));
  const ev = events[0] || {};
  check('事件 detail 是原始 feature（未被塞 id）',
    !!ev.detail && ev.detail.name === '故宫' &&
    !('steleId' in ev.detail) && !('__steleId' in ev.detail) && !('hmpSteleId' in ev.detail),
    JSON.stringify(Object.keys(ev.detail || {})));

  check('派发后 currentSteleId() 返回派发 id', HMP.content.currentSteleId() === 'abc');
  check('HMP.debug.status() 保持兼容且 id 正确',
    HMP.debug && typeof HMP.debug.status === 'function' &&
    HMP.debug.status().识别到的点位id === 'abc' &&
    typeof HMP.debug.status().模块 === 'object');

  // 切到别的点但仍未派发新响应：公开出口优先给最近派发 id（与卡片内容严格对应）
  sandbox.location.pathname = '/zhcn/geo/def';
  check('优先返回最近派发 id（不被 URL 覆盖）', HMP.content.currentSteleId() === 'abc');

  // 载荷对象没有被写入任何内部字段（缓存/决策日志会把它序列化）
  check('feature 载荷键集合原样',
    JSON.stringify(Object.keys(ev.detail || {}).sort()) === JSON.stringify(['address', 'feature_type', 'name']),
    JSON.stringify(Object.keys(ev.detail || {})));

  finish();
})();
