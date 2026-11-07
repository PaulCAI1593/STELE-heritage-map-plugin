// tests/popup_keytest_tests.js
// #17 Key 测试状态持久化：写 hmp:keyTest、重开回填、尾号失效、失败也记、清缓存不清。
// 说明：最小 DOM + chrome.storage 桩里真实执行 popup.js（不起浏览器、不发网络请求）。
'use strict';
const fs = require('fs');
const path = require('path');
const { makeChecker } = require('./_env');

const { check, finish } = makeChecker('popup-keytest');
const SRC = path.join(__dirname, '..', 'src');
const js = fs.readFileSync(path.join(SRC, 'popup', 'popup.js'), 'utf8');

class El {
  constructor(id) {
    this.id = id; this.value = ''; this.textContent = ''; this.innerHTML = '';
    this.className = ''; this.hidden = false; this.disabled = false; this.checked = false;
    this.type = 'text'; this.attrs = {}; this.children = []; this._span = { textContent: '' };
    this._h = {};
    this.classList = { add() {}, remove() {} };
    this.tagName = 'DIV';
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { this._h[t] = fn; }
  appendChild(c) { this.children.push(c); }
  querySelector(sel) { if (sel === 'span') return this._span; return new El('q'); }
  click() { const fn = this._h.click; return fn ? fn() : undefined; }
}

const IDS = ['popup', 'band', 'bandTitle', 'bandDesc', 'bandMeta', 'amapKey', 'baiduAk',
  'defaultProvider', 'strategyMode', 'enabled', 'amapState', 'baiduState', 'resAmap', 'resBaidu',
  'testAmap', 'testBaidu', 'amapShow', 'baiduShow', 'save', 'clearCache', 'exportLog',
  'checkUpdate', 'dlMain', 'dlSrc', 'ver', 'updWrap', 'updMsg', 'updLinks', 'updInstall'];

function build(opts) {
  const o = opts || {};
  const els = {};
  IDS.forEach(id => { els[id] = new El(id); });
  els.enabled.tagName = 'INPUT'; els.enabled.checked = true;
  els.amapKey.tagName = 'INPUT'; els.baiduAk.tagName = 'INPUT';
  els.defaultProvider.tagName = 'SELECT'; els.strategyMode.tagName = 'SELECT';

  const store = Object.assign({}, o.store || {});
  const calls = { amap: 0, baidu: 0 };
  const docEl = new El('html');
  const domListeners = {};

  global.window = global;
  global.HMP = {
    apis: {
      amap: { search: async () => { calls.amap++; if (o.amapThrows) throw new Error('INVALID_USER_KEY'); return []; } },
      baidu: { search: async () => { calls.baidu++; return []; } }
    }
  };
  global.document = {
    documentElement: docEl,
    querySelectorAll: () => [],
    getElementById: id => els[id] || null,
    addEventListener: (t, fn) => { domListeners[t] = fn; },
    createElement: tag => { const e = new El(''); e.tagName = String(tag).toUpperCase(); return e; },
    body: { appendChild() {} }
  };
  global.chrome = {
    storage: {
      local: {
        get(keys, cb) {
          if (!keys) return cb(Object.assign({}, store));
          const out = {};
          [].concat(keys).forEach(k => { if (Object.prototype.hasOwnProperty.call(store, k)) out[k] = store[k]; });
          cb(out);
        },
        set(obj, cb) { Object.assign(store, obj); if (cb) cb(); },
        remove(keys, cb) { [].concat(keys).forEach(k => { delete store[k]; }); if (cb) cb(); }
      }
    },
    runtime: { getManifest: () => ({ version: '0.6.0' }) },
    tabs: { create() {} }
  };

  (0, eval)(js);
  if (domListeners.DOMContentLoaded) domListeners.DOMContentLoaded();
  return { els, store, calls, popup: global.HMP.popup };
}

const KEY = 'hmp:keyTest';
const H = 3600 * 1000;
const at = (h, m) => new Date(2026, 10, 6, h, m, 0, 0).getTime();

// ---------------- 1. 键与时间格式 ----------------
console.log('\n=== 存储键与时间格式 ===');
{
  const { popup } = build();
  check('#17 状态键为独立的 hmp:keyTest', popup.test.keyTest.KEY === 'hmp:keyTest', popup.test.keyTest.KEY);
  const now = at(18, 5);
  check('当天时间格式 HH:MM', popup.test.keyTest.format(at(9, 7), now) === '09:07',
    popup.test.keyTest.format(at(9, 7), now));
  check('跨天格式 MM-DD', popup.test.keyTest.format(at(9, 7) - 24 * H, now) === '11-05',
    popup.test.keyTest.format(at(9, 7) - 24 * H, now));
}

// ---------------- 2. 通过记录重开回填 ----------------
console.log('\n=== 重开：通过 / 失败 / 尾号变 / 无记录 ===');
{
  const ts = Date.now() - 5 * 60 * 1000;
  const b = build({
    store: {
      amapKey: 'ABCD1234', baiduAk: '',
      [KEY]: { amap: { ok: true, ts, tail: '1234' } }
    }
  });
  const t = b.els.resAmap._span.textContent;
  check('通过记录回填「已测试通过 · HH:MM」', /^已测试通过 · \d{2}:\d{2}$/.test(t), t);
  check('不再显示「未测」', t.indexOf('未测') < 0, t);
  check('通过记录下状态带为 test-ok', b.els.popup.getAttribute('data-popup-state') === 'test-ok',
    b.els.popup.getAttribute('data-popup-state'));
  check('重开不自动重测（高德请求 0 次）', b.calls.amap === 0, String(b.calls.amap));
}
{
  const ts = Date.now() - 24 * H;
  const b = build({
    store: { amapKey: 'ABCD1234', [KEY]: { amap: { ok: false, ts, tail: '1234' }, baidu: null } }
  });
  const t = b.els.resAmap._span.textContent;
  check('失败记录回填「上次测试失败 · MM-DD」', /^上次测试失败 · \d{2}-\d{2}$/.test(t), t);
  check('上次失败不当成本次失败（状态带不是 test-fail）',
    b.els.popup.getAttribute('data-popup-state') !== 'test-fail', b.els.popup.getAttribute('data-popup-state'));
  check('状态带标题说明「上次测试失败」',
    /上次测试失败/.test(b.els.bandTitle.textContent) ||
    (b.els.bandTitle.children[0] || {}).textContent === undefined,
    b.els.bandTitle.textContent);
}
{
  const b = build({ store: { amapKey: 'ABCD9999', [KEY]: { amap: { ok: true, ts: Date.now(), tail: '1234' } } } });
  check('Key 尾号变化 ⇒ 记录失效', b.els.resAmap._span.textContent === '已配置 · 未测试',
    b.els.resAmap._span.textContent);
  check('尾号失效后状态带不是 test-ok', b.els.popup.getAttribute('data-popup-state') !== 'test-ok',
    b.els.popup.getAttribute('data-popup-state'));
  check('失效记录被从存储中清掉（prune）',
    !b.store[KEY] || !b.store[KEY].amap, JSON.stringify(b.store[KEY]));
}
{
  const b = build({ store: { amapKey: 'ABCD1234' } });
  check('无记录 ⇒ 已配置 · 未测试', b.els.resAmap._span.textContent === '已配置 · 未测试',
    b.els.resAmap._span.textContent);
}

// ---------------- 3. 测试后写入 ----------------
console.log('\n=== 测试结果写入 hmp:keyTest ===');
{
  const b = build({ store: { amapKey: 'ABCD1234' } });
  return b.popup.test.one('amap').then(async () => {
    const rec = b.store[KEY] && b.store[KEY].amap;
    check('测试成功写入 {ok:true, ts, tail}', !!rec && rec.ok === true && typeof rec.ts === 'number' && rec.tail === '1234',
      JSON.stringify(rec));
    check('只存 Key 后 4 位（不落完整 Key）', JSON.stringify(b.store[KEY]).indexOf('ABCD1234') < 0,
      JSON.stringify(b.store[KEY]));
    check('本次测试后仍显示本次结果、状态带为 test-ok',
      /可用/.test(b.els.resAmap._span.textContent) && b.els.popup.getAttribute('data-popup-state') === 'test-ok',
      b.els.resAmap._span.textContent + ' / ' + b.els.popup.getAttribute('data-popup-state'));

    const f = build({ store: { amapKey: 'ABCD1234' }, amapThrows: true });
    await f.popup.test.one('amap');
    const frec = f.store[KEY] && f.store[KEY].amap;
    check('测试失败也持久化 {ok:false}', !!frec && frec.ok === false && frec.tail === '1234', JSON.stringify(frec));
    check('失败可见文案不含原始错误码', /INVALID_USER_KEY/.test(f.els.resAmap._span.textContent) === false &&
      /INVALID_USER_KEY/.test(f.els.resAmap.title), f.els.resAmap._span.textContent);

    // 保存未改 Key：记录保留；改 Key/清空：记录清除
    const keep = build({ store: { amapKey: 'ABCD1234', [KEY]: { amap: { ok: true, ts: Date.now(), tail: '1234' } } } });
    await keep.popup.form.save({ silent: true });
    check('保存但 Key 未变 ⇒ 记录保留', !!(keep.store[KEY] && keep.store[KEY].amap), JSON.stringify(keep.store[KEY]));

    const changed = build({ store: { amapKey: 'ABCD1234', [KEY]: { amap: { ok: true, ts: Date.now(), tail: '1234' } } } });
    changed.els.amapKey.value = 'ZZZZ5678';
    await changed.popup.form.save({ silent: true });
    check('Key 改了并保存 ⇒ 记录失效清除', !(changed.store[KEY] && changed.store[KEY].amap),
      JSON.stringify(changed.store[KEY]));

    const cleared = build({ store: { amapKey: 'ABCD1234', [KEY]: { amap: { ok: true, ts: Date.now(), tail: '1234' } } } });
    cleared.els.amapKey.value = '';
    await cleared.popup.form.save({ silent: true });
    check('清空 Key 并保存 ⇒ 记录失效清除', !(cleared.store[KEY] && cleared.store[KEY].amap),
      JSON.stringify(cleared.store[KEY]));

    // 清缓存不清测试状态
    const cache = build({
      store: {
        amapKey: 'ABCD1234',
        'hmp:cache:v46:amap:x:0': { a: 1 },
        [KEY]: { amap: { ok: true, ts: Date.now(), tail: '1234' } }
      }
    });
    await Promise.resolve(cache.els.clearCache._h.click ? cache.els.clearCache._h.click() : null);
    await new Promise(r => setTimeout(r, 10));
    check('清缓存后 hmp:keyTest 仍在', !!(cache.store[KEY] && cache.store[KEY].amap), JSON.stringify(cache.store[KEY]));
    check('清缓存后缓存条目已删', !('hmp:cache:v46:amap:x:0' in cache.store), JSON.stringify(Object.keys(cache.store)));
    finish();
  });
}
