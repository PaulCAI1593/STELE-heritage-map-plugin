#!/usr/bin/env node
// tests/update_state_tests.js —— #21：更新检测四态（checking/latest/behind/error）+ 缓存 ahead 文案
// + 主链路 404 回落 jsDelivr + 两路都失败。纯桩环境，不发真实网络请求。
const fs = require('fs');
const path = require('path');

const JS_PATH = path.join(__dirname, '..', 'src', 'popup', 'popup.js');
const src = fs.readFileSync(JS_PATH, 'utf8');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('✅ ' + name); }
  else { fail++; console.log('❌ ' + name + (detail ? '  [' + detail + ']' : '')); }
}

// ---------------- 最小 DOM 桩 ----------------
const els = {};
function fakeEl(id) {
  return {
    id, textContent: '', className: '', hidden: false, disabled: false, href: '', value: '',
    attrs: {}, style: {}, dataset: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, focus() {}, click() {},
    querySelectorAll: () => [], classList: { add() {}, remove() {}, toggle() {} },
  };
}
function el(id) { if (!els[id]) els[id] = fakeEl(id); return els[id]; }

global.window = global;
global.HMP = {};
global.document = {
  documentElement: fakeEl('html'),
  body: { appendChild() {} },
  getElementById: id => (els[id] || (els[id] = fakeEl(id))),
  querySelectorAll: () => [],
  querySelector: () => null,
  createElement: () => fakeEl('tmp'),
  addEventListener() {},
};

// ---------------- chrome.storage 桩 ----------------
const storageData = Object.create(null);
global.chrome = {
  storage: {
    local: {
      get(keys, cb) {
        const out = {};
        const list = keys == null ? Object.keys(storageData) : (Array.isArray(keys) ? keys : [keys]);
        for (const k of list) if (k in storageData) out[k] = storageData[k];
        if (typeof cb === 'function') cb(out);
        return Promise.resolve(out);
      },
      set(obj, cb) { Object.assign(storageData, obj); if (cb) cb(); return Promise.resolve(); },
      remove(keys, cb) {
        for (const k of (Array.isArray(keys) ? keys : [keys])) delete storageData[k];
        if (cb) cb();
        return Promise.resolve();
      },
      clear(cb) { for (const k of Object.keys(storageData)) delete storageData[k]; if (cb) cb(); },
    },
  },
  runtime: { getManifest: () => ({ version: '0.4.2' }) },
  tabs: { create() {} },
};

// ---------------- fetch 桩 ----------------
let fetchHandler = null;
const fetchCalls = [];
global.fetch = (url) => { fetchCalls.push(String(url)); return Promise.resolve(fetchHandler ? fetchHandler(String(url)) : { ok: true, status: 200, json: async () => ({}) }); };

// 加载 popup.js（DOMContentLoaded 不触发 → 只定义函数，不跑 bind/load）
(0, eval)(src);

const U = global.HMP.popup.update;

// ---------------- 1. 四态纯函数 ----------------
console.log('\n=== 1. decide() 四态 ===');
{
  const same = U.decide({ tag: 'v0.4.2', version: '0.4.2', viaMirror: false }, '0.4.2');
  check('latest：本机 = 上游 → 已是最新 · 上游 v0.4.2',
    same.state === 'latest' && same.ahead === false && same.text === '已是最新 · 上游 v0.4.2', JSON.stringify(same));

  const ahead = U.decide({ tag: 'v0.4.1', version: '0.4.1', viaMirror: false }, '0.4.2');
  check('latest（本机领先）：0.4.2 > 0.4.1 → 已领先上游 v0.4.1（不能写已是最新）',
    ahead.state === 'latest' && ahead.ahead === true && ahead.text === '已领先上游 v0.4.1', JSON.stringify(ahead));

  const behind = U.decide({ tag: 'v0.4.3', version: '0.4.3', url: 'https://x/releases/v0.4.3', viaMirror: false }, '0.4.2');
  check('available：上游 0.4.3 > 本机 → 有新版本 v0.4.3',
    behind.state === 'available' && behind.text === '有新版本 v0.4.3' && behind.url === 'https://x/releases/v0.4.3', JSON.stringify(behind));

  const err = U.decide(null, '0.4.2');
  check('error：远端为空 → 无法检查更新 · 请检查网络后重试',
    err.state === 'error' && err.text === '无法检查更新 · 请检查网络后重试');

  const mirror = U.decide({ tag: 'v0.4.1', version: '0.4.1', viaMirror: true }, '0.4.2');
  check('ahead + 镜像：文案带「经镜像检查」',
    mirror.ahead === true && mirror.text === '已领先上游 v0.4.1 · 经镜像检查', mirror.text);
}

// ---------------- 2. 缓存回显（ahead 不能退回「已是最新」） ----------------
console.log('\n=== 2. 缓存回显 ===');
{
  storageData[U.cacheKey] = { checkedAt: Date.now(), state: 'latest', ahead: true, tag: 'v0.4.1', text: '已领先上游 v0.4.1' };
  U.restore();
  check('缓存 state=latest + ahead=true → 回显「已领先上游 v0.4.1」',
    els.updMsg && els.updMsg.textContent === '已领先上游 v0.4.1', els.updMsg && els.updMsg.textContent);

  storageData[U.cacheKey] = { checkedAt: Date.now(), state: 'latest', tag: 'v0.4.2', text: '已是最新 · 上游 v0.4.2' };
  U.restore();
  check('缓存 state=latest（同版本）→ 回显「已是最新 · 上游 v0.4.2」',
    els.updMsg && els.updMsg.textContent === '已是最新 · 上游 v0.4.2', els.updMsg && els.updMsg.textContent);

  delete storageData[U.cacheKey];
}

// ---------------- 3. 异步：checking → 404 回落 jsDelivr ----------------
(async () => {
  console.log('\n=== 3. 主链路失败回落 jsDelivr ===');
  fetchCalls.length = 0;
  fetchHandler = (url) => {
    if (url.includes('api.github.com')) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ version: '0.4.1' }) };
  };
  const d = await U.check(true);
  check('上游 404 → 二次请求 jsDelivr，结果标 viaMirror', fetchCalls.length === 2 && fetchCalls[1].includes('cdn.jsdelivr.net'), JSON.stringify(fetchCalls));
  check('回落成功：本机 0.4.2 > 镜像 0.4.1 → latest + ahead + 经镜像检查',
    d.state === 'latest' && d.viaMirror === true && d.ahead === true && d.text === '已领先上游 v0.4.1 · 经镜像检查', JSON.stringify(d));
  check('检测成功写缓存（带 ahead/text）',
    !!(storageData[U.cacheKey] && storageData[U.cacheKey].ahead === true && storageData[U.cacheKey].text), JSON.stringify(storageData[U.cacheKey]));

  console.log('\n=== 4. 两路都失败 ===');
  fetchCalls.length = 0;
  fetchHandler = () => ({ ok: false, status: 500, json: async () => ({}) });
  const e2 = await U.check(true);
  check('两路都失败 → error 文案「无法检查更新 · 请检查网络后重试」',
    e2.state === 'error' && els.updMsg.textContent === '无法检查更新 · 请检查网络后重试' && fetchCalls.length === 2,
    JSON.stringify({ state: e2.state, msg: els.updMsg.textContent, calls: fetchCalls.length }));

  console.log('\n结果: 通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})();
