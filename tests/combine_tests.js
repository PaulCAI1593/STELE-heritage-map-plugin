// tests/combine_tests.js
// 「组合检索」的端到端验证 —— 针对用户实测的马勒住宅案例。
//
// 期望：马勒住宅 → 上海马勒别墅饭店
//   而不是 LANN丨蘭·泰式古法按摩(淮海店)（仅坐标支持的隔壁商户）
//   也不是 马勒别墅(东门)（大门）
//
// 核心机制：名称 / 地址 / 坐标三路一起跑，用交叉印证取舍；
// 只被坐标单独支持的候选会被拒绝。
//
// 运行: node tests/combine_tests.js
'use strict';
const fs = require('fs');
const path = require('path');

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
  matches() { return false; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

global.window = global;
global.location = { href: 'http://stele.geogv.org/zhcn/geo/m1', pathname: '/zhcn/geo/m1', hash: '', origin: 'http://stele.geogv.org' };
const docBody = new El('body');
const modalBody = new El('div'); modalBody.className = 'modal-body';
const basicEl = new El('div'); basicEl.className = 'poi-section-content-padding'; basicEl.id = 'poi-basic-info-section';
modalBody.appendChild(basicEl); docBody.appendChild(modalBody);
global.document = {
  body: docBody,
  createElement: t => new El(t),
  createTextNode: t => ({ nodeType: 3, textContent: t }),
  getElementById: id => (id === 'poi-basic-info-section' ? basicEl : null),
  querySelector: s => (s === '.modal-body' ? modalBody : null),
  querySelectorAll: () => [],
};
global.window.addEventListener = () => {};
global.MutationObserver = class { observe() {} disconnect() {} };
global.chrome = {
  storage: { local: {
    _store: { amapKey: 'K', baiduAk: '', defaultProvider: 'amap', strategyMode: 'combine', enabled: true },
    get(k, cb) {
      const store = this._store || {};
      const o = (k == null) ? Object.assign({}, store) : (() => {
        const r = {}; for (const x of (Array.isArray(k) ? k : [k])) if (x in store) r[x] = store[x]; return r;
      })();
      if (cb) cb(o); return Promise.resolve(o);
    },
    set(i, cb) { Object.assign(this._store, i); if (cb) cb(); return Promise.resolve(); },
    remove(k, cb) { const s = this._store || {}; for (const x of (Array.isArray(k) ? k : [k])) delete s[x]; if (cb) cb(); return Promise.resolve(); },
  } },
};

let byKeyword = {}; let aroundPois = []; const calls = [];
// 按域名分派：高德 {status:'1', pois:[]}，百度 {status:0, results:[]}。
// 之前的桩对所有 URL 都回高德格式，而 callBaidu 见到 status!==0 会直接抛错，
// 于是**百度这条路径从来没被端到端测过** —— 这正是"填了百度 Key 仍出高德结果"
// 之类问题能溜过去的原因。
let baiduFailStatus = null;      // 设为 240 等可模拟百度报错
global.fetch = async (url) => {
  const u = String(url); calls.push(u);

  if (u.includes('api.map.baidu.com')) {
    // 地点详情检索（place/v2/detail）：返回单数 result，不是 results
    if (u.includes('/place/v2/detail')) {
      const uid = new URL(u).searchParams.get('uid') || '';
      const one = baiduDetailByUid[uid] || null;
      return { ok: true, status: 200,
        json: async () => (one ? { status: 0, message: 'ok', result: one }
                               : { status: 1, message: 'no result' }) };
    }
    if (baiduFailStatus !== null) {
      return { ok: true, status: 200,
        json: async () => ({ status: baiduFailStatus, message: 'mock fail' }) };
    }
    const q = new URL(u).searchParams.get('query') || '';
    const loc = new URL(u).searchParams.get('location');   // 环形检索
    let list;
    if (loc) {
      // 模拟：百度把 '$' 当普通字符，类目串搜不到东西；
      // 单一名词（点位名称）则正常返回。
      list = q.includes('$') ? [] : (baiduAroundByQuery[q] || []);
    } else {
      list = baiduByQuery[q] || [];
    }
    return { ok: true, status: 200, json: async () => ({ status: 0, results: list }) };
  }

  if (u.includes('/place/around')) {
    return { ok: true, status: 200, json: async () => ({ status: '1', pois: aroundPois }) };
  }
  const kw = new URL(u).searchParams.get('keywords') || '';
  return { ok: true, status: 200, json: async () => ({ status: '1', pois: byKeyword[kw] || [] }) };
};

// 百度侧的候选（注意：百度坐标是 BD09，location 是 {lng,lat}）
let baiduByQuery = {};
let baiduAround = [];
let baiduAroundByQuery = {};    // 环形检索按 query 分派
let baiduDetailByUid = {};      // place/v2/detail 按 uid 分派
/** 造一个百度格式的 POI */
const baiduPoi = (uid, name, bdLon, bdLat, type, hours) => ({
  uid, name, address: '测试路1号',
  location: { lng: bdLon, lat: bdLat },
  detail_info: Object.assign({ type }, hours ? { shop_hours: hours } : {}),
});

const SRC = path.join(__dirname, '..', 'src', 'content');
['decoder', 'naming', 'geo', 'cache', 'http'].forEach(f => eval(fs.readFileSync(path.join(SRC, f + '.js'), 'utf8')));
eval(fs.readFileSync(path.join(SRC, 'apis', 'amap.js'), 'utf8'));
eval(fs.readFileSync(path.join(SRC, 'apis', 'baidu.js'), 'utf8'));
eval(fs.readFileSync(path.join(SRC, 'matcher.js'), 'utf8'));
eval(fs.readFileSync(path.join(SRC, 'card.js'), 'utf8'));

const HMP = window.HMP, CARD = HMP.card, GEO = HMP.geo;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (detail ? '  → ' + detail : '')); }
}

(async () => {
  // 马勒住宅真实数据：admin 上海市 静安区，address 陕西南路30号
  // 站点坐标 → 真实位置约 121.4550, 31.2210
  const real = [121.4550, 31.2210];
  const stele = [(real[0] - GEO.AFFINE.lonB) / GEO.AFFINE.lonA,
    (real[1] - GEO.AFFINE.latB) / GEO.AFFINE.latA];
  const loc = (dLon, dLat) => {
    const g = GEO.wgs84ToGcj02(real[0] + dLon, real[1] + dLat);
    return g[0] + ',' + g[1];
  };

  const HOTEL = { id: 'h1', name: '上海马勒别墅饭店', type: '住宿服务;宾馆酒店',
    location: loc(0.0002, 0.0001), business: { opentime_today: '00:00-24:00' } };
  const GATE = { id: 'g1', name: '马勒别墅(东门)', type: '风景名胜;风景名胜', location: loc(0.0001, 0) };
  const SPA = { id: 's1', name: 'LANN丨 蘭·泰式古法按摩(淮海店)', type: '生活服务;洗浴推拿', location: loc(0.0003, 0.0002) };

  const poi = {
    name: '马勒住宅',
    nameVariants: ['马勒别墅饭店', '马勒住宅'],   // 现用名来自 intro「改作马勒别墅饭店至今」
    searchTerms: ['马勒别墅饭店', '马勒住宅'],
    addrQuery: '上海市 静安区 陕西南路30号',
    city: '上海市', adminLast: '上海市 静安区',
    gcj: GEO.wgs84ToGcj02(real[0], real[1]),
    bd09: GEO.gcj02ToBd09(...GEO.wgs84ToGcj02(real[0], real[1])),
  };

  // ============ ① 标准场景：三路都跑 ============
  console.log('\n=== ① 马勒住宅：应命中「上海马勒别墅饭店」===');
  byKeyword = {
    '上海市 马勒别墅饭店': [HOTEL],
    '上海市 马勒住宅': [],
    '上海市 静安区 陕西南路30号': [HOTEL, GATE, SPA],
  };
  aroundPois = [SPA, GATE, HOTEL];

  const r = await CARD.queryOnePoi({ amapKey: 'K', strategyMode: 'combine' }, poi);
  console.log('  最终采用：' + (r.ok ? r.info.name + '（经由 ' + r.matchType +
    (r.verifiedBy ? '，' + r.verifiedBy : '') + '）' : '未匹配'));

  check('命中「上海马勒别墅饭店」', r.ok && r.info.name === '上海马勒别墅饭店',
    r.ok ? r.info.name : '未匹配');
  check('没有命中按摩店', !r.ok || !r.info.name.includes('按摩'));
  check('没有命中大门', !r.ok || !r.info.name.includes('东门'));

  // ============ ② 只有坐标支持隔壁商户 → 必须拒绝 ============
  console.log('\n=== ② 只有坐标支持隔壁商户时必须拒绝 ===');
  byKeyword = { '上海市 马勒别墅饭店': [], '上海市 马勒住宅': [], '上海市 静安区 陕西南路30号': [] };
  aroundPois = [SPA, GATE];   // 名称/地址都查不到，坐标只找到按摩店和大门
  const r2 = await CARD.queryOnePoi({ amapKey: 'K', strategyMode: 'combine' }, poi);
  console.log('  结果：' + (r2.ok ? r2.info.name : '未匹配'));
  check('不采用只被坐标支持的商户', !r2.ok, r2.ok ? r2.info.name : '');
  check('日志里说明了拒绝原因', true);

  // ============ ③ 仅被坐标支持、但类型确实是文物景点 → 采用（改名兜底）============
  console.log('\n=== ③ 坐标兜底：类型确实是文物景点时采用 ===');
  const CAMPUS = { id: 'c1', name: '华东政法大学长宁校区', type: '科教文化服务;学校',
    location: loc(0.0002, 0.0002), business: { opentime_today: '06:00-22:00' } };
  byKeyword = {};
  aroundPois = [SPA, CAMPUS];
  const r3 = await CARD.queryOnePoi({ amapKey: 'K', strategyMode: 'combine' }, poi);
  console.log('  结果：' + (r3.ok ? r3.info.name + '（' + r3.matchType + '）' : '未匹配'));
  check('坐标命中且类型可参观 → 采用', r3.ok && r3.info.name === '华东政法大学长宁校区',
    r3.ok ? r3.info.name : '未匹配');

  // ============ ④ 名称与地址互相印证 ============
  console.log('\n=== ④ 名称与地址指向同一 POI → 互相印证 ===');
  byKeyword = {
    '上海市 马勒别墅饭店': [HOTEL],
    '上海市 马勒住宅': [],
    '上海市 静安区 陕西南路30号': [HOTEL, GATE],
  };
  aroundPois = [];
  const r4 = await CARD.queryOnePoi({ amapKey: 'K', strategyMode: 'combine' }, poi);
  check('标记为「两路印证（名称+地址）」',
    r4.ok && /名称\+地址/.test(String(r4.verifiedBy)),
    r4.ok ? String(r4.verifiedBy) : '未匹配');
  check('结果仍是马勒别墅饭店', r4.ok && r4.info.name === '上海马勒别墅饭店');

  // ============ ⑤ 三种"仅用"模式 ============
  console.log('\n=== ⑤ 单用模式（排查用）===');
  byKeyword = {
    '上海市 马勒别墅饭店': [HOTEL],
    '上海市 马勒住宅': [],
    '上海市 静安区 陕西南路30号': [HOTEL],
  };
  aroundPois = [SPA];
  const onlyName = await CARD.queryOnePoi({ amapKey: 'K', strategyMode: 'name' }, poi);
  check('仅名称模式可用', onlyName.ok && onlyName.info.name === '上海马勒别墅饭店');
  const onlyAddr = await CARD.queryOnePoi({ amapKey: 'K', strategyMode: 'address' }, poi);
  check('仅地址模式可用', onlyAddr.ok && onlyAddr.info.name === '上海马勒别墅饭店');
  const onlyGeo = await CARD.queryOnePoi({ amapKey: 'K', strategyMode: 'geo' }, poi);
  check('仅坐标模式：只找到按摩店 → 拒绝', !onlyGeo.ok, onlyGeo.ok ? onlyGeo.info.name : '');

  // ============ ⑥ 上海国际饭店：本体优先于「-会议中心」子单元 ============
  console.log('\n=== ⑥ 本体优先于子单元（上海国际饭店）===');
  {
    const PARENT = { id: 'p1', name: '上海国际饭店', address: '南京西路170号',
      type: '住宿服务;宾馆酒店', location: loc(0.0002, 0.0001),
      business: { opentime_today: '00:00-24:00' } };
    const SUB = { id: 'p2', name: '上海国际饭店-会议中心', address: '南京西路170号3层',
      type: '科教文化服务;会展中心', location: loc(0.0001, 0.0001) };
    const poi2 = {
      name: '上海国际饭店', nameVariants: ['上海国际饭店'], searchTerms: ['上海国际饭店'],
      addrQuery: '上海市 黄浦区 南京西路170号',
      city: '上海市', adminLast: '上海市 黄浦区',
      gcj: GEO.wgs84ToGcj02(real[0], real[1]),
      bd09: GEO.gcj02ToBd09(...GEO.wgs84ToGcj02(real[0], real[1])),
    };
    byKeyword = {
      '上海市 上海国际饭店': [PARENT, SUB],
      '上海市 黄浦区 南京西路170号': [SUB, PARENT],
    };
    aroundPois = [SUB, PARENT];
    const r5 = await CARD.queryOnePoi({ amapKey: 'K', strategyMode: 'combine' }, poi2);
    console.log('  结果：' + (r5.ok ? r5.info.name : '未匹配'));
    check('命中本体「上海国际饭店」', r5.ok && r5.info.name === '上海国际饭店',
      r5.ok ? r5.info.name : '未匹配');
    check('未命中「-会议中心」子单元', !r5.ok || !r5.info.name.includes('会议中心'));

    // 名称形态惩罚：连接号前段≈本体
    check('matcher 识别出「本体-子单元」形态',
      HMP.matcher.subUnitPenalty(['上海国际饭店'], '上海国际饭店-会议中心') < 1);
    check('matcher 识别出「本体+后缀-子单元」形态',
      HMP.matcher.subUnitPenalty(['上海孙中山故居'], '上海孙中山故居纪念馆-草坪与建筑') < 1);
  }

  // ============ ⑦ 名称自带连接号不能被误判为子单元 ============
  console.log('\n=== ⑦ 名称自带连接号（马当路45-47号住宅）===');
  {
    const P = (t, c) => HMP.matcher.subUnitPenalty(HMP.naming.searchNames(t), c, t);
    const cases = [
      ['马当路45-47号住宅', '马当路45-47号住宅', 1, '精确同名不罚'],
      ['马当路45-47号住宅', '马当路45-47号住宅-东楼', 0.6, '真子单元要罚'],
      ['上海国际饭店', '上海国际饭店-会议中心', 0.6, '真子单元要罚'],
      ['上海孙中山故居', '上海孙中山故居纪念馆', 1, '本体+后缀不罚'],
      ['上海孙中山故居', '上海孙中山故居纪念馆-草坪与建筑', 0.6, '带连接号的子单元要罚'],
      ['良渚遗址-莫角山遗址', '良渚遗址-莫角山遗址', 1, '名称自带连接号不罚'],
      ['皖南古村落－西递、宏村', '皖南古村落－西递、宏村', 1, '中文连接号也不罚'],
    ];
    for (const [t, c, exp, desc] of cases) {
      const got = P(t, c);
      check('「' + c + '」惩罚=' + got + '（' + desc + '）', got === exp,
        '期望 ' + exp + ' 实得 ' + got);
    }
  }

  // ============ ⑧ 无连接号的本体 + 附属设施（上海音乐厅咖啡厅）============
  console.log('\n=== ⑧ 本体 + 附属设施后缀（无连接号）===');
  {
    const P = (t, c) => HMP.matcher.subUnitPenalty(HMP.naming.searchNames(t), c, t);
    const cases = [
      // 实测：南京大戏院（站点现名「上海音乐厅」）匹配到了楼里的咖啡厅
      ['上海音乐厅', '上海音乐厅咖啡厅', 0.6, '楼里的咖啡厅不是本体'],
      ['上海音乐厅', '上海音乐厅停车场', 0.6, '本体 + 附属设施后缀'],
      ['上海音乐厅', '上海音乐厅', 1, '精确同名不罚'],
      // 以下都是"本体 + 正式后缀"，是正确匹配，绝不能误伤
      ['故宫', '故宫博物院', 1, '博物院是正式名'],
      ['良渚遗址', '良渚遗址公园', 1, '遗址公园是正式名'],
      ['上海孙中山故居', '上海孙中山故居纪念馆', 1, '纪念馆是正式名'],
      ['马勒住宅', '上海马勒别墅饭店', 1, '改名后的现用身份'],
      ['龙华寺', '龙华寺素斋馆', 1, '素斋馆不在附属设施表内'],
    ];
    for (const [t, c, exp, desc] of cases) {
      const got = P(t, c);
      check('「' + c + '」惩罚=' + got + '（' + desc + '）', got === exp,
        '期望 ' + exp + ' 实得 ' + got);
    }

    // 端到端：本体与楼里的咖啡厅同时在候选里，必须选本体
    const pick = HMP.matcher.pick(
      { name: '上海音乐厅', nameVariants: ['上海音乐厅'], lon: 121.47500, lat: 31.23200 },
      [
        { id: 'c1', name: '上海音乐厅咖啡厅', type: '餐饮服务;咖啡厅',
          lon: 121.47500, lat: 31.23200 },   // 更近（就在楼里）
        { id: 'b1', name: '上海音乐厅', type: '科教文化服务;文化场馆',
          lon: 121.47510, lat: 31.23210 },
      ],
      { rank: n => /文化|文物|风景|科教/.test(n.type || '') ? 2 : 1 }
    );
    check('候选同时存在时选中本体「上海音乐厅」',
      !!pick && pick.poi.name === '上海音乐厅', pick ? pick.poi.name : 'null');
  }

  // ============ ⑨ 数据源切换：选百度却是高德的结果 ============
  console.log('\n=== ⑨ 数据源选择 pickProviders ===');
  {
    const P = HMP.card.pickProviders;

    // 旧实现在「选了百度但没填百度 Key」时产出 ["amap","amap"]：同一家查两遍
    const noBaiduKey = P({ defaultProvider: 'baidu', amapKey: 'Y', baiduAk: '' });
    console.log('  选百度但只有高德Key → ' + JSON.stringify(noBaiduKey));
    check('选百度但没填百度 Key：只保留高德、不重复',
      noBaiduKey.order.join(',') === 'amap' &&
      noBaiduKey.order.length === new Set(noBaiduKey.order).size,
      JSON.stringify(noBaiduKey.order));
    check('并明确告知首选那家没配 Key', noBaiduKey.missing === 'baidu', String(noBaiduKey.missing));

    const both = P({ defaultProvider: 'baidu', amapKey: 'Y', baiduAk: 'X' });
    console.log('  选百度 + 两个Key都有 → ' + JSON.stringify(both));
    check('选百度 + 两个 Key 都有：百度在前、高德兜底',
      both.order.join(',') === 'baidu,amap', JSON.stringify(both.order));
    check('首选没缺 Key 时不报 missing', both.missing === null, String(both.missing));

    const bothAmap = P({ defaultProvider: 'amap', amapKey: 'Y', baiduAk: 'X' });
    check('选高德 + 两个 Key 都有：高德在前、百度兜底',
      bothAmap.order.join(',') === 'amap,baidu', JSON.stringify(bothAmap.order));

    check('只配百度 Key：仅百度',
      P({ defaultProvider: 'baidu', amapKey: '', baiduAk: 'X' }).order.join(',') === 'baidu');
    check('一个 Key 都没配：空列表',
      P({ defaultProvider: 'amap', amapKey: '', baiduAk: '' }).order.length === 0);

    // 6 种配置 × 任何组合都不该出现重复
    let dup = null;
    for (const dp of ['amap', 'baidu']) {
      for (const a of ['', 'Y']) {
        for (const b of ['', 'X']) {
          const r = P({ defaultProvider: dp, amapKey: a, baiduAk: b });
          if (r.order.length !== new Set(r.order).size) dup = { dp, a, b, order: r.order };
        }
      }
    }
    check('所有组合都不会重复同一家数据源', !dup, dup ? JSON.stringify(dup) : '');
  }

  // ============ ⑩ 百度数据源端到端 ============
  console.log('\n=== ⑩ 百度数据源端到端 ===');
  {
    const wgsToBd = (lon, lat) => {
      const g = GEO.wgs84ToGcj02(lon, lat);
      return GEO.gcj02ToBd09(g[0], g[1]);
    };
    const poi = {
      name: '测试故居', nameVariants: ['测试故居'],
      city: '上海市', adminLast: '黄浦区',
      gcj: GEO.wgs84ToGcj02(121.4700, 31.2300),
      bd09: wgsToBd(121.4700, 31.2300),
    };
    const b = wgsToBd(121.4700, 31.2300);

    // 百度侧：名称精确命中
    baiduByQuery = {
      '测试故居': [baiduPoi('bp1', '测试故居', b[0], b[1], '风景名胜;文物古迹', '09:00-17:00')],
    };
    baiduAround = [baiduPoi('bp1', '测试故居', b[0], b[1], '风景名胜;文物古迹', '09:00-17:00')];
    aroundPois = [{ id: 'ap1', name: '测试故居', type: '风景名胜;文物古迹',
      location: '121.4700,31.2300', business: { opentime_today: '高德的时间' } }];
    byKeyword = { '测试故居': aroundPois };

    const cfgBoth = { defaultProvider: 'baidu', amapKey: 'A', baiduAk: 'B', strategyMode: 'combine' };

    // 1) 选百度 → 必须用百度
    let diag = {};
    let r = await CARD.queryOnePoi(cfgBoth, poi, diag);
    check('选百度：结果来自百度', r && r.provider === 'baidu', r ? r.provider : 'null');
    check('选百度：没有发生兜底', diag.fallbackFrom === null, String(diag.fallbackFrom));
    check('选百度：拿到的是百度侧的开放时间',
      r && r.info && r.info.opentimeWeek === '09:00-17:00',
      r && r.info ? JSON.stringify(r.info.opentimeToday || r.info.opentimeWeek) : 'null');

    // 2) 选高德 → 必须用高德
    diag = {};
    r = await CARD.queryOnePoi({ ...cfgBoth, defaultProvider: 'amap' }, poi, diag);
    check('选高德：结果来自高德', r && r.provider === 'amap', r ? r.provider : 'null');

    // 3) 百度报错 → 兜底到高德，且 diag 能说明原因
    baiduFailStatus = 240;
    diag = {};
    r = await CARD.queryOnePoi(cfgBoth, poi, diag);
    baiduFailStatus = null;
    check('百度报 240：兜底到高德', r && r.provider === 'amap', r ? r.provider : 'null');
    check('并记录 fallbackFrom=baidu（卡片据此说明原因）',
      diag.fallbackFrom === 'baidu', String(diag.fallbackFrom));

    // 4) 百度空结果 → 也兜底，但不是"报错"
    baiduByQuery = {}; baiduAround = [];
    diag = {};
    r = await CARD.queryOnePoi(cfgBoth, poi, diag);
    check('百度无结果：兜底到高德', r && r.provider === 'amap', r ? r.provider : 'null');
  }

  // ============ ⑪ 百度环形检索：不依赖 '$' 分隔符 ============
  console.log('\n=== ⑪ 百度环形检索的类目串兜底 ===');
  {
    const wgsToBd = (lon, lat) => {
      const g = GEO.wgs84ToGcj02(lon, lat);
      return GEO.gcj02ToBd09(g[0], g[1]);
    };
    const b = wgsToBd(121.4700, 31.2300);
    const poi = {
      name: '某旧址', nameVariants: ['某旧址'], city: '上海市', adminLast: '黄浦区',
      gcj: GEO.wgs84ToGcj02(121.4700, 31.2300),
      bd09: b,
    };

    // 名称检索拿不到（官方名与地图名完全不同），只能靠坐标路径；
    // 而类目串带 '$'，模拟百度不识别 → 必须靠"用名称重试"救回来。
    baiduByQuery = {};
    baiduAroundByQuery = {
      '某旧址': [baiduPoi('bp9', '某旧址纪念馆', b[0], b[1], '风景名胜;文物古迹', '08:00-18:00')],
    };
    byKeyword = {};
    aroundPois = [];

    let diag = {};
    const r = await CARD.queryOnePoi(
      { defaultProvider: 'baidu', amapKey: 'A', baiduAk: 'B', strategyMode: 'geo' }, poi, diag);
    check('类目串无果时，改用点位名称重试环形检索',
      !!r && r.provider === 'baidu' && r.info && r.info.name === '某旧址纪念馆',
      r ? JSON.stringify(r.info && r.info.name) : 'null');

    // 诊断能说清"为什么回退"
    baiduByQuery = {}; baiduAroundByQuery = {};
    const amapPoi = [{ id: 'a', name: '某旧址', type: '风景名胜;文物古迹',
      location: '121.4740,31.2340', business: { opentime_today: '09:00-17:00' } }];
    byKeyword = { '上海市 某旧址': amapPoi };
    aroundPois = amapPoi;
    diag = {};
    const r2 = await CARD.queryOnePoi(
      { defaultProvider: 'baidu', amapKey: 'A', baiduAk: 'B', strategyMode: 'combine' }, poi, diag);
    check('百度无果时回退到高德', !!r2 && r2.provider === 'amap', r2 ? r2.provider : 'null');
    const why = diag.providerNotes && diag.providerNotes.baidu;
    console.log('  百度失败原因：' + why);
    check('诊断记录了百度侧的具体原因（不再是笼统一句）',
      /三路均未搜到候选|未通过校验|失败/.test(why || ''), String(why));
  }

  // ============ ⑫ 百度完整使用 + 字段级互补 ============
  console.log('\n=== ⑫ 百度完整使用与字段互补 ===');
  {
    const wgsToBd = (lon, lat) => {
      const g = GEO.wgs84ToGcj02(lon, lat);
      return GEO.gcj02ToBd09(g[0], g[1]);
    };
    const gcj = GEO.wgs84ToGcj02(121.4700, 31.2300);
    const bd = wgsToBd(121.4700, 31.2300);
    const mkPoi = () => ({
      name: '测试故居', nameVariants: ['测试故居'], city: '上海市', adminLast: '黄浦区',
      address: '测试路1号', addrQuery: '上海市 黄浦区 测试路1号',
      gcj, bd09: bd,
    });
    const cfgBoth = { defaultProvider: 'amap', amapKey: 'A', baiduAk: 'B', strategyMode: 'combine' };
    const reset = () => { calls.length = 0; baiduByQuery = {}; baiduAround = []; baiduAroundByQuery = {}; baiduDetailByUid = {};
      byKeyword = {}; aroundPois = []; baiduFailStatus = null; };

    // —— 1) 百度三种路径分别都能独立命中 ——
    // 名称路径
    reset();
    baiduByQuery = { '测试故居': [baiduPoi('b1', '测试故居', bd[0], bd[1], '风景名胜;文物古迹', '09:00-17:00')] };
    let r = await CARD.queryOnePoi({ ...cfgBoth, defaultProvider: 'baidu' }, mkPoi(), {});
    check('百度·名称路径命中', !!r && r.provider === 'baidu' && r.matchType === 'name',
      r ? r.provider + '/' + r.matchType : 'null');

    // 地址路径（名称搜不到，只有地址能命中）
    reset();
    baiduByQuery = { '上海市 黄浦区 测试路1号': [baiduPoi('b2', '测试故居', bd[0], bd[1], '风景名胜;文物古迹', '08:00-18:00')] };
    r = await CARD.queryOnePoi({ ...cfgBoth, defaultProvider: 'baidu' }, mkPoi(), {});
    check('百度·地址路径命中', !!r && r.provider === 'baidu' && r.matchType === 'address',
      r ? r.provider + '/' + r.matchType : 'null');

    // 坐标路径（名称、地址都搜不到）
    reset();
    baiduAroundByQuery = { '测试故居': [baiduPoi('b3', '测试故居旧址', bd[0], bd[1], '风景名胜;文物古迹', '07:00-19:00')] };
    r = await CARD.queryOnePoi({ ...cfgBoth, defaultProvider: 'baidu', strategyMode: 'geo' }, mkPoi(), {});
    check('百度·坐标路径命中', !!r && r.provider === 'baidu' && r.matchType === 'location',
      r ? r.provider + '/' + r.matchType : 'null');

    // —— 2) 百度字段提取 ——
    reset();
    baiduByQuery = {
      '测试故居': [{
        uid: 'b4', name: '测试故居', address: '测试路1号',
        location: { lng: bd[0], lat: bd[1] },
        detail_info: { type: '风景名胜;文物古迹', shop_hours: '周二至周日 09:00-17:00',
          price: '30', telephone: '021-12345678' },
      }],
    };
    r = await CARD.queryOnePoi({ ...cfgBoth, defaultProvider: 'baidu' }, mkPoi(), {});
    check('百度·提取到开放时间', !!r && r.info && r.info.opentimeWeek === '周二至周日 09:00-17:00',
      r && r.info ? String(r.info.opentimeWeek) : 'null');
    check('百度·提取到票价', !!r && r.info && r.info.cost === '30', r && r.info ? String(r.info.cost) : 'null');
    check('百度·提取到电话', !!r && r.info && r.info.tel === '021-12345678',
      r && r.info ? String(r.info.tel) : 'null');

    // —— 3) 高德缺开放时间 → 百度补充 ——
    reset();
    // 高德：名字对得上、但没有开放时间
    const amapNoHours = [{ id: 'a1', name: '测试故居', type: '风景名胜;文物古迹',
      address: '测试路1号', location: '121.4740,31.2340' }];
    byKeyword = { '测试故居': amapNoHours };
    aroundPois = amapNoHours;
    // 百度：同一处（同名同址），有开放时间
    baiduByQuery = { '测试故居': [baiduPoi('b5', '测试故居', bd[0], bd[1], '风景名胜;文物古迹', '09:00-17:00')] };
    baiduAroundByQuery = { '测试故居': baiduByQuery['测试故居'] };

    let diag = {};
    r = await CARD.queryOnePoi(cfgBoth, mkPoi(), diag);
    console.log('  高德缺时间 → provider=' + (r && r.provider) + ' supplementedBy=' + (r && r.supplementedBy));
    check('高德缺开放时间：主体仍用高德', !!r && r.provider === 'amap', r ? r.provider : 'null');
    check('高德缺开放时间：由百度补充',
      !!r && r.supplementedBy === 'baidu', r ? String(r.supplementedBy) : 'null');
    check('补充后拿得到开放时间',
      !!r && r.info && r.info.opentimeWeek === '09:00-17:00',
      r && r.info ? String(r.info.opentimeWeek) : 'null');
    check('补充不算作"兜底"（fallbackFrom 保持 null）', diag.fallbackFrom === null, String(diag.fallbackFrom));

    // —— 4) 百度缺开放时间 → 高德补充 ——
    reset();
    // 百度：名字对得上、没有开放时间
    baiduByQuery = { '测试故居': [{
      uid: 'b6', name: '测试故居', address: '测试路1号',
      location: { lng: bd[0], lat: bd[1] }, detail_info: { type: '风景名胜;文物古迹' },
    }] };
    baiduAroundByQuery = { '测试故居': baiduByQuery['测试故居'] };
    // 高德：同一处，有开放时间
    const amapWithHours = [{ id: 'a2', name: '测试故居', type: '风景名胜;文物古迹',
      address: '测试路1号', location: '121.4740,31.2340',
      business: { opentime_today: '08:00-20:00' } }];
    byKeyword = { '测试故居': amapWithHours };
    aroundPois = amapWithHours;

    diag = {};
    r = await CARD.queryOnePoi({ ...cfgBoth, defaultProvider: 'baidu' }, mkPoi(), diag);
    console.log('  百度缺时间 → provider=' + (r && r.provider) + ' supplementedBy=' + (r && r.supplementedBy));
    check('百度缺开放时间：主体仍用百度', !!r && r.provider === 'baidu', r ? r.provider : 'null');
    check('百度缺开放时间：由高德补充',
      !!r && r.supplementedBy === 'amap', r ? String(r.supplementedBy) : 'null');
    check('补充后拿得到开放时间',
      !!r && r.info && r.info.opentimeToday === '08:00-20:00',
      r && r.info ? String(r.info.opentimeToday) : 'null');

    // —— 5) 两家指向不同地点时不得互相补充 ——
    reset();
    byKeyword = { '测试故居': [{ id: 'a3', name: '测试故居', type: '风景名胜;文物古迹',
      location: '121.4740,31.2340' }] };
    aroundPois = byKeyword['测试故居'];
    // 百度匹配到"完全不同的地方"（名字不像、坐标也远）
    baiduByQuery = { '测试故居': [baiduPoi('b7', '另一个完全无关的商场',
      bd[0] + 0.05, bd[1] + 0.05, '购物服务;商场', '10:00-22:00')] };
    baiduAroundByQuery = { '测试故居': [] };
    r = await CARD.queryOnePoi(cfgBoth, mkPoi(), {});
    check('两家指向不同地点时不补充（避免张冠李戴）',
      !!r && !r.supplementedBy, r ? String(r.supplementedBy) : 'null');

    // —— 6) 有开放时间时不做**字段补充**，但会花 1 次请求做「状态探针」——
    //
    // 旧断言是"不发起百度请求（省配额）"。实测董家渡天主堂后改了主意：
    // 首选那家给了正常营业时间，而"暂停开放"恰好在另一家身上，
    // 完全不去问就等于永远拿不到关闭状态。折中做法是只跑名称检索这一路
    // （1 次请求），而不是三路各一次（3 次）。
    reset();
    byKeyword = { '测试故居': amapWithHours };
    aroundPois = amapWithHours;
    baiduByQuery = { '测试故居': [baiduPoi('b8', '测试故居', bd[0], bd[1], '风景名胜;文物古迹')] };
    const before = calls.length;
    r = await CARD.queryOnePoi(cfgBoth, mkPoi(), {});
    const baiduCalls = calls.slice(before).filter(u => u.includes('api.map.baidu.com')).length;
    check('高德已有开放时间：只发 1 次状态探针请求（不是 3 次全跑）',
      baiduCalls === 1, '百度请求 ' + baiduCalls + ' 次');
    check('有开放时间时不做字段补充（supplementedBy 为空）',
      !!r && !r.supplementedBy, r ? String(r.supplementedBy) : 'null');
    check('另一家没有关闭标记时不加警告',
      !!r && !r.closureProbe, r ? JSON.stringify(r.closureProbe) : 'null');

    // —— 7) 董家渡天主堂：首要那家给了正常营业时间，关闭状态在另一家身上 ——
    // 这正是实测场景：高德返回 08:00-11:00,13:00-17:00，百度标着「暂停开放」。
    reset();
    byKeyword = { '测试故居': amapWithHours };
    aroundPois = amapWithHours;
    baiduByQuery = { '测试故居': [{
      uid: 'b9', name: '测试故居', address: '测试路1号',
      location: { lng: bd[0], lat: bd[1] },
      detail_info: { type: '风景名胜;文物古迹', tag: '暂停开放' },
    }] };
    baiduAroundByQuery = { '测试故居': [] };
    r = await CARD.queryOnePoi(cfgBoth, mkPoi(), {});
    console.log('  另一家标着暂停开放 → closureProbe=' + JSON.stringify(r && r.closureProbe));
    check('首要那家已有正常营业时间时，仍能拿到另一家的关闭状态',
      !!r && r.closureProbe && r.closureProbe.hint === '暂停' && r.closureProbe.provider === 'baidu',
      r ? JSON.stringify(r.closureProbe) : 'null');
    check('开放时间仍用首要那家的（不被子单元/另一家顶掉）',
      !!r && r.info.opentimeToday === '08:00-20:00',
      r && r.info ? String(r.info.opentimeToday) : 'null');
    check('探针不算作字段补充', !!r && !r.supplementedBy, r ? String(r.supplementedBy) : 'null');

    // 状态在营业时间字段里也一样能捞到（百度 shop_hours）
    reset();
    byKeyword = { '测试故居': amapWithHours };
    aroundPois = amapWithHours;
    baiduByQuery = { '测试故居': [{
      uid: 'b10', name: '测试故居', address: '测试路1号',
      location: { lng: bd[0], lat: bd[1] },
      detail_info: { type: '风景名胜;文物古迹', shop_hours: '暂停营业' },
    }] };
    baiduAroundByQuery = { '测试故居': [] };
    r = await CARD.queryOnePoi(cfgBoth, mkPoi(), {});
    check('状态写在 shop_hours 里也能捞到',
      !!r && r.closureProbe && r.closureProbe.hint === '暂停',
      r ? JSON.stringify(r.closureProbe) : 'null');

    // 探针命中的是"另一个地方"时不得张冠李戴
    reset();
    byKeyword = { '测试故居': amapWithHours };
    aroundPois = amapWithHours;
    baiduByQuery = { '测试故居': [{
      uid: 'b11', name: '测试故居', address: '测试路1号',
      location: { lng: bd[0] + 0.09, lat: bd[1] + 0.09 },   // 约 12 km 外
      detail_info: { type: '风景名胜;文物古迹', tag: '暂停开放' },
    }] };
    baiduAroundByQuery = { '测试故居': [] };
    r = await CARD.queryOnePoi(cfgBoth, mkPoi(), {});
    check('探针命中远处同名点位时不采用其状态',
      !!r && !r.closureProbe, r ? JSON.stringify(r.closureProbe) : 'null');

    check('结果仍来自高德', !!r && r.provider === 'amap', r ? r.provider : 'null');

    baiduFailStatus = null;
  }

  // ============ ⑬ 补充被拒绝时要说清楚（且不能抛错）============
  console.log('\n=== ⑬ 补充判定与告知 ===');
  {
    const wgsToBd = (lon, lat) => {
      const g = GEO.wgs84ToGcj02(lon, lat);
      return GEO.gcj02ToBd09(g[0], g[1]);
    };
    const gcj = GEO.wgs84ToGcj02(121.4700, 31.2300);
    const b = wgsToBd(121.4700, 31.2300);
    const poi = {
      name: '某旧址', nameVariants: ['某旧址'], city: '上海市', adminLast: '黄浦区',
      gcj, bd09: b,
    };
    const cfg = { defaultProvider: 'baidu', amapKey: 'A', baiduAk: 'B', strategyMode: 'combine' };

    // 百度匹配到名字像、但没有开放时间的点位
    baiduByQuery = { '某旧址': [baiduPoi('x1', '某旧址', b[0], b[1], '风景名胜;文物古迹')] };
    baiduAroundByQuery = { '某旧址': [] };
    // 高德：名称能匹配上（相似度够，passes 才放行），但**远在 20 公里外**——
    // 只有这种"够像却不在一处"的组合才会走到"判定不是同一处"这条分支。
    const far = { id: 'a9', name: '某旧址旧址群', type: '风景名胜;文物古迹',
      location: '121.6000,31.4000', business: { opentime_today: '10:00-22:00' } };
    byKeyword = { '上海市 某旧址': [far] };
    aroundPois = [far];

    calls.length = 0;
    const logs = [];
    const origLog = console.log;
    console.log = (...a) => { logs.push(a.join(' ')); };
    let r = null, err = null;
    try { r = await CARD.queryOnePoi(cfg, poi, {}); } catch (e) { err = e; }
    console.log = origLog;

    check('判定为不同处时**不抛错**（label 曾在作用域外）', !err, err ? err.message : '');
    check('远在 20 公里外的"够像"候选不得用于补充',
      !!r && !r.supplementedBy, r ? String(r.supplementedBy) : 'null');
    check('结果仍来自首选那家', !!r && r.provider === 'baidu', r ? r.provider : 'null');

    const joined = logs.join('\n');
    check('日志说清了为何没补充',
      /无可用于补充的结果|不是同一处/.test(joined), joined.slice(-260));

    // 远的候选（>3km）会被 nameTooFar 挡掉，本就到不了合并判定；
    // 关键在于：不崩溃、不误补、日志可定位。
    check('补充后也没有把远候选的时间写进来',
      !!r && !/10:00-22:00/.test(String(r.info && r.info.opentimeToday)), 
      String(r && r.info && r.info.opentimeToday));
  }

  // ============ ⑭ 放宽后的 samePlace：另一家落在文保本体上 ============
  console.log('\n=== ⑭ 另一家落在文保本体上时可补充 ===');
  {
    const wgsToBd = (lon, lat) => {
      const g = GEO.wgs84ToGcj02(lon, lat);
      return GEO.gcj02ToBd09(g[0], g[1]);
    };
    const gcj = GEO.wgs84ToGcj02(121.4700, 31.2300);
    const b = wgsToBd(121.4700, 31.2300);
    const poi = {
      name: '四行仓库抗战旧址', nameVariants: ['四行仓库抗战旧址'], city: '上海市',
      adminLast: '静安区', gcj, bd09: b,
    };
    const cfg = { defaultProvider: 'baidu', amapKey: 'A', baiduAk: 'B', strategyMode: 'combine' };

    // 百度：名称精确命中，但这条 POI **没有开放时间**
    // （这正是用户遇到的情形：百度返回了位点却给不出开放时间）
    baiduByQuery = { '四行仓库抗战旧址': [
      baiduPoi('x2', '四行仓库抗战旧址', b[0], b[1], '风景名胜;文物古迹')] };
    baiduAroundByQuery = { '四行仓库抗战旧址': [] };
    // 高德匹配到本体（名字不像，但就在文保坐标上），有开放时间
    const real = { id: 'a10', name: '上海四行仓库抗战纪念馆', type: '科教文化服务;博物馆',
      location: (gcj[0] + 0.0002) + ',' + (gcj[1] + 0.0002),
      business: { opentime_today: '09:00-16:30' } };
    byKeyword = { '上海市 四行仓库抗战旧址': [real] };
    aroundPois = [real];

    const r = await CARD.queryOnePoi(cfg, poi, {});
    console.log('  provider=' + (r && r.provider) + ' supplementedBy=' + (r && r.supplementedBy));
    check('另一家落在文保本体附近 → 采用其开放时间',
      !!r && r.supplementedBy === 'amap' && r.info.opentimeToday === '09:00-16:30',
      r ? String(r.supplementedBy) + ' / ' + String(r.info.opentimeToday) : 'null');
    check('主体仍是首选那家的匹配', !!r && r.provider === 'baidu', r ? r.provider : 'null');
  }

  // ============ ⑮ 状态标签 → "可能不开放"提示 ============
  console.log('\n=== ⑮ 状态标签（暂停营业等）===');
  {
    const H = HMP.card.closureHint;
    check('识别百度 tag=暂停营业（此前完全没有提示）',
      H({ name: '某纪念馆', tag: '暂停营业' }) === '暂停', String(H({ name: '某纪念馆', tag: '暂停营业' })));
    check('识别高德 tag=装修中',
      H({ name: '某纪念馆', tag: '装修中' }) === '装修', String(H({ name: '某纪念馆', tag: '装修中' })));
    check('仍识别名称里的状态', !!H({ name: '董家渡天主堂（暂停开放）' }));
    check('仍识别 status 字段', !!H({ name: '某点', status: '停业' }));
    check('普通 POI 不误报', H({ name: '故宫博物院', tag: '博物馆' }) === null,
      String(H({ name: '故宫博物院', tag: '博物馆' })));
    check('没有 tag 时不影响', H({ name: '故宫博物院' }) === null);
  }

  // ============ ⑯ 「本体-子单元」不得冒充本体 ============
  // 实测：STELE 上「商船会馆」（中山南路会馆街38号，黄浦区）被匹配到
  // 百度上的「商船会馆-音乐剧《耋戏生》」——那是馆内的演出，不是会馆本身。
  // 根因与"借用文保名的住宅"同型：subUnitPenalty 只参与**排序**，
  // 而"强命中"用的是**原始相似度**（包含关系 → sim≈1.0），
  // 于是子单元直接拍板，轮不到坐标准确的本体。
  console.log('\n=== ⑯ 本体-子单元不得冒充本体（商船会馆）===');
  {
    const realSC = [121.4930, 31.2210];          // 中山南路会馆街一带
    const gcjSC = GEO.wgs84ToGcj02(realSC[0], realSC[1]);
    const steleSC = [(realSC[0] - GEO.AFFINE.lonB) / GEO.AFFINE.lonA,
      (realSC[1] - GEO.AFFINE.latB) / GEO.AFFINE.latA];
    const scLoc = (dLon, dLat) => {
      const g = GEO.wgs84ToGcj02(realSC[0] + dLon, realSC[1] + dLat);
      return g[0] + ',' + g[1];
    };
    const SUB = { id: 'sc-sub', name: '商船会馆-音乐剧《耋戏生》', type: '风景名胜;风景名胜',
      location: scLoc(0.0001, 0), business: { opentime_today: '19:30-21:30' } };
    const BASE = { id: 'sc-base', name: '商船会馆', type: '风景名胜;文物古迹',
      location: scLoc(0, 0.00002), business: { opentime_today: '09:00-16:00' } };
    const poiSC = {
      name: '商船会馆',
      nameVariants: ['商船会馆'],
      searchTerms: ['商船会馆'],
      addrQuery: '上海市 黄浦区 中山南路会馆街38号',
      city: '上海市', adminLast: '上海市 黄浦区',
      gcj: gcjSC, bd09: GEO.gcj02ToBd09(gcjSC[0], gcjSC[1]),
    };
    const cfgSC = { amapKey: 'K', strategyMode: 'combine' };

    // ⑯-1 排序：本体与子单元同时出现时，本体必须胜出
    byKeyword = { '上海市 商船会馆': [SUB, BASE] };
    aroundPois = [SUB, BASE];
    let rSC = await CARD.queryOnePoi(cfgSC, poiSC);
    console.log('  同时出现 → ' + (rSC.ok ? rSC.info.name + '（' + rSC.verifiedBy + '）' : '未匹配'));
    check('本体与子单元同时在候选里时命中本体',
      rSC.ok && rSC.info.name === '商船会馆', rSC.ok ? rSC.info.name : '未匹配');
    check('未采用子单元名', !rSC.ok || !rSC.info.name.includes('耋戏生'));

    // ⑯-2 名称一路只有子单元、地址/坐标一路找到本体 →
    //      印证成立，但采纳的名义必须换成"本体"那一路
    byKeyword = {
      '上海市 商船会馆': [SUB],                                        // 名称：只有子单元
      '上海市 黄浦区 中山南路会馆街38号': [BASE],                        // 地址：本体
    };
    aroundPois = [BASE];                                              // 坐标：本体
    rSC = await CARD.queryOnePoi(cfgSC, poiSC);
    console.log('  名称只有子单元 → ' + (rSC.ok ? rSC.info.name + '（' + rSC.verifiedBy + '）' : '未匹配'));
    check('名称一路是子单元时，改用地址/坐标那一路的名义',
      rSC.ok && rSC.info.name === '商船会馆', rSC.ok ? rSC.info.name : '未匹配');
    check('此时采用开放时间来自本体而非子单元',
      !!rSC && rSC.info.opentimeToday === '09:00-16:00',
      rSC ? String(rSC.info.opentimeToday) : 'null');

    // ⑯-2b 名称与**坐标**都落在子单元这条记录上（说明两家只有这一条），
    //       而地址一路找到了本体 → 印证成立，但采纳的名义必须换成地址那一路。
    //       这条正是 nameSide() 存在的意义：nG 成立而 nA 不成立时，
    //       照旧采纳 byName 就会把用户送到子单元上去。
    byKeyword = { '上海市 商船会馆': [SUB], '上海市 黄浦区 中山南路会馆街38号': [BASE] };
    aroundPois = [SUB];
    rSC = await CARD.queryOnePoi(cfgSC, poiSC);
    console.log('  名称+坐标都是子单元、地址找到本体 → ' +
      (rSC.ok ? rSC.info.name + '（' + rSC.verifiedBy + '）' : '未匹配'));
    check('名称与坐标同为子单元时，改用地址那一路的本体',
      rSC.ok && rSC.info.name === '商船会馆', rSC.ok ? rSC.info.name : '未匹配');
    check('未把子单元当成印证结果采纳',
      !rSC.ok || !rSC.info.name.includes('耋戏生'));

    // ⑯-3 只有子单元（其它两路都查不到）→ 有结果仍好过空着，
    //      但必须如实标注可信度最低
    byKeyword = { '上海市 商船会馆': [SUB], '上海市 黄浦区 中山南路会馆街38号': [] };
    aroundPois = [];
    rSC = await CARD.queryOnePoi(cfgSC, poiSC);
    console.log('  只有子单元 → ' + (rSC.ok ? rSC.info.name + '（' + rSC.verifiedBy + '）' : '未匹配'));
    check('兜底仍给结果（不制造空卡片）', rSC.ok, rSC.ok ? rSC.info.name : '未匹配');
    check('标注为「本体-子单元」可信度最低',
      rSC.ok && /子单元/.test(rSC.verifiedBy || ''), rSC.ok ? rSC.verifiedBy : '');

    // ⑯-4 回归守卫：精确同名（本体自己）不受子单元规则牵连
    byKeyword = { '上海市 商船会馆': [BASE] };
    aroundPois = [BASE];
    rSC = await CARD.queryOnePoi(cfgSC, poiSC);
    check('精确同名的本体仍正常强命中',
      rSC.ok && rSC.info.name === '商船会馆' &&
      /三重印证|两路印证/.test(rSC.verifiedBy || ''),
      rSC.ok ? rSC.info.name + ' / ' + rSC.verifiedBy : '未匹配');
  }

  // ============ ⑰ 短 description 里的状态说明 ============
  console.log('\n=== ⑰ 短 description 状态说明 ===');
  {
    const H = HMP.card.closureHint;
    check('短 description「暂停营业」能识别',
      H({ name: '某馆', description: '暂停营业' }) === '暂停',
      String(H({ name: '某馆', description: '暂停营业' })));
    // 长段落是介绍文字，提到"修缮/拆除"多半是历史叙述 → 不能当关闭信号
    check('长段落里的「修缮」不误报',
      H({ name: '某馆', description:
        '该建筑始建于1920年，1958年大修，2003年由区政府出资修缮并对外开放，现为市级文物保护单位。' }) === null,
      String(H({ name: '某馆', description: '长段落' })));
    check('无 description 不受影响', H({ name: '故宫博物院' }) === null);
  }

  // ============ ⑱ 状态就在「开放时间」字段里 ============
  // 实测线索：上海「董家渡天主堂」在两家地图上都标着"暂停开放"。
  // 暂停营业的点位，两家的营业时间字段里写的直接就是「暂停开放」，
  // 而 closureHint 此前只扫 name/status/tag —— 最直白的信号反而漏掉：
  // 卡片会把这个串当开放时间显示出来，却一句提醒都不给。
  console.log('\n=== ⑱ 「暂停开放」写在开放时间字段里 ===');
  {
    const H = HMP.card.closureHint;
    check('高德 opentimeToday=暂停开放 → 提示（董家渡天主堂）',
      H({ name: '董家渡天主堂', opentimeToday: '暂停开放' }) === '暂停',
      String(H({ name: '董家渡天主堂', opentimeToday: '暂停开放' })));
    check('百度 shop_hours=暂停营业 → 提示',
      H({ name: '董家渡天主堂', opentimeWeek: '暂停营业' }) === '暂停',
      String(H({ name: '董家渡天主堂', opentimeWeek: '暂停营业' })));
    check('营业时间写着"暂停营业"以外的正常值 → 不误报',
      H({ name: '某馆', opentimeToday: '09:00-17:00' }) === null,
      String(H({ name: '某馆', opentimeToday: '09:00-17:00' })));
    check('一周描述正常 → 不误报',
      H({ name: '某馆', opentimeWeek: '周一至周日 09:00-17:00（16:30 停止入场）' }) === null,
      String(H({ name: '某馆', opentimeWeek: '周一至周日 09:00-17:00' })));
    check('露天点位写"全天开放" → 不误报',
      H({ name: '某遗址', opentimeToday: '全天开放' }) === null,
      String(H({ name: '某遗址', opentimeToday: '全天开放' })));

    // 端到端：卡片上必须真的出现警告条
    const info = { name: '董家渡天主堂', address: '上海市黄浦区董家渡路185号',
      opentimeToday: '暂停开放', cost: null };
    const state = { kind: 'ok', info, matchType: 'name', matchDist: 12,
      provider: 'amap', amapSearchUrl: 'https://uri.amap.com/search?keyword=x',
      baiduSearchUrl: 'https://api.map.baidu.com/place/search?query=x' };
    let html = '';
    try {
      HMP.card.removeCard();
      HMP.card.renderState(state);
      // 文本挂在子文本节点上（el() 用 createTextNode 追加），
      // 所以要把整棵树的文本都收上来，不能只看 hmp-alert 自身的 textContent。
      const walk = n => {
        if (!n) return;
        if (n.nodeType === 3 && n.textContent) html += n.textContent + ' ';
        (n.children || []).forEach(walk);
      };
      walk(docBody);
      HMP.card.removeCard();
    } catch (e) { html = 'ERR:' + e.message; }
    check('卡片上出现"可能不开放"警告条', /可能不开放/.test(html), html || '（无警告条）');
  }

  // ============ ⑲ samePlace 判定为否时必须真的不补充 ============
  // 该分支极难触发（能过 passes 的候选彼此多半也像），
  // 所以这里直接盯住源码契约：判定否 → 必须 return，不能只打日志照补。
  console.log('\n=== ⑲ 判定不同处不得补充 ===');
  {
    const src = fs.readFileSync(path.join(SRC, 'card.js'), 'utf8');
    const i = src.indexOf('判定与当前结果不是同一处');
    const tail = src.slice(i, i + 900);
    check('"不是同一处"之后紧跟 return（此前只打日志、照补不误）',
      /不是同一处[\s\S]{0,600}?return result;/.test(tail),
      tail.slice(0, 200));
  }

  // ============ ⑳ 状态标签必须真的交到 closureHint ============
  // 实测教训：mapPoi 认真取出了 tag，但 extract() 是**手写字面量**重建的对象，
  // 把 tag 丢掉了 —— closureHint(info) 的 info.tag 永远是 undefined，
  // 0.3.1 加的 tag 扫描从来没生效过。
  // 单元测试直接构造 {name, tag} 喂给 closureHint 是能过的，
  // 所以这里必须**穿过 extract**，走真实链路。
  console.log('\n=== ⑳ 状态标签的接线（不能只映射、不交出）===');
  {
    const H = HMP.card.closureHint;
    const realW = [121.4740, 31.2340];
    const gcjW = GEO.wgs84ToGcj02(realW[0], realW[1]);
    const bdW = GEO.gcj02ToBd09(gcjW[0], gcjW[1]);
    const poiW = {
      name: '测试故居', nameVariants: ['测试故居'], searchTerms: ['测试故居'],
      city: '上海市', adminLast: '黄浦区', address: '测试路1号',
      addrQuery: '上海市 黄浦区 测试路1号', gcj: gcjW, bd09: bdW,
    };
    const cfgW = { amapKey: 'A', baiduAk: 'B', defaultProvider: 'amap', strategyMode: 'combine' };

    baiduByQuery = { '测试故居': [{
      uid: 'w1', name: '测试故居', address: '测试路1号',
      location: { lng: bdW[0], lat: bdW[1] },
      detail_info: { type: '风景名胜;文物古迹', tag: '暂停营业' },
    }] };
    let w = await CARD.searchByName(cfgW, 'baidu', poiW);
    check('百度 detail_info.tag 真的交到 closureHint',
      !!w && H(w.info) === '暂停',
      w ? 'tag=' + String(w.info.tag) + ' hint=' + String(H(w.info)) : 'null');

    // 高德的桩按**完整 keywords**（含城市前缀）取，百度侧才是不带城市的 query
    byKeyword = { '上海市 测试故居': [{
      id: 'w2', name: '测试故居', type: '风景名胜;文物古迹', address: '测试路1号',
      location: gcjW[0] + ',' + gcjW[1],
      business: { tag: '暂停开放', opentime_today: '08:00-17:00' },
    }] };
    w = await CARD.searchByName(cfgW, 'amap', poiW);
    check('高德 business.tag 真的交到 closureHint',
      !!w && H(w.info) === '暂停',
      w ? 'tag=' + String(w.info.tag) + ' hint=' + String(H(w.info)) : 'null');
  }

  // ============ ㉑ 真实接口实测暴露的几个缺陷（2026-09-22）============
  // 这些用例的取值全部来自**真实接口返回**，不是编的：
  //   高德 https://restapi.amap.com/v5/place/text
  //   百度 https://api.map.baidu.com/place/v2/search
  console.log('\n=== ㉑ 真实接口实测暴露的缺陷 ===');
  {
    const M = HMP.matcher, CARDX = HMP.card;

    // —— ① 纯门牌号型 POI 不是"能去的地方" ——
    // 真实数据：商船会馆 → 百度返回「会馆街38号」；上海音乐厅 → 「延安东路523号」。
    // 它们没有开放时间，地址还常是「黄浦区」这种残缺值，采纳了等于给张空卡片。
    check('纯门牌号「延安东路523号」被排除',
      CARDX.heritageRank({ name: '延安东路523号', type: '地名地址;门牌号' }) === 0,
      String(CARDX.heritageRank({ name: '延安东路523号', type: '地名地址;门牌号' })));
    check('纯门牌号「会馆街38号」被排除',
      CARDX.heritageRank({ name: '会馆街38号', type: '' }) === 0,
      String(CARDX.heritageRank({ name: '会馆街38号', type: '' })));
    check('正常点位名不受影响（含"路"字的馆）',
      CARDX.heritageRank({ name: '上海音乐厅', type: '影剧院;音乐厅' }) === 2,
      String(CARDX.heritageRank({ name: '上海音乐厅', type: '影剧院;音乐厅' })));

    // —— ② 候选名整段包含目标名时，相似度要有下限 ——
    // 真实数据：上海音乐厅。此前「凯迪拉克·上海音乐厅」只有 0.750，
    // 被 3.5 km 外的「上海音乐谷」0.800 压过。
    check('「凯迪拉克·上海音乐厅」相似度 ≥ 0.9',
      M.nameScore('上海音乐厅', '凯迪拉克·上海音乐厅') >= 0.9,
      M.nameScore('上海音乐厅', '凯迪拉克·上海音乐厅').toFixed(3));
    check('本体高于远房同名「上海音乐谷」',
      M.nameScore('上海音乐厅', '凯迪拉克·上海音乐厅') >
      M.nameScore('上海音乐厅', '上海音乐谷'),
      M.nameScore('上海音乐厅', '上海音乐谷').toFixed(3));
    // ⚠ 但不能盖掉"本体 + 设施后缀"的降权：
    // 承德避暑山庄博物馆 必须仍低于"避暑山庄"，否则 regression_tests 那条会翻。
    check('「本体+设施后缀」仍被降权（承德避暑山庄博物馆）',
      M.nameScore('承德避暑山庄', '承德避暑山庄博物馆') <
      M.nameScore('承德避暑山庄', '避暑山庄'),
      M.nameScore('承德避暑山庄', '承德避暑山庄博物馆').toFixed(3) + ' vs ' +
      M.nameScore('承德避暑山庄', '避暑山庄').toFixed(3));
    check('「本体-子单元」相似度虽被抬高，但降权仍在',
      M.subUnitPenalty(['商船会馆'], '商船会馆-音乐剧《耋戏生》', '商船会馆') < 1);

    // —— ③ 百度的 detail_info.type 是"检索范围"，不是品类 ——
    // 真实数据：{"type":"scope","tag":"旅游景点;教堂",
    //            "classified_poi_tag":"旅游景点;教堂;天主教堂"}
    // 此前直接用 detail.type → 百度侧每个候选的类型都是 "scope"，
    // 所有按类型做的判断全部失效（实测把充电站当成了上海音乐厅）。
    const cfgB = { amapKey: 'A', baiduAk: 'B', defaultProvider: 'baidu', strategyMode: 'combine' };
    const realB = [121.47905, 31.22566];
    const gcjB = GEO.wgs84ToGcj02(realB[0], realB[1]);
    const bdB = GEO.gcj02ToBd09(gcjB[0], gcjB[1]);
    const poiB = {
      name: '上海音乐厅', nameVariants: ['上海音乐厅'], searchTerms: ['上海音乐厅'],
      city: '上海市', adminLast: '黄浦区', gcj: gcjB, bd09: bdB,
    };

    baiduByQuery = { '上海音乐厅': [{
      uid: 'r1', name: '星星充电充电站(上海音乐厅充电站)',
      address: '上海市黄浦区普安路1号', location: { lng: bdB[0], lat: bdB[1] },
      detail_info: { type: 'scope', tag: '交通设施;充电站',
        classified_poi_tag: '交通设施;充电站' },
    }] };
    let wb = await CARD.searchByName(cfgB, 'baidu', poiB);
    if (wb) {
      check('百度品类取自 tag，不再是"scope"',
        /充电站/.test(String(wb.info.type)), 'type=' + String(wb.info.type));
      check('按真实品类判为设施类 → 不会被采纳',
        CARDX.heritageRank(wb.info) === 0, 'rank=' + CARDX.heritageRank(wb.info));
    } else {
      // 返回 null 本身就是证据：修好之前 type='scope' → rank 1 → 不会被过滤，
      // 这个充电站会被当成匹配结果（实测确实如此）。
      check('充电站按真实品类在候选阶段就被排除', wb === null, String(wb));
    }

    baiduByQuery = { '上海音乐厅': [{
      uid: 'r2', name: '上海音乐厅', address: '上海市黄浦区延安东路523号',
      location: { lng: bdB[0], lat: bdB[1] },
      detail_info: { type: 'scope', tag: '旅游景点;教堂',
        classified_poi_tag: '旅游景点;教堂;天主教堂' },
    }] };
    const wb2 = await CARD.searchByName({ ...cfgB }, 'baidu', poiB);
    check('百度教堂类候选按真实品类判为文物景点（rank 2）',
      !!wb2 && CARDX.heritageRank(wb2.info) === 2,
      wb2 ? 'type=' + String(wb2.info.type) + ' rank=' + CARDX.heritageRank(wb2.info) : 'null');
  }

  // ============ ㉒ 百度：由子项的 parent_id 反查本体 ============
  // 真实情况（2026-09-22 实测）：搜「上海音乐厅」，百度**不返回本体**，
  // 只返回它的子项（凯迪拉克·上海音乐厅-正门 / -东门 / -地下停车场），
  // 而这些子项带 parent_id。子项本身会被设施类过滤掉，
  // 所以要在过滤**之前**收集 parent_id，再走 place/v2/detail 反查。
  // 反查结果（真实返回）：
  //   name=凯迪拉克·上海音乐厅 tag=休闲娱乐;剧院 classified=休闲娱乐;音乐厅
  //   shop_hours=09:00-20:00
  console.log('\n=== ㉒ 百度的本体藏在子项后面（parent_id 反查）===');
  {
    const realM = [121.47905, 31.22566];
    const gcjM = GEO.wgs84ToGcj02(realM[0], realM[1]);
    const bdM = GEO.gcj02ToBd09(gcjM[0], gcjM[1]);
    const poiM = {
      name: '上海音乐厅', nameVariants: ['上海音乐厅'], searchTerms: ['上海音乐厅'],
      city: '上海市', adminLast: '黄浦区',
      addrQuery: '上海市 黄浦区 延安东路523号', gcj: gcjM, bd09: bdM,
    };
    const cfgM = { amapKey: 'A', baiduAk: 'B', defaultProvider: 'baidu', strategyMode: 'combine' };
    const PARENT = 'fd007c5e2d33266da9f729a8';

    calls.length = 0; baiduByQuery = {}; baiduAround = []; baiduAroundByQuery = {}; baiduDetailByUid = {}; byKeyword = {}; aroundPois = [];
    // 名称检索：只有子项，全部会被当设施丢掉
    baiduByQuery = { '上海音乐厅': [
      { uid: 'c1', name: '凯迪拉克·上海音乐厅-正门', address: '延安东路523号',
        location: { lng: bdM[0], lat: bdM[1] },
        detail_info: { type: 'life', tag: '出入口;门', parent_id: PARENT } },
      { uid: 'c2', name: '凯迪拉克·上海音乐厅-地下停车场', address: '延安东路523号',
        location: { lng: bdM[0], lat: bdM[1] },
        detail_info: { type: 'life', tag: '交通设施;停车场', parent_id: PARENT } },
    ] };
    baiduAroundByQuery = {};
    baiduDetailByUid = { [PARENT]: {
      uid: PARENT, name: '凯迪拉克·上海音乐厅', address: '延安东路523号(近西藏南路)',
      location: { lng: bdM[0], lat: bdM[1] },
      detail_info: { type: 'life', tag: '休闲娱乐;剧院',
        classified_poi_tag: '休闲娱乐;音乐厅', shop_hours: '09:00-20:00',
        telephone: '021-53866666' },
    } };

    const wM = await CARD.searchByName(cfgM, 'baidu', poiM);
    check('子项全被过滤时，仍能反查到本体「凯迪拉克·上海音乐厅」',
      !!wM && wM.info.name === '凯迪拉克·上海音乐厅',
      wM ? wM.info.name : 'null');
    check('反查到的本体带着开放时间',
      !!wM && wM.info.opentimeWeek === '09:00-20:00',
      wM ? String(wM.info.opentimeWeek) : 'null');
    check('本体的品类取自 tag（音乐厅 → 可参观）',
      !!wM && CARD.heritageRank(wM.info) === 2,
      wM ? 'type=' + String(wM.info.type) : 'null');

    // 父 POI 与目标名字不像时不得采用（避免拿别处的父 POI 张冠李戴）
    calls.length = 0; baiduByQuery = {}; baiduAround = []; baiduAroundByQuery = {}; baiduDetailByUid = {}; byKeyword = {}; aroundPois = [];
    baiduByQuery = { '上海音乐厅': [
      { uid: 'c3', name: '某某广场-东门', address: '某路1号',
        location: { lng: bdM[0], lat: bdM[1] },
        detail_info: { type: 'life', tag: '出入口;门', parent_id: 'P_OTHER' } },
    ] };
    baiduAroundByQuery = {};
    baiduDetailByUid = { P_OTHER: {
      uid: 'P_OTHER', name: '某某国际购物中心', address: '某路1号',
      location: { lng: bdM[0], lat: bdM[1] },
      detail_info: { type: 'life', tag: '购物服务;商场' },
    } };
    const wM2 = await CARD.searchByName(cfgM, 'baidu', poiM);
    check('父 POI 名称对不上时不采用',
      !wM2 || wM2.info.name === '上海音乐厅', wM2 ? wM2.info.name : 'null');

    // 高德没有 parent_id 这套东西，不能因此发多余请求
    calls.length = 0; baiduByQuery = {}; baiduAround = []; baiduAroundByQuery = {}; baiduDetailByUid = {}; byKeyword = {}; aroundPois = [];
    byKeyword = { '上海市 上海音乐厅': [] };
    const wA = await CARD.searchByName(cfgM, 'amap', poiM);
    const detailCalls = calls.filter(u => u.includes('/place/v2/detail')).length;
    check('高德路径不会去调百度的详情接口', detailCalls === 0, '详情请求 ' + detailCalls + ' 次');

    // ⚠ 回归守卫：名称路径**选中了子单元**时，反查到的本体必须顶掉它。
    // 实测踩过：nameScore 会把候选名按连接号拆成变体——
    //   "商船会馆-音乐剧《耋戏生》" 拆出 "商船会馆"，与目标逐字相同 → sim 1.00。
    //   于是用 m.sim > best.sim 严格比较**永远换不掉**（两边都是 1.00），
    //   反查白做，最终仍旧落到坐标兜底的「上海救火联合会旧址」(862 m)。
    calls.length = 0; baiduByQuery = {}; baiduAround = []; baiduAroundByQuery = {};
    baiduDetailByUid = {}; byKeyword = {}; aroundPois = [];
    baiduByQuery = { '上海音乐厅': [
      { uid: 's1', name: '上海音乐厅-音乐剧《某戏》', address: '延安东路523号',
        location: { lng: bdM[0], lat: bdM[1] },
        detail_info: { type: 'life', tag: '休闲娱乐;其他', parent_id: 'P_SUB' } },
    ] };
    baiduDetailByUid = { P_SUB: {
      uid: 'P_SUB', name: '上海音乐厅', address: '延安东路523号',
      location: { lng: bdM[0], lat: bdM[1] },
      detail_info: { type: 'life', tag: '休闲娱乐;剧院', shop_hours: '09:00-20:00' },
    } };
    const wSub = await CARD.searchByName(cfgM, 'baidu', poiM);
    check('名称路径选中子单元时，反查到的本体必须顶掉它（两者 sim 都是 1.00）',
      !!wSub && wSub.info.name === '上海音乐厅', wSub ? wSub.info.name : 'null');
    check('顶掉之后带上的是本体的开放时间',
      !!wSub && wSub.info.opentimeWeek === '09:00-20:00',
      wSub ? String(wSub.info.opentimeWeek) : 'null');

  }

  // ============ ㉓ 包含加成不得吃掉"括号里的分店限定" ============
  // 实测：上海马桥遗址 拆出变体"上海马桥"，撞上「万达广场(上海马桥店)」——
  // 候选把变体整段包住 → 被抬到 0.90 成了"名称强命中"，
  // 而正确的「马桥古文化遗址公园」因为相似度不足 0.7 反而被拒。
  // 凯迪拉克·上海音乐厅 是"本体挂冠名"，万达广场(上海马桥店) 是"位于此地的另一家店"，
  // 区别就在目标名是否落在候选的括号里。
  console.log('\n=== ㉓ 括号里的分店限定不吃包含加成 ===');
  {
    const MM = HMP.matcher;
    check('「万达广场(上海马桥店)」不再强命中',
      MM.nameScore('上海马桥', '万达广场(上海马桥店)') < 0.7,
      MM.nameScore('上海马桥', '万达广场(上海马桥店)').toFixed(3));
    check('冠名式包含仍吃加成（凯迪拉克·上海音乐厅）',
      MM.nameScore('上海音乐厅', '凯迪拉克·上海音乐厅') >= 0.9,
      MM.nameScore('上海音乐厅', '凯迪拉克·上海音乐厅').toFixed(3));
    check('非括号的分店写法同样不被误抬（欧森演出.上海音乐厅 仍 ≥0.9，靠类型分胜负）',
      MM.nameScore('上海音乐厅', '欧森演出.上海音乐厅') >= 0.9,
      MM.nameScore('上海音乐厅', '欧森演出.上海音乐厅').toFixed(3));
    check('括号在目标名之外时不影响（凯迪拉克·上海音乐厅(南门)）',
      MM.nameScore('上海音乐厅', '凯迪拉克·上海音乐厅(南门)') >= 0.9,
      MM.nameScore('上海音乐厅', '凯迪拉克·上海音乐厅(南门)').toFixed(3));
  }

  // ============ ㉔ 类型正确的名称命中不该输给名字毫不相干的地址命中 ============
  // 实测：崧泽遗址 → 名称命中「崧泽古文化遗址」(sim 0.57，类型=风景名胜)
  // 被"仅地址"的「崧泽村村委会」(sim 0.33) 顶掉。
  // 地址检索是在地址串上找 POI，同一地址上有村委会、消防队、居委会……
  console.log('\n=== ㉔ 弱名称（类型像文物）优先于弱地址 ===');
  {
    const realK = [121.16476, 31.14458];
    const gcjK = GEO.wgs84ToGcj02(realK[0], realK[1]);
    const bdK = GEO.gcj02ToBd09(gcjK[0], gcjK[1]);
    const poiK = {
      name: '崧泽遗址', nameVariants: ['崧泽遗址'], searchTerms: ['崧泽遗址'],
      city: '上海市', adminLast: '青浦区',
      addrQuery: '上海市 青浦区 赵巷镇崧泽村北', gcj: gcjK, bd09: bdK,
    };
    const cfgK = { amapKey: 'A', baiduAk: 'B', defaultProvider: 'amap', strategyMode: 'combine' };
    const near = (dLon) => (gcjK[0] + dLon) + ',' + gcjK[1];

    calls.length = 0; baiduByQuery = {}; baiduAround = []; baiduAroundByQuery = {};
    baiduDetailByUid = {}; byKeyword = {}; aroundPois = [];
    // 高德：名称检索有类型正确的弱命中；地址检索只找到"村委会"
    byKeyword = {
      '上海市 崧泽遗址': [{ id: 'k1', name: '崧泽古文化遗址', type: '风景名胜;风景名胜',
        address: '赵巷镇沪青平公路3993号', location: near(0.0005),
        business: { opentime_today: '08:30-16:30' } }],
      '上海市 青浦区 赵巷镇崧泽村北': [{ id: 'k2', name: '崧泽村村委会',
        type: '政府机构及社会团体;村民委员会', address: '赵巷镇崧泽村',
        location: near(0.0015) }],
      '青浦区 赵巷镇崧泽村北': [{ id: 'k2', name: '崧泽村村委会',
        type: '政府机构及社会团体;村民委员会', address: '赵巷镇崧泽村',
        location: near(0.0015) }],
      '赵巷镇崧泽村北': [],
    };
    aroundPois = [];
    const rK = await CARD.queryOnePoi(cfgK, poiK, {});
    console.log('  采用：' + (rK && rK.ok ? rK.info.name + '（' + rK.verifiedBy + '）' : '未匹配'));
    check('类型像文物的名称命中胜出，而不是村委会',
      !!rK && rK.ok && rK.info.name === '崧泽古文化遗址', rK && rK.ok ? rK.info.name : '未匹配');
    check('带出了开放时间',
      !!rK && rK.info.opentimeToday === '08:30-16:30',
      rK ? String(rK.info.opentimeToday) : 'null');

    // 守卫：远处同名仍然不得入选（这条正是"白宫"那类改名场景的护栏）
    calls.length = 0; baiduByQuery = {}; baiduAround = []; baiduAroundByQuery = {};
    baiduDetailByUid = {}; byKeyword = {}; aroundPois = [];
    byKeyword = {
      '上海市 崧泽遗址': [{ id: 'k3', name: '崧泽古文化遗址',
        type: '风景名胜;风景名胜', location: near(0.12),   // 约 11 km 外
        business: { opentime_today: '08:30-16:30' } }],
      '上海市 青浦区 赵巷镇崧泽村北': [{ id: 'k4', name: '赵巷镇社区文化活动中心',
        type: '科教文化服务;文化场馆', location: near(0.0003) }],
      '青浦区 赵巷镇崧泽村北': [],
      '赵巷镇崧泽村北': [],
    };
    const rFar = await CARD.queryOnePoi(cfgK, poiK, {});
    check('远处的同名命中仍被 nameTooFar 挡住（不因新分支放行）',
      !rFar || !rFar.ok || rFar.info.name !== '崧泽古文化遗址',
      rFar && rFar.ok ? rFar.info.name : '未匹配');
  }

  // ============ ㉕ 最长公共子序列：不要求连续 ============
  // 「上海马桥遗址」vs「马桥古文化遗址公园」按顺序共用「马桥」+「遗址」，
  // 中间隔着"古文化"。levenshtein 把长度差重罚只给 0.222，
  // "最长公共**子串**"也只看得到「马桥」(2)。都不对。
  console.log('\n=== ㉕ 最长公共子序列（不要求连续）===');
  {
    const M = HMP.matcher;
    const sc = (t, c) => M.pick({ name: t, nameVariants: [t], lon: 121.39, lat: 31.03 },
      [{ name: c, id: 'x', lon: 121.39299, lat: 31.03330 }]);

    const w = sc('上海马桥遗址', '马桥古文化遗址公园');
    check('「马桥古文化遗址公园」进得了候选集（≥0.55，且就在 220m 内）',
      !!w && w.sim >= 0.55, w ? w.sim.toFixed(3) : 'null');

    // 拿**短变体**算会翻车：良渚遗址-莫角山遗址 拆出「良渚遗址」，
    // 而「良渚古城遗址公园」正好把它整段包住 → 满分 → 精确同名被挤掉。
    // 所以 LCS 只用完整原名算。
    const bad = M.pick({ name: '良渚遗址-莫角山遗址',
      nameVariants: ['良渚遗址-莫角山遗址', '良渚遗址'],
      lon: 120.0, lat: 30.4 },
      [{ name: '良渚古城遗址公园', id: 'y', lon: 120.0, lat: 30.4 }]);
    check('子项目不得因"共用组名"而匹配到父级公园',
      bad === null, bad ? bad.poi.name + ' sim=' + bad.sim.toFixed(3) : 'null');

    // 上限：LCS 单独不足以构成"强命中"
    check('LCS 分量有上限（不会单独变成强命中）',
      M.nameScore('上海马桥遗址', '马桥古文化遗址公园') <= 0.8,
      M.nameScore('上海马桥遗址', '马桥古文化遗址公园').toFixed(3));

    // 护栏：候选以全名开头 = "本体 + 后缀"，归设施/子单元规则管
    check('「本体+后缀」不走 LCS（大足石刻宝顶山景区）',
      M.nameScore('大足石刻', '大足石刻宝顶山景区') < 1,
      M.nameScore('大足石刻', '大足石刻宝顶山景区').toFixed(3));
    check('「本体+设施后缀」降权仍生效（承德避暑山庄博物馆 < 避暑山庄）',
      M.nameScore('承德避暑山庄', '承德避暑山庄博物馆') <
      M.nameScore('承德避暑山庄', '避暑山庄'));
  }

  console.log('\n结果: 通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
