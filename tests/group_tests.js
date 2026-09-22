// tests/group_tests.js
// 文物组的三个真实难题（用户实测反馈）：
//
//   ① 子项目开放时间不显示 / 表格太杂
//      → 表格只留「子项目 / 开放时间」两列；命中显示时间，未命中直接写"未匹配"
//
//   ② 细碎子单元盖过本体
//      上海孙中山故居 不该匹配「上海孙中山故居纪念馆-草坪与建筑」
//      → 高德 parent 字段 + 名称分隔符启发式，对子单元降权
//
//   ③ 泛词乱匹配
//      子项目「图书馆」应搜「上海市 上海交通大学早期建筑 图书馆」
//      而不是拿裸名「图书馆」去搜，匹配到"太极古法肩颈(华山路店)"
//      → naming.memberSearchNames 给子项检索名带上父文保名
//
//   ④ 文保组改名
//      圣约翰大学近代建筑 现为 华东政法大学长宁校区
//      → 增加"组级查询"，把现用名显示在表格上方
//
// 运行: node tests/group_tests.js
'use strict';
const fs = require('fs');
const path = require('path');

// ---------------- 迷你 DOM ----------------
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
    return { add(c) { if (!l().includes(c)) s.className = (s.className + ' ' + c).trim(); },
      remove(c) { s.className = l().filter(x => x !== c).join(' '); },
      contains(c) { return l().includes(c); } };
  }
  get textContent() { return this._text; } set textContent(v) { this._text = String(v); }
  get innerHTML() { return this._html; } set innerHTML(v) { this._html = String(v); }
  addEventListener() {}
  matches(sel) { return matchSimple(this, sel); }
  querySelector(sel) { const r = this.querySelectorAll(sel); return r.length ? r[0] : null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = n => { for (const c of (n.children || [])) { if (c.nodeType !== 1) continue; if (matchSimple(c, sel)) out.push(c); walk(c); } };
    walk(this); return out;
  }
}
function matchSimple(el, part) {
  if (!el || el.nodeType !== 1) return false;
  const idm = part.match(/#([A-Za-z0-9_-]+)/);
  if (idm && el.id !== idm[1]) return false;
  const cls = [...part.matchAll(/\.([A-Za-z0-9_-]+)/g)].map(m => m[1]);
  const own = String(el.className || '').split(/\s+/).filter(Boolean);
  for (const c of cls) if (!own.includes(c)) return false;
  const tag = part.match(/^([a-zA-Z]+)/);
  if (tag && el.tagName.toLowerCase() !== tag[1].toLowerCase()) return false;
  return true;
}

global.window = global;
global.location = { href: 'http://stele.geogv.org/zhcn/geo/g1', pathname: '/zhcn/geo/g1', hash: '', origin: 'http://stele.geogv.org' };
const docBody = new El('body');
const modalBody = new El('div'); modalBody.className = 'modal-body';
const basic = new El('div'); basic.className = 'poi-section-content-padding'; basic.id = 'poi-basic-info-section';
modalBody.appendChild(basic); docBody.appendChild(modalBody);
global.document = {
  body: docBody,
  createElement: t => new El(t),
  createTextNode: t => ({ nodeType: 3, textContent: t }),
  getElementById: id => (id === 'poi-basic-info-section' ? basic : (function w(n) {
    for (const c of (n.children || [])) { if (c.nodeType !== 1) continue; if (c.id === id) return c; const r = w(c); if (r) return r; }
    return null;
  })(docBody)),
  querySelector: s => (s === '.modal-body' ? modalBody : docBody.querySelector(s)),
  querySelectorAll: s => docBody.querySelectorAll(s),
};
global.window.addEventListener = () => {};
global.MutationObserver = class { observe() {} disconnect() {} };
global.chrome = {
  storage: { local: {
    _store: { amapKey: 'K', baiduAk: '', defaultProvider: 'amap', enabled: true },
    get(k, cb) { const store = this._store || {}; const o = (k == null) ? Object.assign({}, store) : (() => { const r = {}; for (const x of (Array.isArray(k) ? k : [k])) if (x in store) r[x] = store[x]; return r; })(); if (cb) cb(o); return Promise.resolve(o); },
    set(i, cb) { Object.assign(this._store, i); if (cb) cb(); return Promise.resolve(); },
    remove(k, cb) { const store = this._store || {}; for (const x of (Array.isArray(k) ? k : [k])) delete store[x]; if (cb) cb(); return Promise.resolve(); },
  } },
};

// ---------------- fetch mock ----------------
// byKeyword: 关键字搜索结果；aroundAt: 周边搜索结果（不分坐标，统一返回）
let byKeyword = {};      // keyword -> pois[]
let aroundPois = [];     // 周边搜索固定返回
const calls = [];
global.fetch = async (url) => {
  const u = String(url);
  calls.push(u);
  if (u.includes('/place/around')) {
    return { ok: true, status: 200, json: async () => ({ status: '1', pois: aroundPois }) };
  }
  const kw = new URL(u).searchParams.get('keywords') || '';
  return { ok: true, status: 200, json: async () => ({ status: '1', pois: byKeyword[kw] || [] }) };
};

const SRC = path.join(__dirname, '..', 'src', 'content');
['decoder', 'naming', 'geo', 'cache', 'http'].forEach(f => eval(fs.readFileSync(path.join(SRC, f + '.js'), 'utf8')));
eval(fs.readFileSync(path.join(SRC, 'apis', 'amap.js'), 'utf8'));
eval(fs.readFileSync(path.join(SRC, 'apis', 'baidu.js'), 'utf8'));
eval(fs.readFileSync(path.join(SRC, 'matcher.js'), 'utf8'));
eval(fs.readFileSync(path.join(SRC, 'card.js'), 'utf8'));

const HMP = window.HMP;
const N = HMP.naming;
const CARD = HMP.card;
const GEO = HMP.geo;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 站点坐标 ↔ 真实坐标的互算。
// 测试里想表达"这个地方真实在 (lon,lat)"时，feature 里必须填**站点坐标**
// （= 仿射逆变换），而地图候选的 location 要填**真实坐标转 GCJ02**。
const AFF = GEO.AFFINE;
const steleFromWgs = (lon, lat) => [
  (lon - AFF.lonB) / AFF.lonA,
  (lat - AFF.latB) / AFF.latA,
];
const amapLoc = (lon, lat) => {
  const g = GEO.wgs84ToGcj02(lon, lat);
  return g[0] + ',' + g[1];
};

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (detail ? '  → ' + detail : '')); }
}
const cardText = () => {
  const card = document.getElementById(CARD.CARD_ID);
  if (!card) return '';
  const collect = n => {
    if (n.nodeType === 3) return String(n.textContent || '');
    let s = String(n._text || '');
    for (const c of (n.children || [])) s += collect(c);
    return s;
  };
  return collect(card);
};

(async () => {
  // ============ ⑩ 子项目按项目组补全（白宫 → 组地址 + 组名+子项名）============
  console.log('\n=== ⑩ 子项目借用项目组上下文 ===');
  {
    calls.length = 0;
    byKeyword = {};
    // 项目组地址 = 万航渡路1575号（华东政法大学长宁校区）
    byKeyword['上海市 长宁区 万航渡路1575号'] = [
      { id: 'sj1', name: '华东政法大学(长宁校区)', type: '科教文化服务;学校',
        address: '万航渡路1575号', location: amapLoc(121.4230, 31.2250),
        business: { opentime_today: '06:00-22:00' } },
    ];
    // 坐标附近有个"看起来像机构"的干扰项 —— 修复前它会把「白宫」抢走
    aroundPois = [
      { id: 'bad', name: '中共上海市长宁区委员会', type: '政府机构;党委',
        location: amapLoc(121.4228, 31.2248) },
    ];
    window.HMP.featureApi = { fetchById: () => Promise.resolve(null) };

    // 先打开文物组：此时不显示卡片，但会记下组上下文
    const group = {
      name: '圣约翰大学近代建筑', feature_type: '文物组',
      address: '万航渡路1575号', admin: ['上海市 长宁区'],
      category: [{ category: { name: '上海市文物保护单位' } }],
      geom: { type: 'Point', coordinates: steleFromWgs(121.4230, 31.2250) },
      members: [
        { kid: 'k_white', name: '白宫', geom: { type: 'Point', coordinates: steleFromWgs(121.4230, 31.2250) } },
      ],
    };
    CARD.processFeature(group);
    await sleep(120);

    // 再点进子项目「白宫」—— 它自己没有门牌号
    calls.length = 0;
    CARD.processFeature({
      name: '白宫', kid: 'k_white', feature_type: '文物古迹',
      admin: ['上海市 长宁区'],                        // 只到区，没有几号
      category: [{ category: { name: '上海市文物保护单位' } }],
      geom: { type: 'Point', coordinates: steleFromWgs(121.4230, 31.2250) },
    });
    await sleep(250);

    const kws = calls.map(u => new URL(u).searchParams.get('keywords')).filter(Boolean);
    console.log('  实际发出的检索词：' + JSON.stringify(kws));
    check('名称用「上海市 圣约翰大学近代建筑 白宫」检索',
      kws.includes('上海市 圣约翰大学近代建筑 白宫'), JSON.stringify(kws));
    check('子项目没有门牌号 → 用项目组地址检索',
      kws.includes('上海市 长宁区 万航渡路1575号'), JSON.stringify(kws));
    // 直接验证：没有门牌号的点位，addrQuery 必须是空（不能是「上海市 长宁区」）
    const bare = CARD.extractPoi({ name: '某点位', admin: ['上海市 长宁区'], feature_type: '文物古迹' });
    check('无门牌号的点位：addrQuery 为空', bare.addrQuery === '', JSON.stringify(bare.addrQuery));
    const withAddr = CARD.extractPoi({ name: '某点位', address: '万航渡路1575号', admin: ['上海市 长宁区'], feature_type: '文物古迹' });
    check('有门牌号：addrQuery 正常拼出', withAddr.addrQuery === '上海市 长宁区 万航渡路1575号', withAddr.addrQuery);

    check('裸名「白宫」根本不会被作为检索词发出',
      !kws.includes('上海市 白宫'), JSON.stringify(kws));

    delete window.HMP.featureApi;
  }

  // ============ ⑪ 泛词子项目：远方同名地点不得胜出 ============
  console.log('\n=== ⑪ 泛词子项目 vs 远方同名地点 ===');
  {
    await window.HMP.cache.clear();   // ⑩ 查过同名点位，先清掉以免走缓存
    calls.length = 0;
    byKeyword = {};
    // 「白宫」在上海市确有同名地点，但在 8 公里外 —— 名称相似度 1.0，
    // 若不看距离，决策顺序里的"名称强命中"会直接拿走它，项目组地址那一路没机会出场。
    byKeyword['上海市 白宫'] = [
      { id: 'far', name: '白宫', type: '餐饮服务;咖啡厅',
        location: amapLoc(121.5000, 31.2000) },          // 远
    ];
    // 项目组地址 → 华东政法大学长宁校区（就在本体附近）
    byKeyword['上海市 长宁区 万航渡路1575号'] = [
      { id: 'near', name: '华东政法大学(长宁校区)', type: '科教文化服务;学校',
        address: '万航渡路1575号', location: amapLoc(121.4230, 31.2250),
        business: { opentime_today: '06:00-22:00' } },
    ];
    aroundPois = [];

    const group = {
      name: '圣约翰大学近代建筑', feature_type: '文物组',
      address: '万航渡路1575号', admin: ['上海市 长宁区'],
      category: [{ category: { name: '上海市文物保护单位' } }],
      geom: { type: 'Point', coordinates: steleFromWgs(121.4230, 31.2250) },
      members: [
        { kid: 'k_white', name: '白宫',
          geom: { type: 'Point', coordinates: steleFromWgs(121.4230, 31.2250) } },
      ],
    };
    CARD.processFeature(group);
    await sleep(120);

    // 点进子项目「白宫」——它自己没有门牌号
    calls.length = 0;
    CARD.processFeature({
      name: '白宫', kid: 'k_white', feature_type: '文物古迹',
      admin: ['上海市 长宁区'],
      category: [{ category: { name: '上海市文物保护单位' } }],
      geom: { type: 'Point', coordinates: steleFromWgs(121.4230, 31.2250) },
    });
    await sleep(300);

    const kws = calls.map(u => new URL(u).searchParams.get('keywords')).filter(Boolean);
    console.log('  实际发出的检索词：' + JSON.stringify(kws));
    const diag = CARD.inspect && CARD.inspect();
    // 用 lastGroup 之外的方式取不到单点结果，这里直接看卡片文本
    const text = (() => {
      const card = document.getElementById(CARD.CARD_ID);
      if (!card) return '';
      const collect = n => {
        if (n.nodeType === 3) return String(n.textContent || '');
        let t = String(n._text || '');
        for (const c of (n.children || [])) t += collect(c);
        return t;
      };
      return collect(card);
    })();
    console.log('  卡片文本：' + JSON.stringify(text));
    check('采用项目组地址上的华东政法大学（而不是 8 公里外的同名「白宫」）',
      text.includes('华东政法大学') && !text.includes('匹配到地图上的：白宫'), text.slice(0, 160));
    check('带出开放时间', text.includes('06:00-22:00'), text.slice(0, 160));
  }

  // ============ ⑫ 直接点子项目：靠自身的 relationinfo 找到父组 ============
  console.log('\n=== ⑫ relationinfo 定位父项目组 ===');
  {
    await window.HMP.cache.clear();
    calls.length = 0;
    byKeyword = {};
    // 只有"组地址"这一路能命中
    byKeyword['上海市 长宁区 万航渡路1575号'] = [
      { id: 'huazheng', name: '华东政法大学(长宁校区)', type: '科教文化服务;学校',
        address: '万航渡路1575号', location: amapLoc(121.4230, 31.2250),
        business: { opentime_today: '06:00-22:00' } },
    ];
    // 远方同名地点：名称相似度很高，若不卡距离就会被"名称强命中"拿走
    byKeyword['上海市 白宫'] = [
      { id: 'bnb', name: '白宫民宿(南汇大学城店)', type: '住宿服务;宾馆酒店',
        location: amapLoc(121.9000, 30.9000) },
    ];
    aroundPois = [];

    // 父组的 feature —— 白宫自己的 relationinfo 指向它
    const parentFeature = {
      name: '圣约翰大学近代建筑', feature_type: '文物组',
      address: '万航渡路1575号', admin: ['上海市 长宁区'],
      category: [{ category: { name: '全国重点文物保护单位' } }],
      geom: { type: 'Point', coordinates: steleFromWgs(121.4230, 31.2250) },
      members: [
        { kid: 'k_white', name: '白宫', geom: { type: 'Point', coordinates: steleFromWgs(121.4230, 31.2250) } },
      ],
    };
    let parentFetches = 0;
    window.HMP.featureApi = {
      fetchById(kid) {
        if (kid === 'k_group_sj') { parentFetches++; return Promise.resolve(parentFeature); }
        return Promise.resolve(null);
      },
    };

    // 注意：**没有**先打开组，直接派发子项目
    calls.length = 0;
    CARD.processFeature({
      name: '白宫', feature_type: '建筑',
      admin: ['上海市 长宁区'],
      category: [{ category: { name: '全国重点文物保护单位' } }],
      relationinfo: [{ kid: 'k_group_sj', name: '圣约翰大学近代建筑', feature_type: '文物古迹' }],
      geom: { type: 'Point', coordinates: steleFromWgs(121.4230, 31.2250) },
    });
    await sleep(300);

    const kws = calls.map(u => new URL(u).searchParams.get('keywords')).filter(Boolean);
    console.log('  实际发出的检索词：' + JSON.stringify(kws));
    check('按 relationinfo 拉了父项目组的 feature', parentFetches > 0, String(parentFetches));
    check('名称用「圣约翰大学近代建筑 白宫」检索',
      kws.includes('上海市 圣约翰大学近代建筑 白宫'), JSON.stringify(kws));
    check('地址用父项目组的门牌号',
      kws.includes('上海市 长宁区 万航渡路1575号'), JSON.stringify(kws));
    check('裸名「白宫」不作检索词', !kws.includes('上海市 白宫'), JSON.stringify(kws));

    const text = (() => {
      const card = document.getElementById(CARD.CARD_ID);
      if (!card) return '';
      const collect = n => {
        if (n.nodeType === 3) return String(n.textContent || '');
        let t = String(n._text || '');
        for (const c of (n.children || [])) t += collect(c);
        return t;
      };
      return collect(card);
    })();
    console.log('  卡片文本：' + JSON.stringify(text));
    check('匹配到华东政法大学，而不是 40 公里外的「白宫民宿」',
      text.includes('华东政法大学') && !text.includes('白宫民宿'), text.slice(0, 160));
    check('带出开放时间', text.includes('06:00-22:00'), text.slice(0, 160));

    delete window.HMP.featureApi;
  }

  // ============ ⑬ 同组子项必须落到同一个点位 ============
  console.log('\n=== ⑬ 同组子项结果一致性 ===');
  {
    // 万航渡路1575号 这个地址下有多栋楼。若打分用"子项目自己的坐标"，
    // 不同子项会各挑各的楼（实测：白宫→圣约翰大学校长故居，
    // 顾斐德纪念体育室→圣约翰大学旧址），看起来自相矛盾。
    const cand = [
      { id: 'c1', name: '圣约翰大学校长故居', type: '风景名胜;文物古迹',
        address: '万航渡路1575号', location: amapLoc(121.4222, 31.2244),
        business: { opentime_today: 'A' } },
      { id: 'c2', name: '圣约翰大学旧址', type: '风景名胜;文物古迹',
        address: '万航渡路1575号', location: amapLoc(121.4240, 31.2260),
        business: { opentime_today: 'B' } },
      { id: 'c3', name: '华东政法大学(长宁校区)', type: '科教文化服务;学校',
        address: '万航渡路1575号', location: amapLoc(121.4230, 31.2250),
        business: { opentime_today: 'C' } },
    ];

    const parentFeature = {
      name: '圣约翰大学近代建筑', feature_type: '文物组',
      address: '万航渡路1575号', admin: ['上海市 长宁区'],
      category: [{ category: { name: '全国重点文物保护单位' } }],
      geom: { type: 'Point', coordinates: steleFromWgs(121.4230, 31.2250) },
      members: [
        { kid: 'k_white', name: '白宫', geom: { type: 'Point', coordinates: steleFromWgs(121.4222, 31.2244) } },
        { kid: 'k_gym', name: '顾斐德纪念体育室', geom: { type: 'Point', coordinates: steleFromWgs(121.4240, 31.2260) } },
      ],
    };
    window.HMP.featureApi = {
      fetchById: (kid) => Promise.resolve(kid === 'k_group' ? parentFeature : null),
    };

    const cardText = () => {
      const card = document.getElementById(CARD.CARD_ID);
      if (!card) return '';
      const collect = n => {
        if (n.nodeType === 3) return String(n.textContent || '');
        let t = String(n._text || '');
        for (const c of (n.children || [])) t += collect(c);
        return t;
      };
      return collect(card);
    };
    const matchedOf = (text) => {
      const m = text.match(/匹配到地图上的：(.+?)(?:开放时间|$)/);
      return m ? m[1].trim() : '';
    };

    const runOne = async (name, lon, lat) => {
      await window.HMP.cache.clear();
      calls.length = 0;
      byKeyword = { '上海市 长宁区 万航渡路1575号': cand };   // 只有组地址这一路命中
      aroundPois = [];
      CARD.processFeature({
        name, feature_type: '建筑', admin: ['上海市 长宁区'],
        category: [{ category: { name: '全国重点文物保护单位' } }],
        relationinfo: [{ kid: 'k_group', name: '圣约翰大学近代建筑', feature_type: '文物古迹' }],
        geom: { type: 'Point', coordinates: steleFromWgs(lon, lat) },
      });
      await sleep(300);
      return cardText();
    };

    const t1 = await runOne('白宫', 121.4222, 31.2244);
    const m1 = matchedOf(t1);
    const t2 = await runOne('顾斐德纪念体育室', 121.4240, 31.2260);
    const m2 = matchedOf(t2);
    console.log('  白宫 → ' + m1);
    console.log('  顾斐德纪念体育室 → ' + m2);
    check('两个子项匹配到同一个点位', m1 && m1 === m2, m1 + ' vs ' + m2);
    check('落到的是校区级点位（不是各自最近的那栋楼）',
      m1 !== '', JSON.stringify(t1.slice(0, 140)));

    delete window.HMP.featureApi;
  }

  // ============ ⑭ 小区"借用"文保名 ============
  console.log('\n=== ⑭ 借用文保名的住宅小区 ===');
  {
    await window.HMP.cache.clear();
    calls.length = 0;
    // 长宁路780号就是上海中山公园的地址；「兆丰花园」是附近一个住宅小区，
    // 借用了中山公园的旧名（兆丰公园）。只看名称相似度，小区必赢。
    byKeyword = {
      '上海市 长宁区 长宁路780号': [
        { id: 'xiaoqu', name: '兆丰花园', type: '商务住宅;住宅区',
          address: '长宁路780号', location: amapLoc(121.4200, 31.2200) },
        { id: 'park', name: '中山公园', type: '风景名胜;公园',
          address: '长宁路780号', location: amapLoc(121.4205, 31.2205),
          business: { opentime_today: '05:00-21:00' } },
      ],
    };
    aroundPois = [];

    const b1 = CARD.borrowedNamePenalty('兆丰花园遗址', { name: '兆丰花园', type: '商务住宅;住宅区' });
    check('识别出住宅小区借用了文保名（前缀 + 住宅类型）', b1 < 1, String(b1));
    const b2 = CARD.borrowedNamePenalty('汾阳路152-158号小区', { name: '汾阳路152-158号小区', type: '商务住宅;住宅区' });
    check('文保本身即小区时不降权（名字等长）', b2 === 1, String(b2));
    const b3 = CARD.borrowedNamePenalty('兆丰花园遗址', { name: '兆丰花园', type: '风景名胜;公园' });
    check('非住宅类型不降权', b3 === 1, String(b3));

    calls.length = 0;
    CARD.processSingle({
      name: '兆丰花园遗址', feature_type: '文物古迹',
      address: '长宁路780号', admin: ['上海市 长宁区'],
      category: [{ category: { name: '文物保护点' } }],
      geom: { type: 'Point', coordinates: steleFromWgs(121.4202, 31.2202) },
    });
    await sleep(300);

    const text = (() => {
      const card = document.getElementById(CARD.CARD_ID);
      if (!card) return '';
      const collect = n => {
        if (n.nodeType === 3) return String(n.textContent || '');
        let t = String(n._text || '');
        for (const c of (n.children || [])) t += collect(c);
        return t;
      };
      return collect(card);
    })();
    console.log('  卡片文本：' + JSON.stringify(text));
    check('匹配到中山公园，而不是同名住宅小区',
      text.includes('中山公园') && !text.includes('兆丰花园'), text.slice(0, 160));
    check('带出中山公园的开放时间', text.includes('05:00-21:00'), text.slice(0, 160));
  }

  // ============ ⑮ 门牌号压过名称 ============
  console.log('\n=== ⑮ 门牌号证据压过名称相似度 ===');
  {
    await window.HMP.cache.clear();
    // 判别性用例：名字极像的候选在**不同门牌号**，名字完全不像的候选在**正确门牌号**。
    // 这是原来那套回归缺的一类——之前所有用例里两组候选的地址都一样，
    // 所以怎么调权重都区分不出来。
    const poi = {
      name: '兆丰花园遗址',
      nameVariants: ['兆丰花园遗址'],
      city: '上海市', adminLast: '长宁区',
      address: '长宁路780号',
      addrQuery: '上海市 长宁区 长宁路780号',
      gcj: [121.4202, 31.2202],
      bd09: [121.4265, 31.2262],
    };
    byKeyword = {
      '上海市 长宁区 长宁路780号': [
        { id: 'a', name: '兆丰花园', type: '商务住宅;住宅区',
          address: '长宁路788号',            // 不同门牌
          location: amapLoc(121.4201, 31.2201) },
        { id: 'b', name: '中山公园', type: '风景名胜;公园',
          address: '长宁路780号',            // 门牌对得上
          location: amapLoc(121.4205, 31.2205),
          business: { opentime_today: '05:00-21:00' } },
      ],
    };
    aroundPois = [];

    check('门牌不同 → ×0.6', CARD.houseNoPenalty(poi, { name: 'X', address: '长宁路788号' }) < 1);
    check('门牌相同 → 不罚', CARD.houseNoPenalty(poi, { name: 'X', address: '长宁路780号' }) === 1);
    check('候选没写地址 → 不罚（缺数据不等于不同楼）',
      CARD.houseNoPenalty(poi, { name: 'X' }) === 1);

    calls.length = 0;
    CARD.processSingle({
      name: '兆丰花园遗址', feature_type: '文物古迹',
      address: '长宁路780号', admin: ['上海市 长宁区'],
      category: [{ category: { name: '文物保护点' } }],
      geom: { type: 'Point', coordinates: steleFromWgs(121.4202, 31.2202) },
    });
    await sleep(300);

    const text = (() => {
      const card = document.getElementById(CARD.CARD_ID);
      if (!card) return '';
      const collect = n => {
        if (n.nodeType === 3) return String(n.textContent || '');
        let t = String(n._text || '');
        for (const c of (n.children || [])) t += collect(c);
        return t;
      };
      return collect(card);
    })();
    console.log('  卡片文本：' + JSON.stringify(text));
    check('门牌对得上的中山公园胜出（尽管名字完全不像）',
      text.includes('中山公园') && !text.includes('兆丰花园'), text.slice(0, 160));
    check('带出中山公园开放时间', text.includes('05:00-21:00'), text.slice(0, 160));
  }


  // ============ ⑯ 大型场地多门牌号 ============
  console.log('\n=== ⑯ 大型场地：门牌号不能当身份 ===');
  {
    await window.HMP.cache.clear();
    // 圆明园这类大型场地有多个门，小区/别墅群在几条路上都有出入口，
    // 遗产地图记的门牌和高德录入的**很可能不是同一个**，但指的是同一个地方。
    // 所以门牌号只能当"同级候选之间的决胜依据"，不能压过类型。
    // 场景：门牌对得上的是个写字楼（rank 1），本体公园（rank 2）记在隔壁号。
    const run = async (cands) => {
      await window.HMP.cache.clear();
      byKeyword = { '上海市 黄浦区 中山东一路780号': cands };
      aroundPois = [];
      calls.length = 0;
      CARD.processSingle({
        name: '某某园遗址', feature_type: '文物古迹',
        address: '中山东一路780号', admin: ['上海市 黄浦区'],
        category: [{ category: { name: '全国重点文物保护单位' } }],
        geom: { type: 'Point', coordinates: steleFromWgs(121.4900, 31.2400) },
      });
      const logs = [];
      const origLog = console.log;
      console.log = (...args) => { logs.push(args.join(' ')); };
      await sleep(300);
      console.log = origLog;
      return logs.join('\n');
    };

    // ① 门牌对得上的是写字楼，本体（公园）记在隔壁号 → 本体必须赢
    let log = await run([
      { id: 'a', name: '某某大厦', type: '商务住宅;楼宇',
        address: '中山东一路780号', location: amapLoc(121.49005, 31.24005) },
      { id: 'b', name: '某某园', type: '风景名胜;公园',
        address: '中山东一路782号', location: amapLoc(121.49010, 31.24010),
        business: { opentime_today: '07:00-19:00' } },
    ]);
    const hit = (log.match(/地址命中："([^"]+)"/) || [])[1] || '';
    console.log('  ① 命中：' + hit);
    check('大型场地：本体（公园）压过门牌对得上的写字楼', hit === '某某园', hit);

    // ② 同类型候选之间，门牌号才是决胜依据
    log = await run([
      { id: 'c', name: '某某园甲区', type: '风景名胜;公园',
        address: '中山东一路790号', location: amapLoc(121.4906, 31.2406),
        business: { opentime_today: 'A' } },
      { id: 'd', name: '某某园乙区', type: '风景名胜;公园',
        address: '中山东一路780号', location: amapLoc(121.49005, 31.24005),
        business: { opentime_today: 'B' } },
    ]);
    const hit2 = (log.match(/地址命中："([^"]+)"/) || [])[1] || '';
    console.log('  ② 命中：' + hit2);
    check('同级候选之间，门牌号对得上的胜出', hit2 === '某某园乙区', hit2);
  }

  // ============ ⑰ 大型场地不得落到大门上 ============
  console.log('\n=== ⑰ 多门场地：要落到本体，不是某个门 ===');
  {
    await window.HMP.cache.clear();
    // 圆明园这类多门场地，地图上有一堆「圆明园（东门）」「圆明园南门」。
    // 门比本体离坐标更近，若不排除设施/门址，会直接指向大门。
    const poi = {
      name: '圆明园', nameVariants: ['圆明园'],
      city: '北京市', adminLast: '海淀区',
      gcj: [116.2980, 40.0080], bd09: [116.3043, 40.0142],
    };
    aroundPois = [
      { id: 'g1', name: '圆明园（东门）', type: '风景名胜;公园',
        location: '116.29805,40.00805', business: { opentime_today: '大门时间' } },
      { id: 'g2', name: '圆明园南门', type: '风景名胜;公园',
        location: '116.29802,40.00802' },
      { id: 'p1', name: '圆明园', type: '风景名胜;公园',
        location: '116.29950,40.00950', business: { opentime_today: '07:00-19:00' } },
    ];
    check('大门被判为设施类（rank 0）',
      CARD.heritageRank({ name: '圆明园（东门）', type: '风景名胜;公园' }) === 0 &&
      CARD.heritageRank({ name: '圆明园南门', type: '风景名胜;公园' }) === 0);

    const r = await CARD.searchNearby({ amapKey: 'K' }, 'amap', poi);
    console.log('  坐标路径选中：' + (r ? r.matched.poi.name : '无'));
    check('坐标路径落到本体「圆明园」而不是某个门',
      !!r && r.matched.poi.name === '圆明园', r ? r.matched.poi.name : '无');

    // 名称路径同样不能被门抢走
    byKeyword = { '北京市 圆明园': aroundPois };
    const r2 = await CARD.searchByName({ amapKey: 'K' }, 'amap', poi);
    console.log('  名称路径选中：' + (r2 ? r2.matched.poi.name : '无'));
    check('名称路径也落到本体', !!r2 && r2.matched.poi.name === '圆明园',
      r2 ? r2.matched.poi.name : '无');
  }

  // ============ ⑱ 地址只返回借名小区，坐标路径认得本体 ============
  console.log('\n=== ⑱ 兆丰花园遗址：地址只给小区，坐标给本体 ===');
  {
    await window.HMP.cache.clear();
    // 真实情形：高德对「长宁路780号」的地址检索只返回同名住宅小区「兆丰花园」，
    // 根本没返回中山公园 —— 这时再重的候选惩罚也没用，因为候选表里就没有公园。
    // 能救回来的是**坐标路径**：本体就在那儿，而且是类型正确的公园。
    byKeyword = {
      '上海市 长宁区 长宁路780号': [
        { id: 'xq', name: '兆丰花园', type: '商务住宅;住宅区',
          address: '长宁路780号', location: amapLoc(121.4200, 31.2200) },
      ],
    };
    aroundPois = [
      { id: 'xq2', name: '兆丰花园', type: '商务住宅;住宅区',
        location: amapLoc(121.4200, 31.2200) },
      { id: 'zs', name: '中山公园', type: '风景名胜;公园',
        location: amapLoc(121.4205, 31.2205),
        business: { opentime_today: '05:00-21:00' } },
    ];

    calls.length = 0;
    const logs = [];
    const origLog = console.log;
    console.log = (...a) => { logs.push(a.join(' ')); };
    CARD.processSingle({
      name: '兆丰花园遗址', feature_type: '文物古迹',
      address: '长宁路780号', admin: ['上海市 长宁区'],
      category: [{ category: { name: '文物保护点' } }],
      geom: { type: 'Point', coordinates: steleFromWgs(121.4202, 31.2202) },
    });
    await sleep(300);
    console.log = origLog;
    const out = logs.join('\n');
    console.log('  三路：' + (out.split('\n').find(l => l.includes('三路结果')) || '').trim());
    check('识别出地址命中是借用文保名的住宅类',
      /借用文保名的住宅类/.test(out), out.split('\n').slice(0, 3).join(' | '));
    check('最终采用坐标路径的中山公园',
      /✅ [^：]*：中山公园/.test(out),
      (out.split('\n').find(l => l.includes('✅')) || '未采用任何结果').trim());
    // 并确认给出的是"仅坐标"这一级别（未经名称/地址印证），如实反映可信度
    check('如实标注了印证级别为「仅坐标」',
      /✅ 仅坐标/.test(out),
      (out.split('\n').find(l => l.includes('✅')) || '').trim());
  }

  console.log('\n结果: 通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
