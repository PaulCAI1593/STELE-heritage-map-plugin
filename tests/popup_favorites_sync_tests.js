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
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
const popupHtml = fs.readFileSync(path.join(SRC, 'popup', 'popup.html'), 'utf8');
const popupCss = fs.readFileSync(path.join(SRC, 'popup', 'popup.css'), 'utf8');

class El {
  constructor(id) {
    this.id = id; this.value = ''; this.textContent = ''; this._html = '';
    this.className = ''; this.hidden = false; this.disabled = false; this.checked = false;
    this.type = 'text'; this.attrs = {}; this.children = []; this._span = { textContent: '' };
    this._h = {}; this.tabIndex = 0;
    this._cls = new Set();
    this.classList = {
      add: c => this._cls.add(c),
      remove: c => this._cls.delete(c),
      contains: c => this._cls.has(c),
      toggle: (c, force) => {
        const want = force === undefined ? !this._cls.has(c) : !!force;
        if (want) this._cls.add(c); else this._cls.delete(c);
        return want;
      },
    };
    this.tagName = 'DIV';
    this.dataset = {};
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
  'favNewGroup', 'favRenameGroup', 'favDeleteGroup', 'popoutBtn'
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
  const tabCalls = { query: [], update: [], create: [] };
  const winCalls = { get: [], update: [], create: [], sessionSet: [] };
  const session = Object.assign({}, o.session || {});
  let closeCount = 0;
  const onChanged = {
    _ls: [],
    addListener(fn) { this._ls.push(fn); },
    removeListener(fn) { const i = this._ls.indexOf(fn); if (i >= 0) this._ls.splice(i, 1); },
    emit(changes, area) { for (const fn of this._ls.slice()) fn(changes, area || 'local'); },
  };

  global.window = global;
  global.close = () => { closeCount++; };
  global.location = o.location || { search: '', href: 'chrome-extension://test/popup/popup.html' };
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
      session: {
        _store: session,
        get(keys, cb) {
          const out = {};
          [].concat(keys).forEach(k => { if (Object.prototype.hasOwnProperty.call(session, k)) out[k] = session[k]; });
          if (cb) { cb(out); return undefined; }
          return Promise.resolve(out);
        },
        set(obj, cb) { Object.assign(session, obj); winCalls.sessionSet.push(obj); if (cb) { cb(); return undefined; } return Promise.resolve(); },
        remove(keys, cb) { [].concat(keys).forEach(k => { delete session[k]; }); if (cb) { cb(); return undefined; } return Promise.resolve(); },
      },
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
    runtime: { getManifest: () => ({ version: '0.5.2' }), getURL: p => 'chrome-extension://test/' + p },
    tabs: {
      query(q, cb) {
        tabCalls.query.push(q);
        if (o.tabsQuery) return o.tabsQuery(q, cb);
        if (cb) cb([{ id: 7 }]);
        return undefined;
      },
      update(id, props, cb) {
        tabCalls.update.push({ id, props });
        if (o.tabsUpdate) return o.tabsUpdate(id, props, cb);
        // 真实 Chrome 的 runtime.lastError 只在对应 API 回调内有效；每次回调前清空，
        // 避免上一条（如 getLastFocused）的 lastError 泄漏到同步嵌套的 update 回调里。
        if (typeof chrome !== 'undefined' && chrome.runtime) chrome.runtime.lastError = undefined;
        if (cb) cb();
        return undefined;
      },
      create(p) { tabCalls.create.push(p); },
      getCurrent(cb) {
        tabCalls.getCurrent = (tabCalls.getCurrent || 0) + 1;
        if (cb) cb(o.getCurrentId != null ? { id: o.getCurrentId } : null);
      },
    },
    windows: {
      get(id, cb) {
        winCalls.get.push(id);
        if (o.winGetThrows) throw new Error('get failed');
        if (o.winGetExists === false) {
          chrome.runtime.lastError = { message: 'No window with id: ' + id };
          if (cb) cb(undefined);
          chrome.runtime.lastError = undefined;
          return undefined;
        }
        const win = { id };
        if (cb) { cb(win); return undefined; }
        return Promise.resolve(win);
      },
      update(id, props, cb) { winCalls.update.push({ id, props }); if (cb) { cb(); return undefined; } return Promise.resolve(); },
      create(args, cb) {
        winCalls.create.push(args);
        const win = { id: 501 };
        if (cb) { cb(win); return undefined; }
        return Promise.resolve(win);
      },
      getLastFocused(args, cb) {
        tabCalls.getLastFocused = (tabCalls.getLastFocused || 0) + 1;
        if (o.getLastFocusedThrows) throw new Error('getLastFocused failed');
        if (o.getLastFocusedErr) {
          chrome.runtime.lastError = { message: 'no normal window' };
          if (cb) cb(undefined);
          chrome.runtime.lastError = undefined;
          return undefined;
        }
        const win = o.getLastFocusedWin === undefined ? { id: 3 } : o.getLastFocusedWin;
        if (cb) cb(win);
        return undefined;
      },
    },
  };

  (0, eval)(storeJs);
  (0, eval)(popupJs);
  if (domListeners.DOMContentLoaded) domListeners.DOMContentLoaded();
  return { els, store, session, onChanged, popup: global.HMP.popup, tabCalls, winCalls, closeCount: () => closeCount };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function lib(items) {
  return {
    schema: 1,
    groups: [
      { id: 'g-been', name: '已去', system: true, createdAt: 0 },
      { id: 'g-want', name: '想去', system: true, createdAt: 1 },
    ],
    items: items || [],
  };
}

(async () => {
  console.log('\n=== onChanged → 收藏页立即刷新（P2-2b） ===');
  {
    const H = build({ store: { hmpTheme: 'paper' } });
    await sleep(30);
    check('初始空库：列表为空、空态可见',
      H.els.favList.children.length === 0 && H.els.favEmpty.hidden === false,
      'children=' + H.els.favList.children.length + ' emptyHidden=' + H.els.favEmpty.hidden);
    check('#48 空态不显示「去配置 Key」：按钮 hidden 且文案无 Key 字样',
      H.els.favEmptyGo.hidden === true && String(H.els.favEmptyGo.textContent || '').indexOf('Key') === -1,
      'hidden=' + H.els.favEmptyGo.hidden + ' text=' + H.els.favEmptyGo.textContent);

    // 卡片侧收藏一条 → 真实写 storage（桩派发 onChanged）→ 弹窗列表出现该条
    chrome.storage.local.set({ [FKEY]: lib([
      { steleId: 's1', name: '龙华寺', address: '龙华路2853号', groupId: 'g-been', savedAt: 1000 },
    ]) });
    await sleep(30);
    check('外部收藏后：列表出现 1 条、空态隐藏',
      H.els.favList.children.length === 1 && H.els.favEmpty.hidden === true,
      'children=' + H.els.favList.children.length + ' emptyHidden=' + H.els.favEmpty.hidden);
    check('外部收藏后：分组 chips 计数跟上（已去=1）',
      H.els.favChips.children.some(b => b.attrs['data-g'] === 'g-been' &&
        b.children.some(c => c.className === 'n' && c.textContent === '1')),
      'chips=' + H.els.favChips.children.length);

    // #48 分组空态：仍显示「查看全部收藏」，点击切到全部
    H.popup.favorites.setGroup('g-want');
    H.popup.favorites.setScope('group');
    await sleep(10);
    check('#48 分组空态：显示「查看全部收藏」按钮',
      H.els.favEmpty.hidden === false && H.els.favEmptyGo.hidden === false &&
      H.els.favEmptyGo.textContent === '查看全部收藏',
      'hidden=' + H.els.favEmptyGo.hidden + ' text=' + H.els.favEmptyGo.textContent);
    H.els.favEmptyGo.click();
    await sleep(10);
    check('#48 点「查看全部收藏」切到全部并显示条目',
      H.popup.favorites.state().scope === 'all' && H.els.favList.children.length === 1,
      'scope=' + H.popup.favorites.state().scope + ' children=' + H.els.favList.children.length);

    // 卡片侧取消收藏 → 列表回到空态
    chrome.storage.local.set({ [FKEY]: lib([]) });
    await sleep(30);
    check('外部取消收藏后：列表清空、空态回来',
      H.els.favList.children.length === 0 && H.els.favEmpty.hidden === false,
      'children=' + H.els.favList.children.length + ' emptyHidden=' + H.els.favEmpty.hidden);

    // 其它 storage 键 / 非 local 区不触发刷新（负例）
    H.onChanged.emit({ hmpTheme: { newValue: 'glass' } });
    H.onChanged.emit({ [FKEY]: { newValue: lib([{ steleId: 's2', name: '甲', groupId: 'g-want', savedAt: 1 }]) } }, 'sync');
    await sleep(30);
    check('负例：其它键 / 非 local 区的变化不刷新收藏页',
      H.els.favList.children.length === 0,
      'children=' + H.els.favList.children.length);
  }

  console.log('\n=== #39 默认两组 / 默认范围全部 / 系统组置灰 ===');
  {
    const H = build({ store: { hmpTheme: 'paper' } });
    await sleep(30);
    check('#39：空库 chips 就是「已去 / 想去」两组，没有未分组',
      H.els.favChips.children.length === 2 &&
      H.els.favChips.children[0].children.some(c => c.className === 'gt' && c.textContent === '已去') &&
      H.els.favChips.children[1].children.some(c => c.className === 'gt' && c.textContent === '想去') &&
      !H.els.favChips.children.some(b => b.children.some(c => c.className === 'gt' && c.textContent === '未分组')));
    check('#39：默认范围是「全部」',
      H.popup.favorites.state().scope === 'all' &&
      H.els.scopeAll.attrs['aria-checked'] === 'true' && H.els.scopeGroup.attrs['aria-checked'] === 'false');
    check('#39：系统组在组菜单里置灰、aria-disabled=true',
      H.els.favRenameGroup.classList.contains('is-disabled') &&
      H.els.favDeleteGroup.classList.contains('is-disabled') &&
      H.els.favRenameGroup.attrs['aria-disabled'] === 'true' &&
      /系统分组/.test(H.els.favRenameGroup.attrs.title || ''));
  }

  console.log('\n=== 删组确认文案 / 错误文案（P3-1、P3-4） ===');
  {
    const H = build({ store: { hmpTheme: 'paper' } });
    await sleep(20);
    const f = H.popup.favorites;
    check('deleteGroupConfirmText：n>0 带组名与条数',
      f.deleteGroupConfirmText('2026 上海行', 2) ===
        '删除分组「2026 上海行」？组内 2 条收藏会移到「想去」，不会丢失。');
    check('deleteGroupConfirmText：n=0 省略条目句',
      f.deleteGroupConfirmText('空组', 0) === '删除分组「空组」？组内没有收藏，删除不影响收藏内容。');
    check('errorText：limit-groups 与 limit 文案分开',
      f.errorText('limit-groups') === '分组已达上限（30 个）。' &&
      f.errorText('limit').indexOf('500') >= 0);
    check('errorText：duplicate-name / invalid-name / system 三分支',
      f.errorText('duplicate-name') === '已有同名分组，换个名字。' &&
      f.errorText('invalid-name').indexOf('24 字') >= 0 &&
      f.errorText('system').indexOf('系统分组') >= 0 &&
      f.errorText('system-group', { groupName: '已去' }) === '「已去」是系统分组，不能删除或改名。');
  }

  console.log('\n=== 撤销文案（P3-5） ===');
  {
    const H = build({ store: { hmpTheme: 'paper' } });
    await sleep(20);
    const f = H.popup.favorites;
    check('单条撤销：带名称',
      f.undoText({ items: [{ item: { name: '龙华寺' }, groupId: 'g-want' }] }) === '已取消收藏「龙华寺」');
    check('多条撤销：给条数',
      f.undoText({ items: [{ item: { name: '甲' } }, { item: { name: '乙' } }, {}] }) === '已取消收藏 3 条');
  }

  console.log('\n=== #45 定位：普通窗口当前标签打开、不关窗 ===');
  const oneFav = lib([
    { steleId: 'abc123', name: '龙华寺', address: '龙华路2853号', groupId: 'g-want', savedAt: 1000 },
  ]);
  const seedOne = async (H) => {
    chrome.storage.local.set({ [FKEY]: oneFav });
    await sleep(30);
    return H.els.favList.children[0].children[0];
  };
  const DEEP = 'http://stele.geogv.org/zhcn/geo/abc123';

  {
    const H = build({ store: { hmpTheme: 'paper' }, getCurrentId: 99 });
    await sleep(30);
    const main = await seedOne(H);
    main.click();
    const q = H.tabCalls.query[0] || {};
    check('#45 有普通窗口：按 windowId 查询，不再用 currentWindow',
      q.active === true && q.windowId === 3 && q.currentWindow === undefined,
      'query=' + JSON.stringify(H.tabCalls.query));
    check('#45 有普通窗口：update 目标标签并保留窗口（create 0、close 0）',
      H.tabCalls.update.length === 1 && H.tabCalls.update[0].id === 7 &&
      H.tabCalls.update[0].props.url === DEEP && H.tabCalls.create.length === 0 && H.closeCount() === 0,
      'update=' + JSON.stringify(H.tabCalls.update) + ' create=' + H.tabCalls.create.length + ' closes=' + H.closeCount());
  }

  {
    const H = build({ store: { hmpTheme: 'paper' }, getCurrentId: 99, tabsUpdate: () => { throw new Error('denied'); } });
    await sleep(30);
    const main = await seedOne(H);
    main.click();
    check('#45 update 失败：退回 create 一次、仍不关窗',
      H.tabCalls.update.length === 1 && H.tabCalls.create.length === 1 &&
      H.tabCalls.create[0].url === DEEP && H.closeCount() === 0,
      'update=' + H.tabCalls.update.length + ' create=' + H.tabCalls.create.length + ' closes=' + H.closeCount());
  }

  {
    const H = build({ store: { hmpTheme: 'paper' }, getCurrentId: 99, getLastFocusedErr: true, tabsQuery: (q, cb) => cb([]) });
    await sleep(30);
    const main = await seedOne(H);
    main.click();
    check('#45 无普通窗口且无标签：新开一次、不关窗',
      H.tabCalls.create.length === 1 && H.tabCalls.update.length === 0 && H.closeCount() === 0,
      'create=' + H.tabCalls.create.length + ' update=' + H.tabCalls.update.length + ' closes=' + H.closeCount());
  }

  {
    const H = build({
      store: { hmpTheme: 'paper' }, getCurrentId: 99, getLastFocusedErr: true,
      tabsQuery: (q, cb) => {
        if (q.lastFocusedWindow) { cb([]); return; }
        if (q.windowId != null) { cb([]); return; }
        cb([{ id: 99 }, { id: 9 }]);
      },
    });
    await sleep(30);
    const main = await seedOne(H);
    main.click();
    check('#45 选中插件自身标签时跳过，改选下一个普通标签',
      H.tabCalls.update.length === 1 && H.tabCalls.update[0].id === 9 &&
      H.tabCalls.create.length === 0 && H.closeCount() === 0,
      'update=' + JSON.stringify(H.tabCalls.update) + ' closes=' + H.closeCount() + ' create=' + JSON.stringify(H.tabCalls.create) + ' queries=' + JSON.stringify(H.tabCalls.query));
  }

  {
    const H = build({ store: { hmpTheme: 'paper' }, getCurrentId: 99 });
    await sleep(30);
    const main = await seedOne(H);
    const li = H.els.favList.children[0];
    const amapBtn = li.children[1].children[0].children[0];
    amapBtn.click();
    check('#45 外部地图链接（高德）仍 create、不 update、不关窗',
      H.tabCalls.create.length === 1 && /uri\.amap\.com/.test(H.tabCalls.create[0].url) &&
      H.tabCalls.update.length === 0 && H.tabCalls.query.length === 0 && H.closeCount() === 0,
      'create=' + JSON.stringify(H.tabCalls.create) + ' update=' + H.tabCalls.update.length);
  }

  {
    const perms = [].concat(manifest.permissions || [], manifest.host_permissions || []);
    check('#45 未新增 tabs 权限', perms.indexOf('tabs') === -1, 'permissions=' + JSON.stringify(perms));
    check('#45 源码用 getLastFocused({windowTypes:[normal]}) 取普通窗口',
      popupJs.indexOf("getLastFocused({ windowTypes: ['normal'] }") !== -1);
    check('#45 源码不再用 currentWindow 定位', popupJs.indexOf('currentWindow: true') === -1);
    const locateSrc = popupJs.slice(popupJs.indexOf('function openFavorite(item)'), popupJs.indexOf('function popPanelOut'));
    check('#45 定位路径不再调用 window.close()', locateSrc.indexOf('window.close()') === -1);
  }

  console.log('\n=== #46 弹窗内「弹出到新窗口」 ===');
  {
    const H = build({ store: { hmpTheme: 'paper' } });
    await sleep(30);
    H.els.popoutBtn.click();
    const c = H.winCalls.create[0] || {};
    check('#46 普通模式点按钮：create 一次（440×640、popup、url 含 window=1）',
      H.winCalls.create.length === 1 && c.type === 'popup' && c.width === 440 && c.height === 640 &&
      /popup\/popup\.html\?window=1$/.test(String(c.url || '')),
      'create=' + JSON.stringify(H.winCalls.create));
    check('#46 create 后写 storage.session 并关闭弹窗',
      H.winCalls.sessionSet.length === 1 && H.winCalls.sessionSet[0]['hmp:panelWindowId'] === 501 &&
      H.closeCount() === 1,
      'sessionSet=' + JSON.stringify(H.winCalls.sessionSet) + ' closes=' + H.closeCount());
  }

  {
    const H = build({ store: { hmpTheme: 'paper' }, session: { 'hmp:panelWindowId': 42 } });
    await sleep(30);
    H.els.popoutBtn.click();
    check('#46 已有小窗：只 update(42,{focused:true})、不 create、关弹窗',
      H.winCalls.get.length === 1 && H.winCalls.get[0] === 42 &&
      H.winCalls.update.length === 1 && H.winCalls.update[0].id === 42 &&
      H.winCalls.update[0].props.focused === true && H.winCalls.create.length === 0 &&
      H.closeCount() === 1,
      'get=' + JSON.stringify(H.winCalls.get) + ' update=' + JSON.stringify(H.winCalls.update) + ' create=' + H.winCalls.create.length);
  }

  {
    const H = build({ store: { hmpTheme: 'paper' }, session: { 'hmp:panelWindowId': 42 }, winGetExists: false });
    await sleep(30);
    H.els.popoutBtn.click();
    check('#46 session 里的窗口已不存在：退回 create 一次、不 update、关弹窗',
      H.winCalls.get.length === 1 && H.winCalls.create.length === 1 &&
      H.winCalls.update.length === 0 && H.closeCount() === 1,
      'get=' + JSON.stringify(H.winCalls.get) + ' create=' + H.winCalls.create.length + ' update=' + H.winCalls.update.length);
  }

  {
    const H = build({ store: { hmpTheme: 'paper' }, location: { search: '?window=1', href: 'chrome-extension://test/popup/popup.html?window=1' } });
    await sleep(30);
    check('#46 窗口模式：按钮 hidden + 根节点 data-hmp-window=1',
      H.els.popoutBtn.hidden === true && H === H &&
      popupCss.indexOf('html[data-hmp-window="1"] .hmp-popout{display:none}') !== -1,
      'hidden=' + H.els.popoutBtn.hidden);
    check('#46 弹窗按钮为 SVG 图标且 aria-label/title 完整',
      /id="popoutBtn"[^>]*aria-label="弹出到新窗口"[^>]*title="弹出到新窗口"/.test(popupHtml) &&
      popupHtml.indexOf('class="hmp-popout"') !== -1 && popupHtml.indexOf('<svg') !== -1,
      'html ok');
  }

  console.log('\n=== #47 深链只走 http ===');
  {
    check('#47 buildDeepLink 以 http 开头', /^http:\/\/stele\.geogv\.org\/zhcn\/geo\//.test(global.HMP.popup.favorites.buildDeepLink('abc')));
    check('#47 buildSearchLink 以 http 开头', /^http:\/\/stele\.geogv\.org\/zhcn\/search\?keyword=/.test(global.HMP.popup.favorites.buildSearchLink('十里庙')));
    const bad = [];
    const walk = dir => {
      fs.readdirSync(dir, { withFileTypes: true }).forEach(d => {
        const f = path.join(dir, d.name);
        if (d.isDirectory()) walk(f);
        else if (/\.(js|json|html|css)$/.test(d.name) && fs.readFileSync(f, 'utf8').indexOf('https://stele.geogv.org') !== -1) bad.push(path.relative(SRC, f));
      });
    };
    walk(SRC);
    check('#47 src/ 运行时代码无 https://stele.geogv.org', bad.length === 0, 'files=' + JSON.stringify(bad));
  }

  console.log('\n=== #48 收藏空态与 Key 配置解耦 ===');
  {
    const hits = [];
    const walk = dir => {
      fs.readdirSync(dir, { withFileTypes: true }).forEach(d => {
        const f = path.join(dir, d.name);
        if (d.isDirectory()) walk(f);
        else if (/\.(js|json|html|css)$/.test(d.name) && fs.readFileSync(f, 'utf8').indexOf('去配置 Key') !== -1) hits.push(path.relative(SRC, f));
      });
    };
    walk(SRC);
    check('#48 src/ 无「去配置 Key」字面量', hits.length === 0, 'files=' + JSON.stringify(hits));
    check('#48 空态按钮初始 hidden 且中性文案', /id="favEmptyGo"[^>]*hidden[^>]*>查看全部收藏</.test(popupHtml));
  }

  finish();
})();
