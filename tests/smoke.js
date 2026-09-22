// tests/smoke.js
// 冒烟测试：严格按 manifest.json 里 content_scripts 的顺序加载全部脚本，
// 确认在"接近浏览器"的环境下无加载错误、各模块均正确注册。
//
// 运行:
//   node tests/smoke.js                     校验 src/
//   node tests/smoke.js release/heritage-map-plugin   校验打包产物
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const EXT_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'src');
const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
const jsFiles = manifest.content_scripts[0].js;
console.log('校验目录: ' + EXT_DIR);

// ---- 构造一个共享的浏览器式全局对象 ----
function makeEl(tag) {
  return {
    tagName: tag, children: [], style: {}, attributes: {}, dataset: {},
    className: '', id: '', _text: '', _html: '',
    nodeType: 1,
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k]; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {}, removeEventListener() {}, remove() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    matches() { return false; },
    classList: { add() {}, remove() {}, contains() { return false; } },
    set textContent(v) { this._text = v; }, get textContent() { return this._text; },
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
  };
}

const listeners = {};
const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  URLSearchParams, URL, TextEncoder, TextDecoder,
  Promise, JSON, Math, Date, Number, String, Array, Object, RegExp, Error,
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;

sandbox.location = { href: 'http://stele.geogv.org/zhcn/', pathname: '/zhcn/', hash: '' };
sandbox.history = { pushState: () => {}, replaceState: () => {} };
sandbox.addEventListener = (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); };
sandbox.removeEventListener = () => {};
sandbox.dispatchEvent = () => true;
sandbox.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
sandbox.Request = class {};
sandbox.MutationObserver = class { observe() {} disconnect() {} };
sandbox.document = {
  body: makeEl('body'),
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: makeEl,
  createTextNode: (t) => ({ nodeType: 3, textContent: t }),
};
sandbox.chrome = {
  storage: { local: {
    _store: {},
    get(k, cb) { const store = this._store || {}; const o = (k == null) ? Object.assign({}, store) : (() => { const r = {}; for (const x of (Array.isArray(k) ? k : [k])) if (x in store) r[x] = store[x]; return r; })(); if (cb) cb(o); return Promise.resolve(o); },
    set(i, cb) { Object.assign(this._store, i); if (cb) cb(); return Promise.resolve(); },
    remove(k, cb) { (Array.isArray(k) ? k : [k]).forEach(x => delete this._store[x]); if (cb) cb(); return Promise.resolve(); },
  } },
  runtime: { onInstalled: { addListener() {} } },
};
sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), clone() { return this; }, text: async () => '' });

const context = vm.createContext(sandbox);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (detail ? '  → ' + detail : '')); }
}

console.log('\n=== 冒烟：按 manifest 顺序加载 content scripts ===');
console.log('顺序: ' + jsFiles.join(' → ') + '\n');

for (const f of jsFiles) {
  const p = path.join(EXT_DIR, f);
  try {
    const code = fs.readFileSync(p, 'utf8');
    vm.runInContext(code, context, { filename: f });
    console.log('  ✅ 加载成功: ' + f);
    pass++;
  } catch (e) {
    console.log('  ❌ 加载失败: ' + f + ' → ' + e.message);
    fail++;
  }
}

console.log('\n=== 模块注册检查 ===');
const HMP = sandbox.window.HMP;
check('window.HMP 已创建', !!HMP);
for (const mod of ['decoder', 'naming', 'geo', 'cache', 'apis', 'matcher', 'card']) {
  check('HMP.' + mod + ' 已注册', !!HMP && !!HMP[mod]);
}
check('HMP.apis.amap.search 可用', typeof HMP?.apis?.amap?.search === 'function');
check('HMP.apis.amap.searchAround 可用', typeof HMP?.apis?.amap?.searchAround === 'function');
check('HMP.geo.steleToWgs84 可用', typeof HMP?.geo?.steleToWgs84 === 'function');
check('HMP.apis.baidu.search 可用', typeof HMP?.apis?.baidu?.search === 'function');
check('HMP.matcher.pick 可用', typeof HMP?.matcher?.pick === 'function');
check('HMP.card.processSingle 可用', typeof HMP?.card?.processSingle === 'function');
// processGroup 已移除（文物组不显示表格，只用 buildGroupContext 提取上下文）
check('HMP.debug.status 可用（content.js 已执行）', typeof HMP?.debug?.status === 'function');
check('fetch 已被劫持', sandbox.window.__HMP_FETCH_HOOK_INSTALLED__ === true);
check('hmp:poi-loaded 监听已注册', (listeners['hmp:poi-loaded'] || []).length > 0);

console.log('\n结果: 通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
