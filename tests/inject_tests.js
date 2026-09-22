// tests/inject_tests.js
// 详情面板注入测试 —— 针对"API 配好了但看不到卡片"这类问题。
//
// 站点的真实时序是「先拉数据 → 再渲染弹窗」，所以事件到达时弹窗往往还不存在；
// 且 `.modal` 上的 `show` 类是后加的（属性变更）。旧实现查不到容器就直接放弃，
// 会导致卡片永远不出现。这里用一个迷你 DOM 验证：
//   1) 容器查找的三级兜底
//   2) 弹窗晚于事件出现时，卡片会自动补插（重试）
//   3) 插入位置正确（最后一个 .poi-section-content-padding 之后）
//   4) React 重建弹窗后卡片会被重新插回
//   5) 不会重复插入
//
// 运行: node tests/inject_tests.js
'use strict';
const fs = require('fs');
const path = require('path');

// ================= 迷你 DOM =================
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.className = '';
    this.id = '';
    this.style = {};
    this._text = '';
    this._html = '';
    this.nodeType = 1;
  }
  appendChild(c) {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this; this.children.push(c); return c;
  }
  insertBefore(c, ref) {
    if (c.parentNode) c.parentNode.removeChild(c);
    const i = this.children.indexOf(ref);
    c.parentNode = this;
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
    return c;
  }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; }
    return c;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === 'id') this.id = String(v);
    if (k === 'class') this.className = String(v);
  }
  getAttribute(k) { return this.attrs[k]; }
  get classList() {
    const self = this;
    const list = () => self.className.split(/\s+/).filter(Boolean);
    return {
      add(c) { if (!list().includes(c)) self.className = (self.className + ' ' + c).trim(); },
      remove(c) { self.className = list().filter(x => x !== c).join(' '); },
      contains(c) { return list().includes(c); },
    };
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); }
  addEventListener() {}
  matches(sel) { return matchSelector(this, sel); }
  querySelector(sel) { const r = this.querySelectorAll(sel); return r.length ? r[0] : null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const c of (n.children || [])) {
        if (c.nodeType !== 1) continue;           // 跳过文本节点
        if (matchSelector(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

function matchSimple(el, part) {
  const idm = part.match(/#([A-Za-z0-9_-]+)/);
  if (idm && el.id !== idm[1]) return false;
  const classes = [...part.matchAll(/\.([A-Za-z0-9_-]+)/g)].map(m => m[1]);
  const own = el.className.split(/\s+/).filter(Boolean);
  for (const c of classes) if (!own.includes(c)) return false;
  const tagm = part.match(/^([a-zA-Z]+)/);
  if (tagm && el.tagName.toLowerCase() !== tagm[1].toLowerCase()) return false;
  return true;
}

function matchSelector(el, sel) {
  const parts = String(sel).trim().split(/\s+/);
  if (!matchSimple(el, parts[parts.length - 1])) return false;
  let node = el.parentNode;
  for (let i = parts.length - 2; i >= 0; i--) {
    let found = false;
    while (node) {
      if (matchSimple(node, parts[i])) { found = true; node = node.parentNode; break; }
      node = node.parentNode;
    }
    if (!found) return false;
  }
  return true;
}

// ================= 环境 =================
global.window = global;
global.location = { href: 'http://stele.geogv.org/zhcn/geo/test', pathname: '/zhcn/geo/test', hash: '', origin: 'http://stele.geogv.org' };
const docEls = { body: new El('body') };
global.document = {
  body: docEls.body,
  createElement: (t) => new El(t),
  createTextNode: (t) => ({ nodeType: 3, textContent: t }),
  getElementById(id) {
    const walk = (n) => {
      for (const c of (n.children || [])) {
        if (c.nodeType !== 1) continue;
        if (c.id === id) return c;
        const r = walk(c);
        if (r) return r;
      }
      return null;
    };
    return walk(docEls.body);
  },
  querySelector(sel) { return docEls.body.querySelector(sel); },
  querySelectorAll(sel) { return docEls.body.querySelectorAll(sel); },
};
// 事件系统：card.js 通过 window.addEventListener('hmp:poi-loaded') 接收点位
const evListeners = {};
global.window.addEventListener = (type, fn) => {
  (evListeners[type] = evListeners[type] || []).push(fn);
};
function emit(type, detail) {
  for (const fn of (evListeners[type] || [])) fn({ type, detail });
}

// MutationObserver：记录回调，测试里用 fireMutations() 手动触发
const observers = [];
global.MutationObserver = class {
  constructor(cb) { this.cb = cb; observers.push(this); }
  observe() {}
  disconnect() {}
};
function fireMutations() { for (const o of observers) o.cb([]); }
global.chrome = {
  storage: { local: {
    _store: {},
    // 注意：k == null 表示"取全量"（cache.js 的 getAll 就是这么调的），
    // 早期 mock 在这里返回 {} 会让 clear()/purgeOldVersions() 静默失效。
    get(k, cb) {
      const store = this._store || {};
      const o = (k == null) ? Object.assign({}, store) : (() => {
        const r = {};
        for (const x of (Array.isArray(k) ? k : [k])) if (x in store) r[x] = store[x];
        return r;
      })();
      if (cb) cb(o); return Promise.resolve(o);
    },
    set(i, cb) { Object.assign(this._store, i); if (cb) cb(); return Promise.resolve(); },
    remove(k, cb) {
      const store = this._store || {};
      for (const x of (Array.isArray(k) ? k : [k])) delete store[x];
      if (cb) cb(); return Promise.resolve();
    },
  } },
};

const SRC = path.join(__dirname, '..', 'src', 'content');
['decoder', 'naming', 'geo', 'cache', 'http'].forEach(f =>
  eval(fs.readFileSync(path.join(SRC, f + '.js'), 'utf8')));
eval(fs.readFileSync(path.join(SRC, 'apis', 'amap.js'), 'utf8'));
eval(fs.readFileSync(path.join(SRC, 'apis', 'baidu.js'), 'utf8'));
eval(fs.readFileSync(path.join(SRC, 'matcher.js'), 'utf8'));
eval(fs.readFileSync(path.join(SRC, 'card.js'), 'utf8'));

const CARD = window.HMP.card;
const CARD_ID = CARD.CARD_ID;

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (detail ? '  → ' + detail : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 收集一棵子树的可见文本（既要处理 El 节点，也要处理 createTextNode 的文本节点）
function collectText(n) {
  if (!n) return '';
  if (n.nodeType === 3) return String(n.textContent || '');
  let s = String(n._text || '');
  for (const c of (n.children || [])) s += collectText(c);
  return s;
}

// 构造站点真实的详情面板结构
function buildSitePanel({ withBasicId = true, modalClasses = 'modal' } = {}) {
  const modal = new El('div'); modal.className = modalClasses;
  const dialog = new El('div'); dialog.className = 'modal-dialog';
  const content = new El('div'); content.className = 'modal-content';
  const body = new El('div');
  body.className = 'modal-body';
  body.style.display = 'flex';

  const basic = new El('div');
  basic.className = 'poi-section-content-padding';
  if (withBasicId) basic.id = 'poi-basic-info-section';
  body.appendChild(basic);

  for (const cls of ['poi-section-content-padding', 'poi-section-content-padding']) {
    const s = new El('div'); s.className = cls; body.appendChild(s);
  }
  const backBtn = new El('div'); backBtn.className = 'poi-section-content-padding';
  backBtn.id = 'back-btn-stack';
  const btn = new El('button'); btn.textContent = '后退';
  backBtn.appendChild(btn);
  body.appendChild(backBtn);

  content.appendChild(body);
  dialog.appendChild(content);
  modal.appendChild(dialog);
  return { modal, body, basic };
}

function resetDoc() {
  docEls.body = new El('body');
  global.document.body = docEls.body;
}

(async () => {
  // ============ 1. 容器查找 ============
  console.log('\n=== 1. findContainer ===');
  resetDoc();
  check('空页面 → null', CARD.findContainer() === null);

  resetDoc();
  const left = new El('div'); left.id = 'left-content-container';
  docEls.body.appendChild(left);
  // #left-content-container 是常驻元素、不随详情面板关闭而消失。
  // 一旦拿它兜底，用户关掉面板后卡片会一直挂在地图上（曾经的 bug）。
  check('仅有常驻侧栏 → 返回 null（绝不兜底到它）', CARD.findContainer() === null);

  resetDoc();
  let panel = buildSitePanel({ withBasicId: false, modalClasses: 'modal show' });
  docEls.body.appendChild(panel.modal);
  check('.modal-body（无 #poi-basic-info-section）→ 用它',
    CARD.findContainer() === panel.body);

  resetDoc();
  panel = buildSitePanel({ withBasicId: true });
  docEls.body.appendChild(panel.modal);
  check('#poi-basic-info-section 存在 → 用其父节点（最稳）',
    CARD.findContainer() === panel.body);

  // ============ 2. 弹窗晚于事件出现 → 自动补插（旧实现的核心 bug）============
  console.log('\n=== 2. 弹窗晚于事件出现时自动补插 ===');
  resetDoc();
  CARD.renderState({ card: 'single', kind: 'loading', provider: 'querying', providerLabel: '查询中…' });
  check('弹窗尚不存在时，不会立刻插入（也不报错）', document.getElementById(CARD_ID) === null);

  await sleep(120);   // 还没到重试间隔
  check('此时仍无卡片', document.getElementById(CARD_ID) === null);

  // 模拟站点把弹窗渲染出来
  panel = buildSitePanel({ withBasicId: true });
  docEls.body.appendChild(panel.modal);

  await sleep(500);   // 等一次重试
  const card = document.getElementById(CARD_ID);
  check('弹窗出现后，卡片被自动补插 ✅', !!card);
  if (card) {
    check('插入在详情面板内', card.parentNode === panel.body);
    // 应在最后一个 .poi-section-content-padding（返回按钮）之前
    const idxCard = panel.body.children.indexOf(card);
    const idxBack = panel.body.children.indexOf(panel.body.children.find(c => c.id === 'back-btn-stack'));
    check('位置在"返回"按钮之前（即内容区末尾）', idxCard > 0 && idxCard < idxBack,
      `card@${idxCard}, back@${idxBack}`);
    check('带上 data-hmp-state 便于排查', card.attrs['data-hmp-state'] === 'loading');
  }

  // ============ 3. 不会重复插入 ============
  console.log('\n=== 3. 重复渲染不会堆积卡片 ===');
  CARD.renderState({ card: 'single', kind: 'found', provider: 'amap', providerLabel: '高德地图', info: { name: '故宫博物院' } });
  await sleep(60);
  CARD.renderState({ card: 'single', kind: 'found', provider: 'amap', providerLabel: '高德地图', info: { name: '故宫博物院' } });
  await sleep(60);
  const all = document.querySelectorAll('#' + CARD_ID);
  check('页面上只有一张卡片', all.length === 1, '实际 ' + all.length);
  check('卡片状态已更新为 found',
    document.getElementById(CARD_ID).attrs['data-hmp-state'] === 'found');

  // ============ 4. 弹窗被 React 重建 → 卡片被冲掉后能恢复 ============
  console.log('\n=== 4. 弹窗重建后恢复 ===');
  // 注意：card.js 的 MutationObserver 在测试里是空实现，这里直接验证 renderState 的幂等性
  const panel2 = buildSitePanel({ withBasicId: true });
  docEls.body = new El('body');
  global.document.body = docEls.body;
  docEls.body.appendChild(panel2.modal);
  check('换新弹窗后旧卡片已不在', document.getElementById(CARD_ID) === null);
  CARD.renderState({ card: 'single', kind: 'found', provider: 'amap', providerLabel: '高德地图', info: { name: '故宫博物院' } });
  await sleep(60);
  check('重新渲染后卡片出现在新弹窗里', document.getElementById(CARD_ID) !== null &&
    document.getElementById(CARD_ID).parentNode === panel2.body);

  // ============ 5. 文物组卡片 ============
  console.log('\n=== 5. 文物组卡片注入 ===');
  CARD.renderState({
    card: 'group', kind: 'group-done', provider: 'group',
    providerLabel: '文物组（共 2 个子项目）', total: 2, truncated: false,
    results: [
      { name: '莫高窟', status: 'found', info: { name: '莫高窟', opentimeToday: '08:30-17:30' }, provider: 'amap', providerLabel: '高德地图', matchType: 'name', amapSearchUrl: '#', baiduSearchUrl: '#' },
      { name: '西千佛洞', status: 'not-found', info: null, provider: 'amap', providerLabel: '高德地图', matchType: 'name', amapSearchUrl: '#', baiduSearchUrl: '#' },
    ],
  });
  await sleep(60);
  // 5a 原先测的 group 样式类/状态已随文物组表格功能一起移除

  // ============ 5b. 侧栏常驻元素绝不能当容器（曾导致"关掉面板卡片还在"）============
  console.log('\n=== 5b. 面板关闭后不得落进常驻侧栏 ===');
  {
    // 站点页面上 #left-content-container 是常驻的，不随详情面板关闭而消失
    resetDoc();
    const leftOnly = new El('div'); leftOnly.id = 'left-content-container';
    docEls.body.appendChild(leftOnly);
    check('只有常驻侧栏时 findContainer() 返回 null（不拿它兜底）',
      CARD.findContainer() === null);
    check('panelGone() 为 true', CARD.panelGone() === true);

    CARD.renderState({ card: 'single', kind: 'loading', provider: 'querying', providerLabel: '查询中…' });
    await sleep(400);   // 经历若干次重试
    check('卡片没有被插进侧栏', leftOnly.children.length === 0,
      '侧栏子节点数 ' + leftOnly.children.length);
    check('页面上没有卡片', document.getElementById(CARD_ID) === null);
    CARD.cancelRender();
  }

  // ============ 5c. 详情面板关闭 → 卡片必须一起消失 ============
  console.log('\n=== 5c. 关闭详情面板后卡片消失 ===');
  {
    resetDoc();
    const left = new El('div'); left.id = 'left-content-container';
    docEls.body.appendChild(left);
    let p = buildSitePanel({ withBasicId: true });
    docEls.body.appendChild(p.modal);

    CARD.renderState({ card: 'single', kind: 'found', provider: 'amap', providerLabel: '高德地图', info: { name: '故宫博物院' } });
    await sleep(80);
    check('面板打开时卡片存在', document.getElementById(CARD_ID) !== null);

    // 模拟站点关闭详情面板：把 modal 从 DOM 移除
    p.modal.remove();
    fireMutations();
    await sleep(150);

    check('关闭面板后卡片被移除', document.getElementById(CARD_ID) === null);
    check('且没有落进常驻侧栏', left.children.length === 0, '侧栏子节点数 ' + left.children.length);
    check('inspect 报告面板已关闭', CARD.inspect().详情面板.面板已关闭 === true);
  }

  // ============ 5d. 重新打开同一 点位 → 复用上次结果，不重复查询 ============
  console.log('\n=== 5d. 重新打开同一 点位 ===');
  {
    resetDoc();
    const feature = { name: '故宫', feature_type: '博物馆', admin: ['北京市 东城区'], geom: { coordinates: [113.13, 41.51] } };
    let p = buildSitePanel({ withBasicId: true });
    docEls.body.appendChild(p.modal);

    emit('hmp:poi-loaded', feature);
    await sleep(120);
    const first = document.getElementById(CARD_ID);
    check('首次打开：卡片出现', !!first);

    // 关闭
    p.modal.remove();
    fireMutations();
    await sleep(150);
    check('关闭后卡片消失', document.getElementById(CARD_ID) === null);

    // 重新打开同一 点位
    p = buildSitePanel({ withBasicId: true });
    docEls.body.appendChild(p.modal);
    emit('hmp:poi-loaded', feature);
    await sleep(120);
    check('重新打开后卡片恢复', document.getElementById(CARD_ID) !== null);
    check('卡片挂在新的详情面板里',
      document.getElementById(CARD_ID) &&
      document.getElementById(CARD_ID).parentNode === p.body);
  }

  // ============ 6b. 卡片必须套用站点样式类（风格统一）+ 字段精简 ============
  console.log('\n=== 6b. 站点样式一致性 & 字段精简 ===');
  {
    resetDoc();
    const p = buildSitePanel({ withBasicId: true });
    docEls.body.appendChild(p.modal);
    CARD.renderState({
      card: 'single', kind: 'found', provider: 'amap', providerLabel: '高德地图',
      matchType: 'name', siteName: '故宫',
      info: {
        name: '故宫博物院', opentimeWeek: '周一至周日 08:30-17:00',
        opentimeToday: '08:30-17:00', cost: '60', address: '景山前街4号',
        tel: '010-85007421', rating: '4.8', status: 'open',
      },
      amapSearchUrl: '#', baiduSearchUrl: '#',
    });
    await sleep(80);
    const card = document.getElementById(CARD_ID);

    // 站点同款结构（这些类定义在站点 /main.css）
    check('含 <hr class="poi-section-hr">', !!card.querySelector('.poi-section-hr'));
    check('含 .poi-section-content-padding 包裹层', !!card.querySelector('.poi-section-content-padding'));
    check('标题用 .poi-section-title（站点蓝色小标题）', !!card.querySelector('.poi-section-title'));
    check('表格用 .table-no-border .attribute-table（站点同款表格）',
      !!card.querySelector('.attribute-table') && !!card.querySelector('.table-no-border'));

    // 字段精简：只保留 开放时间 / 票价 / 地址
    // 收集整棵子树的可见文本：既要处理 El 节点，也要处理 createTextNode 出来的文本节点
    const collect = (n) => {
      if (n.nodeType === 3) return String(n.textContent || '');
      let s = String(n._text || '');
      for (const c of (n.children || [])) s += collect(c);
      return s;
    };
    const text = collect(card);
    console.log('  卡片可见文本: ' + JSON.stringify(text));
    check('保留「开放时间」', text.includes('开放时间'));
    check('保留「票价」', text.includes('票价'));
    check('保留「地址」', text.includes('地址'));
    check('已去除「今日」', !text.includes('今日'));
    check('已去除「电话」', !text.includes('电话'));
    check('已去除「评分」', !text.includes('评分'));
    check('已去除「状态」', !text.includes('状态'));
    check('电话/评分不再出现在表格里', !text.includes('010-85007421') && !text.includes('4.8'));
  }

  // ============ 6c. 只有"有保护身份"的点位才显示开放信息 ============
  console.log('\n=== 6c. 普通 POI 不显示开放信息 ===');
  {
    // 真实字段：站点用 category 表达保护身份。
    // 注意马迭尔宾馆 feature_type 是"宾馆酒店"、息焉堂是"教堂"，都不是"文物古迹"，
    // 但两者都有保护身份；而西郊乡/大厦村/新天地公园的 category 是空数组。
    check('国保单位（类型却是宾馆酒店）→ 有身份',
      CARD.isDesignated({ name: '马迭尔宾馆', feature_type: '宾馆酒店',
        category: [{ category: { name: '全国重点文物保护单位' } }] }) === true);
    check('市保单位（类型却是教堂）→ 有身份',
      CARD.isDesignated({ name: '息焉堂', feature_type: '教堂',
        category: [{ category: { name: '上海市文物保护单位' } }] }) === true);
    check('乡级行政区（category 为空）→ 无身份',
      CARD.isDesignated({ name: '西郊乡', feature_type: '乡级行政区', category: [] }) === false);
    check('公园（category 为空）→ 无身份',
      CARD.isDesignated({ name: '新天地公园', feature_type: '公园', category: [] }) === false);
    check('字段整个缺失 → 失败开放（站点若改字段名不至于全失效）',
      CARD.isDesignated({ name: '某文保' }) === true);

    // 端到端点位：普通 POI 不应产生卡片，且会收掉上一个点位的卡片
    resetDoc();
    const p1 = buildSitePanel({ withBasicId: true });
    docEls.body.appendChild(p1.modal);
    CARD.renderState({
      card: 'single', kind: 'found', provider: 'amap', providerLabel: '高德地图',
      matchType: 'name', siteName: '息焉堂',
      info: { name: '息焉堂', opentimeWeek: '周一至周日 09:00-16:00' },
      amapSearchUrl: '#', baiduSearchUrl: '#',
    });
    await sleep(80);
    check('有身份的点位：卡片已注入', !!document.getElementById(CARD_ID));

    emit('hmp:poi-loaded', { name: '上海西郊宾馆', feature_type: '宾馆酒店', category: [] });
    await sleep(120);
    check('普通点位：卡片被收掉，不显示开放信息',
      document.getElementById(CARD_ID) === null);

    // 再切回有身份的点位，应恢复
    resetDoc();
    const p2 = buildSitePanel({ withBasicId: true });
    docEls.body.appendChild(p2.modal);
    emit('hmp:poi-loaded', { name: '息焉堂', feature_type: '教堂',
      category: [{ category: { name: '上海市文物保护单位' } }] });
    await sleep(120);
    check('切回有身份的点位：卡片恢复', !!document.getElementById(CARD_ID));
  }

  // ============ 6d. 匹配来源一律写明（含同名情况）+ 距离 ============
  console.log('\n=== 6d. 匹配来源提示 ===');
  {
    const collect = (n) => {
      if (n.nodeType === 3) return String(n.textContent || '');
      let s = String(n._text || '');
      for (const c of (n.children || [])) s += collect(c);
      return s;
    };
    const renderAndRead = async (state) => {
      resetDoc();
      const p = buildSitePanel({ withBasicId: true });
      docEls.body.appendChild(p.modal);
      CARD.renderState(Object.assign({
        card: 'single', kind: 'found', provider: 'amap', providerLabel: '高德地图',
        siteName: '息焉堂', amapSearchUrl: '#', baiduSearchUrl: '#',
      }, state));
      await sleep(80);
      return collect(document.getElementById(CARD_ID));
    };

    // 息焉堂地图上的名字和文保名一模一样 —— 旧实现不写任何来源，
    // 用户就无从判断这份开放时间是从哪个 POI 来的
    let text = await renderAndRead({
      matchType: 'name', matchDist: 120,
      info: { name: '息焉堂', opentimeWeek: '周一至周日 09:00-16:00' },
    });
    check('同名匹配也写明来源', text.includes('地图上同名点位：息焉堂'), text.slice(0, 120));
    check('同名匹配也给出距离', text.includes('直线约 120 米'), text.slice(0, 120));

    text = await renderAndRead({
      matchType: 'name', matchDist: 900,
      info: { name: '息焉堂（临时关闭）', opentimeWeek: '09:00-16:00' },
    });
    check('名称不同 → 写明实际匹配到的名称',
      text.includes('匹配到地图上的：息焉堂（临时关闭）'), text.slice(0, 120));

    text = await renderAndRead({
      matchType: 'location', matchDist: 210,
      info: { name: '上海马勒别墅饭店', opentimeWeek: '全天' },
    });
    check('位置匹配 → 说明是按位置找回的',
      text.includes('该点位现用名与文保名称不同，已按位置匹配到：上海马勒别墅饭店'), text.slice(0, 140));
  }

  // ============ 6e. 文物组不显示卡片；点进子项目才显示 ============
  console.log('\n=== 6e. 文物组不显示卡片 ===');
  {
    // 让流程能跑起来
    chrome.storage.local._store.amapKey = 'K';
    chrome.storage.local._store.enabled = true;
    const savedFetch = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: '1', pois: [] }) });

    resetDoc();
    const p = buildSitePanel({ withBasicId: true });
    docEls.body.appendChild(p.modal);

    const group = {
      name: '徐家汇天主教历史建筑群', feature_type: '文物组',
      admin: ['上海市 徐汇区'], category: [{ category: { name: '上海市文物保护单位' } }],
      members: [
        { kid: 'kid_obs', name: '徐家汇观象台旧址', geom: { type: 'Point', coordinates: [118, 32] } },
        { kid: 'kid_lib', name: '徐家汇藏书楼旧址', geom: { type: 'Point', coordinates: [118, 32] } },
      ],
    };
    emit('hmp:poi-loaded', group);
    await sleep(250);
    check('文物组：不显示任何卡片', document.getElementById(CARD_ID) === null,
      collectText(document.getElementById(CARD_ID)).slice(0, 110));

    // 点进子项目 → 这时才应该有卡片
    emit('hmp:poi-loaded', {
      name: '徐家汇观象台旧址', kid: 'kid_obs', feature_type: '文物古迹',
      admin: ['上海市 徐汇区'], category: [{ category: { name: '上海市文物保护单位' } }],
    });
    await sleep(250);
    check('点进子项目：显示该子项目自己的卡片', !!document.getElementById(CARD_ID));

    // 从组再切回子项目，不能因为"组已经看过"就不显示
    emit('hmp:poi-loaded', group);
    await sleep(200);
    check('切回文物组：卡片再次收掉', document.getElementById(CARD_ID) === null);

    emit('hmp:poi-loaded', {
      name: '徐家汇藏书楼旧址', kid: 'kid_lib', feature_type: '文物古迹',
      admin: ['上海市 徐汇区'], category: [{ category: { name: '上海市文物保护单位' } }],
    });
    await sleep(250);
    check('再点进另一个子项目：显示卡片', !!document.getElementById(CARD_ID));

    delete chrome.storage.local._store.amapKey;
    global.fetch = savedFetch;
  }

  // ============ 6g. 数据源兜底要说明原因 ============
  console.log('\n=== 6g. 数据源兜底提示 ===');
  {
    resetDoc();
    const p = buildSitePanel({ withBasicId: true });
    docEls.body.appendChild(p.modal);
    CARD.renderState({
      card: 'single', kind: 'found', provider: 'amap', providerLabel: '高德地图',
      matchType: 'name', matchDist: 120, siteName: '测试点',
      fallbackNote: '百度地图未返回结果，已回退到高德地图',
      info: { name: '测试点', opentimeToday: '09:00-17:00' },
      amapSearchUrl: '#', baiduSearchUrl: '#',
    });
    await sleep(80);
    let t = collectText(document.getElementById(CARD_ID));
    console.log('  卡片文本：' + JSON.stringify(t));
    check('卡片写明为何没用首选数据源',
      t.includes('百度地图未返回结果，已回退到高德地图'), t.slice(0, 160));

    // 未配置 Key 的说法
    resetDoc();
    const p2 = buildSitePanel({ withBasicId: true });
    docEls.body.appendChild(p2.modal);
    CARD.renderState({
      card: 'single', kind: 'found', provider: 'amap', providerLabel: '高德地图',
      matchType: 'name', siteName: '测试点',
      fallbackNote: '已在设置里首选百度地图，但没有填写它的 Key，暂用高德地图',
      info: { name: '测试点', opentimeToday: '09:00-17:00' },
      amapSearchUrl: '#', baiduSearchUrl: '#',
    });
    await sleep(80);
    t = collectText(document.getElementById(CARD_ID));
    check('缺 Key 时说清是没配 Key', t.includes('没有填写它的 Key'), t.slice(0, 160));

    // 字段级互补：开放时间来自另一家地图时要注明
    resetDoc();
    const p4 = buildSitePanel({ withBasicId: true });
    docEls.body.appendChild(p4.modal);
    CARD.renderState({
      card: 'single', kind: 'found', provider: 'amap', providerLabel: '高德地图',
      matchType: 'name', siteName: '测试点',
      supplementedBy: 'baidu', supplementedFields: ['开放时间'],
      info: { name: '测试点', opentimeWeek: '09:00-17:00' },
      amapSearchUrl: '#', baiduSearchUrl: '#',
    });
    await sleep(80);
    t = collectText(document.getElementById(CARD_ID));
    check('注明了字段来源（开放时间由百度地图补充）',
      t.includes('开放时间由百度地图补充'), t.slice(0, 160));

    // 印证强度：仅单一证据时要提示
    resetDoc();
    const p5 = buildSitePanel({ withBasicId: true });
    docEls.body.appendChild(p5.modal);
    CARD.renderState({
      card: 'single', kind: 'found', provider: 'amap', providerLabel: '高德地图',
      matchType: 'name', siteName: '测试点',
      verifiedBy: '仅名称（sim 1.00，未经地址/坐标印证）',
      info: { name: '测试点', opentimeToday: '09:00-17:00' },
      amapSearchUrl: '#', baiduSearchUrl: '#',
    });
    await sleep(80);
    t = collectText(document.getElementById(CARD_ID));
    check('单一证据不再弹提示（用户反馈太吵）',
      !t.includes('未获多路印证'), t.slice(0, 160));

    // 多路印证时不提示（避免噪音）
    resetDoc();
    const p6 = buildSitePanel({ withBasicId: true });
    docEls.body.appendChild(p6.modal);
    CARD.renderState({
      card: 'single', kind: 'found', provider: 'amap', providerLabel: '高德地图',
      matchType: 'name', siteName: '测试点',
      verifiedBy: '三重印证（名称+地址+坐标）',
      info: { name: '测试点', opentimeToday: '09:00-17:00' },
      amapSearchUrl: '#', baiduSearchUrl: '#',
    });
    await sleep(80);
    t = collectText(document.getElementById(CARD_ID));
    check('多路印证时同样不显示多余提示', !t.includes('未获多路印证'), t.slice(0, 140));

    // 没兜底时不应出现多余提示
    resetDoc();
    const p3 = buildSitePanel({ withBasicId: true });
    docEls.body.appendChild(p3.modal);
    CARD.renderState({
      card: 'single', kind: 'found', provider: 'baidu', providerLabel: '百度地图',
      matchType: 'name', siteName: '测试点',
      info: { name: '测试点', opentimeToday: '09:00-17:00' },
      amapSearchUrl: '#', baiduSearchUrl: '#',
    });
    await sleep(80);
    t = collectText(document.getElementById(CARD_ID));
    check('正常命中时不出现兜底提示', !t.includes('回退') && !t.includes('没有填写'), t.slice(0, 120));
  }

  // ============ 6f. 票价字段不可信时不显示 ============
  console.log("\n=== 6f. 票价合理性 ===");
  {
    const P = CARD.plausiblePrice;
    check("楼盘均价 81569.00 不是票价", P("81569.00") === false);
    check("「元/㎡」单位不是票价", P("81569 元/㎡") === false && P("30000元/平") === false);
    check("正常门票价保留", P("60") === true && P("120.00") === true);
    check("「免费」保留", P("免费") === true);
    check("上千的值不显示", P("1200") === false);

    // 端到端：卡片里不应出现这个荒谬值
    resetDoc();
    const p = buildSitePanel({ withBasicId: true });
    docEls.body.appendChild(p.modal);
    CARD.renderState({
      card: "single", kind: "found", provider: "amap", providerLabel: "高德地图",
      matchType: "name", siteName: "兆丰花园遗址",
      info: { name: "兆丰花园", opentimeToday: "00:00-24:00", cost: "81569.00" },
      amapSearchUrl: "#", baiduSearchUrl: "#",
    });
    await sleep(80);
    const t = collectText(document.getElementById(CARD_ID));
    console.log("  卡片文本：" + JSON.stringify(t));
    check("卡片里不出现 81569.00", !t.includes("81569"), t.slice(0, 140));
    check("卡片里不出现「票价」行", !t.includes("票价"), t.slice(0, 140));
  }

  // ============ 6. inspect() 诊断可用 ============
  console.log('\n=== 6. HMP.card.inspect() 诊断 ===');
  const info = CARD.inspect();
  console.log('  ' + JSON.stringify({
    详情面板: info.详情面板, 卡片: info.卡片, 最近一次渲染: info.最近一次渲染,
  }));
  check('inspect 返回详情面板信息', !!info.详情面板);
  check('inspect 报告卡片已插入', info.卡片.已插入 === true);
  check('inspect 报告最近一次渲染状态', !!info.最近一次渲染);

  console.log('\n结果: 通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
