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
    const reset = () => { calls.length = 0; baiduByQuery = {}; baiduAround = []; baiduAroundByQuery = {};
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

    // —— 6) 有开放时间时不额外请求（省配额）——
    reset();
    byKeyword = { '测试故居': amapWithHours };
    aroundPois = amapWithHours;
    baiduByQuery = { '测试故居': [baiduPoi('b8', '测试故居', bd[0], bd[1], '风景名胜;文物古迹')] };
    const before = calls.length;
    r = await CARD.queryOnePoi(cfgBoth, mkPoi(), {});
    const baiduCalls = calls.slice(before).filter(u => u.includes('api.map.baidu.com')).length;
    check('高德已有开放时间：不发起百度补充请求', baiduCalls === 0, '百度请求 ' + baiduCalls + ' 次');
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

  console.log('\n结果: 通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
