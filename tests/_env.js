// tests/_env.js
// 测试公共环境：最小 DOM / chrome.storage / location 桩，按 manifest 顺序加载内容脚本。
// 不是测试套件本身（文件名不以 _tests 结尾、不进 npm test 链）。
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));

/** 在元素树里按 '#id' / '.class' 找元素（测试桩用） */
function queryAll(root, sel) {
  const out = [];
  const key = String(sel || '').trim();
  const walk = n => {
    if (!n || n.nodeType !== 1) return;
    const kids = n.children || [];
    for (const c of kids) {
      if (c.nodeType === 1) {
        if (key[0] === '#' && c.id === key.slice(1)) out.push(c);
        else if (key[0] === '.' && (' ' + c.className + ' ').indexOf(' ' + key.slice(1) + ' ') >= 0) out.push(c);
        walk(c);
      }
    }
  };
  walk(root);
  return out;
}

class El {
  constructor(t) {
    this.tagName = String(t).toUpperCase(); this.children = []; this.parentNode = null;
    this.attrs = {}; this.className = ''; this.id = ''; this.style = {};
    this.nodeType = 1; this._text = ''; this._html = '';
  }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; } return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); if (k === 'class') this.className = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  get classList() {
    const s = this, l = () => s.className.split(/\s+/).filter(Boolean);
    return {
      add(c) { if (!l().includes(c)) s.className = (s.className + ' ' + c).trim(); },
      remove(c) { s.className = l().filter(x => x !== c).join(' '); },
      contains(c) { return l().includes(c); }
    };
  }
  get textContent() { return this._text; } set textContent(v) { this._text = String(v); }
  get innerHTML() { return this._html; } set innerHTML(v) { this._html = v; }
  addEventListener() {} matches() { return false; }
  querySelector(sel) { return queryAll(this, sel)[0] || null; }
  querySelectorAll(sel) { return queryAll(this, sel); }
}

/** 建立全局桩。opts.chrome=false 时删除 chrome（测直连路径）。 */
function setup(opts) {
  opts = opts || {};
  global.window = global;
  global.location = {
    href: 'http://stele.geogv.org/zhcn/geo/m1', pathname: '/zhcn/geo/m1',
    hash: '', origin: 'http://stele.geogv.org', search: ''
  };
  const docBody = new El('body');
  const modalBody = new El('div'); modalBody.className = 'modal-body';
  const basicEl = new El('div');
  basicEl.className = 'poi-section-content-padding'; basicEl.id = 'poi-basic-info-section';
  modalBody.appendChild(basicEl); docBody.appendChild(modalBody);
  global.document = {
    body: docBody,
    createElement: t => new El(t),
    createTextNode: t => ({ nodeType: 3, textContent: t }),
    getElementById: id => (id === 'poi-basic-info-section' ? basicEl : (queryAll(docBody, '#' + id)[0] || null)),
    querySelector: s => (s === '.modal-body' ? modalBody : (queryAll(docBody, s)[0] || null)),
    querySelectorAll: s => queryAll(docBody, s),
    addEventListener: () => {},
  };
  global.window.addEventListener = () => {};
  global.MutationObserver = class { observe() {} disconnect() {} };
  global.history = { state: null, replaceState() {}, pushState() {}, back() {} };
  global.Blob = global.Blob || function (parts) { this._parts = parts; };
  global.URL = global.URL || { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} };
  global.setTimeout = global.setTimeout;
  try {
    global.navigator = { userAgent: 'node-test', language: 'zh-CN' };
  } catch (e) { /* Node 24 的 navigator 只读，忽略 */ }
  global.__hmpBasicEl = basicEl;

  if (opts.chrome === false) {
    try { delete global.chrome; } catch (e) { /* ignore */ }
    return { basicEl, modalBody };
  }

  const store = Object.assign({
    amapKey: 'TEST_AMAP_KEY', baiduAk: 'TEST_BAIDU_AK',
    defaultProvider: 'amap', strategyMode: 'combine', enabled: true,
  }, opts.store || {});
  global.chrome = {
    storage: {
      local: {
        _store: store,
        get(k, cb) {
          const s = this._store || {};
          let o;
          if (k == null) o = Object.assign({}, s);
          else {
            o = {};
            for (const x of (Array.isArray(k) ? k : [k])) if (x in s) o[x] = s[x];
          }
          if (cb) cb(o);
          return Promise.resolve(o);
        },
        set(i, cb) { Object.assign(this._store, i); if (cb) cb(); return Promise.resolve(); },
        remove(k, cb) {
          const s = this._store || {};
          for (const x of (Array.isArray(k) ? k : [k])) delete s[x];
          if (cb) cb();
          return Promise.resolve();
        },
        clear(cb) { this._store = {}; if (cb) cb(); },
      }
    }
  };
  return { basicEl, modalBody };
}

/** 载入一个 src 下的脚本（相对 src/）。 */
function load(rel) {
  const code = fs.readFileSync(path.join(SRC, rel), 'utf8');
  // 间接 eval：在全局作用域执行，与浏览器里 <script> 一致
  (0, eval)(code);
}

/** 按 manifest 的 content_scripts[0] 顺序加载全部内容脚本。 */
function loadContentScripts() {
  const list = MANIFEST.content_scripts[0].js.slice();
  for (const rel of list) load(rel);
  return list;
}

/** 收集元素树里的文本（调试/断言用）。 */
function textOf(node) {
  if (!node) return '';
  if (node.nodeType === 3) return String(node.textContent || '');
  let s = node._text ? String(node._text) : '';
  if (Array.isArray(node.children)) for (const c of node.children) s += textOf(c);
  return s;
}

function makeChecker(label) {
  let pass = 0, fail = 0;
  function check(name, cond, detail) {
    if (cond) { pass++; console.log('✅ ' + name); }
    else { fail++; console.log('❌ ' + name + (detail ? ' — ' + detail : '')); }
  }
  function finish() {
    console.log('\n结果: 通过 ' + pass + ' / 失败 ' + fail);
    process.exit(fail === 0 ? 0 : 1);
  }
  return { check, finish, label };
}

module.exports = { El, setup, load, loadContentScripts, textOf, makeChecker, SRC, MANIFEST };
