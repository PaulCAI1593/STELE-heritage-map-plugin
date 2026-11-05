// tests/popup_favorites_sync_tests.js
// #36 P2-2(b)：弹窗订阅 chrome.storage.onChanged('hmp:favorites:v1') —
// 卡片侧收藏/取消收藏后，弹窗收藏页要立刻跟上（不用重开弹窗）。
// 做法：最小 DOM + storage 桩里真实执行 favorites-store.js 与 popup.js。
'use strict';
const fs = require('fs');
const path = require('path');
const { makeChecker } = require('./_env');

const { check, finish } = makeChecker('popup-fav-sync');
const SRC = path.join(__dirname, '..', 'src');
const popupJs = fs.readFileSync(path.join(SRC, 'popup', 'popup.js'), 'utf8');
const storeJs = fs.readFileSync(path.join(SRC, 'shared', 'favorites-store.js'), 'utf8');

class El {
  constructor(id) {
    this.id = id; this.value = ''; this.textContent = ''; this._html = '';
    this.className = ''; this.hidden = false; this.disabled = false; this.checked = false;
    this.type = 'text'; this.attrs = {}; this.children = []; this._span = { textContent: '' };
    this._h = {}; this.tabIndex = 0;
    this.classList = { add() {}, remove() {}, contains() { return false; } };
    this.tagName = 'DIV';
  }
  set innerHTML(v) { this._html = String(v == null ? '' : v); if (this._html === '') this.children = []; }
  get innerHTML() { return this._html; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { this._h[t] = fn; }
  appendChild(c) { this.children.push(c); return c; }
  querySelector(sel) { if (sel === 'span') return this._span; return new El('q'); }
  querySelectorAll() { return []; }
  focus() {}
  click() { const fn = this._h.click; return fn ? fn() : undefined; }
}

// 设置页 + Tab + 收藏页全部节点（popup.js 里 $() 取到的 id）
const IDS = [
  'popup', 'band', 'bandTitle', 'bandDesc', 'bandMeta', 'amapKey', 'baiduAk',
  'defaultProvider', 'strategyMode', 'enabled', 'amapState', 'baiduState', 'resAmap', 'resBaidu',
  'testAmap', 'testBaidu', 'amapShow', 'baiduShow', 'save', 'clearCache', 'exportLog',
  'checkUpdate', 'dlMain', 'dlSrc', 'ver', 'updWrap', 'updMsg', 'updLinks', 'updInstall',
  'panel-fav', 'panel-set', 'tab-fav', 'tab-set',
  'favQuery', 'scopeGroup', 'scopeAll', 'favChips', 'favGroupMenuBtn', 'favMenu',
  'favList', 'favFound', 'favUndo', 'favUndoText', 'favUndoBtn',
  'favHint', 'favHintText', 'favEmpty', 'favEmptyTitle', 'favEmptyBody', 'favEmptyGo', 'favEmptyClear',
  'favExport', 'favNewForm', 'favRenameForm', 'favNewName', 'favRenameName',
  'favNewOk', 'favNewCancel', 'favRenameOk', 'favRenameCancel',
  'favNewGroup', 'favRenameGroup', 'favDeleteGroup'
];
const FKEY = 'hmp:favorites:v1';

function build(opts) {
  const o = opts || {};
  const els = {};
  IDS.forEach(id => { els[id] = new El(id); });
  els.enabled.tagName = 'INPUT'; els.enabled.checked = true;
  els.amapKey.tagName = 'INPUT'; els.baiduAk.tagName = 'INPUT';
  els.defaultProvider.tagName = 'SELECT'; els.strategyMode.tagName = 'SELECT';

  const store = Object.assign({}, o.store || {});
  const domListeners = {};
  const onChanged = {
    _ls: [],
    addListener(fn) { this._ls.push(fn); },
    removeListener(fn) { const i = this._ls.indexOf(fn); if (i >= 0) this._ls.splice(i, 1); },
    emit(changes, area) { for (const fn of this._ls.slice()) fn(changes, area || 'local'); },
  };

  global.window = global;
  global.HMP = { apis: { amap: { search: async () => [] }, baidu: { search: async () => [] } } };
  global.document = {
    documentElement: new El('html'),
    querySelectorAll: () => [],
    getElementById: id => els[id] || null,
    addEventListener: (t, fn) => { domListeners[t] = fn; },
    createElement: tag => { const e = new El(''); e.tagName = String(tag).toUpperCase(); return e; },
    body: { appendChild() {} },
  };
  global.chrome = {
    storage: {
      onChanged,
      local: {
        _store: store,
        get(keys, cb) {
          const s = this._store;
          if (!keys) { const all = Object.assign({}, s); if (cb) cb(all); return Promise.resolve(all); }
          const out = {};
          [].concat(keys).forEach(k => { if (Object.prototype.hasOwnProperty.call(s, k)) out[k] = s[k]; });
          if (cb) cb(out); return Promise.resolve(out);
        },
        set(obj, cb) {
          const s = this._store;
          const changes = {};
          Object.keys(obj).forEach(k => { changes[k] = { oldValue: s[k], newValue: obj[k] }; });
          Object.assign(s, obj);
          if (cb) cb();
          onChanged.emit(changes);
          return Promise.resolve();
        },
        remove(keys, cb) {
          const s = this._store;
          const changes = {};
          [].concat(keys).forEach(k => {
            if (Object.prototype.hasOwnProperty.call(s, k)) { changes[k] = { oldValue: s[k] }; delete s[k]; }
          });
          if (cb) cb();
          if (Object.keys(changes).length) onChanged.emit(changes);
          return Promise.resolve();
        },
      },
    },
    runtime: { getManifest: () => ({ version: '0.4.5' }) },
    tabs: { create() {} },
  };

  (0, eval)(storeJs);
  (0, eval)(popupJs);
  if (domListeners.DOMContentLoaded) domListeners.DOMContentLoaded();
  return { els, store, onChanged, popup: global.HMP.popup };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function lib(items) {
  return { schema: 1, groups: [{ id: 'g-default', name: '未分组', system: true, createdAt: 0 }], items: items || [] };
}

(async () => {
  console.log('\n=== onChanged → 收藏页立即刷新（P2-2b） ===');
  {
    const H = build({ store: { hmpTheme: 'paper' } });
    await sleep(30);
    check('初始空库：列表为空、空态可见',
      H.els.favList.children.length === 0 && H.els.favEmpty.hidden === false,
      'children=' + H.els.favList.children.length + ' emptyHidden=' + H.els.favEmpty.hidden);

    // 卡片侧收藏一条 → 真实写 storage（桩派发 onChanged）→ 弹窗列表出现该条
    chrome.storage.local.set({ [FKEY]: lib([
      { steleId: 's1', name: '龙华寺', address: '龙华路2853号', groupId: 'g-default', savedAt: 1000 },
    ]) });
    await sleep(30);
    check('外部收藏后：列表出现 1 条、空态隐藏',
      H.els.favList.children.length === 1 && H.els.favEmpty.hidden === true,
      'children=' + H.els.favList.children.length + ' emptyHidden=' + H.els.favEmpty.hidden);
    check('外部收藏后：分组 chips 计数跟上（未分组=1）',
      H.els.favChips.children.some(b => b.attrs['data-g'] === 'g-default' &&
        b.children.some(c => c.className === 'n' && c.textContent === '1')),
      'chips=' + H.els.favChips.children.length);

    // 卡片侧取消收藏 → 列表回到空态
    chrome.storage.local.set({ [FKEY]: lib([]) });
    await sleep(30);
    check('外部取消收藏后：列表清空、空态回来',
      H.els.favList.children.length === 0 && H.els.favEmpty.hidden === false,
      'children=' + H.els.favList.children.length + ' emptyHidden=' + H.els.favEmpty.hidden);

    // 其它 storage 键 / 非 local 区不触发刷新（负例）
    H.onChanged.emit({ hmpTheme: { newValue: 'glass' } });
    H.onChanged.emit({ [FKEY]: { newValue: lib([{ steleId: 's2', name: '甲', groupId: 'g-default', savedAt: 1 }]) } }, 'sync');
    await sleep(30);
    check('负例：其它键 / 非 local 区的变化不刷新收藏页',
      H.els.favList.children.length === 0,
      'children=' + H.els.favList.children.length);
  }

  console.log('\n=== 删组确认文案 / 错误文案（P3-1、P3-4） ===');
  {
    const H = build({ store: { hmpTheme: 'paper' } });
    await sleep(20);
    const f = H.popup.favorites;
    check('deleteGroupConfirmText：n>0 带组名与条数',
      f.deleteGroupConfirmText('2026 上海行', 2) ===
        '删除分组「2026 上海行」？组内 2 条收藏会移到「未分组」，不会丢失。');
    check('deleteGroupConfirmText：n=0 省略条目句',
      f.deleteGroupConfirmText('空组', 0) === '删除分组「空组」？组内没有收藏，删除不影响收藏内容。');
    check('errorText：limit-groups 与 limit 文案分开',
      f.errorText('limit-groups') === '分组已达上限（30 个）。' &&
      f.errorText('limit').indexOf('500') >= 0);
    check('errorText：duplicate-name / invalid-name / system 三分支',
      f.errorText('duplicate-name') === '已有同名分组，换个名字。' &&
      f.errorText('invalid-name').indexOf('24 字') >= 0 &&
      f.errorText('system').indexOf('系统分组') >= 0);
  }

  console.log('\n=== 撤销文案（P3-5） ===');
  {
    const H = build({ store: { hmpTheme: 'paper' } });
    await sleep(20);
    const f = H.popup.favorites;
    check('单条撤销：带名称',
      f.undoText({ items: [{ item: { name: '龙华寺' }, groupId: 'g-default' }] }) === '已取消收藏「龙华寺」');
    check('多条撤销：给条数',
      f.undoText({ items: [{ item: { name: '甲' } }, { item: { name: '乙' } }, {}] }) === '已取消收藏 3 条');
  }

  finish();
})();
