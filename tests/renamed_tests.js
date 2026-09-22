// tests/renamed_tests.js
// 「文保名称 ≠ 现用名」场景的端到端测试。
//
// 典型难题：
//   真觉寺金刚宝座  →  现为 北京石刻艺术博物馆
//   觉生寺          →  现为 大钟寺古钟博物馆
//   先农坛          →  现为 北京古代建筑博物馆
// 名称完全无关，纯名称匹配无解。解决路径有两条：
//   A. 从 address/intro 里挖出「现用名」当检索词（naming.extractModernNames）
//   B. 用**校正后坐标**做周边搜索，按位置找回（card.searchNearby）
//
// 运行: node tests/renamed_tests.js
'use strict';
const fs = require('fs');
const path = require('path');

global.window = global;

const SRC = path.join(__dirname, '..', 'src', 'content');
const FIX = path.join(__dirname, 'fixtures');

// ---- 环境 mock ----
// 高德返回 { status:'1', pois:[{ location:'lon,lat' }] }
// 百度返回 { status:0,  results:[{ location:{lng,lat} }] }，且坐标为 BD09
const captured = [];
let amapAround = [], amapName = [], baiduAround = [], baiduName = [];
global.fetch = async (url) => {
  const u = String(url);
  captured.push(u);
  const isAmap = u.includes('restapi.amap.com');
  const isAround = u.includes('/place/around') ||
    (u.includes('/place/v2/search') && new URL(u).searchParams.has('location'));
  if (isAmap) {
    return { ok: true, status: 200,
      json: async () => ({ status: '1', pois: isAround ? amapAround : amapName }) };
  }
  return { ok: true, status: 200,
    json: async () => ({ status: 0, results: isAround ? baiduAround : baiduName }) };
};

function makeEl(tag) {
  return {
    tagName: tag, children: [], style: {}, attributes: {},
    className: '', id: '', _text: '', _html: '',
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k]; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {}, remove() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    classList: { add() {}, remove() {} },
    set textContent(v) { this._text = v; }, get textContent() { return this._text; },
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
  };
}
global.document = {
  body: makeEl('body'),
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  createElement: makeEl, createTextNode: (t) => ({ nodeType: 3, textContent: t }),
};
global.window.addEventListener = () => {};
global.MutationObserver = class { observe() {} disconnect() {} };
global.chrome = {
  storage: { local: {
    _store: { amapKey: 'K', baiduAk: '', defaultProvider: 'amap', enabled: true },
    get(k, cb) { const store = this._store || {}; const o = (k == null) ? Object.assign({}, store) : (() => { const r = {}; for (const x of (Array.isArray(k) ? k : [k])) if (x in store) r[x] = store[x]; return r; })(); if (cb) cb(o); return Promise.resolve(o); },
    set(i, cb) { Object.assign(this._store, i); if (cb) cb(); return Promise.resolve(); },
    remove(k, cb) { (Array.isArray(k) ? k : [k]).forEach(x => delete this._store[x]); if (cb) cb(); return Promise.resolve(); },
  } }
};

['decoder', 'naming', 'geo', 'cache', 'http'].forEach(f =>
  eval(fs.readFileSync(path.join(SRC, f + '.js'), 'utf8')));
eval(fs.readFileSync(path.join(SRC, 'apis', 'amap.js'), 'utf8'));
eval(fs.readFileSync(path.join(SRC, 'apis', 'baidu.js'), 'utf8'));
eval(fs.readFileSync(path.join(SRC, 'matcher.js'), 'utf8'));
eval(fs.readFileSync(path.join(SRC, 'card.js'), 'utf8'));

const HMP = window.HMP;
const GEO = HMP.geo;

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (detail ? '  → ' + detail : '')); }
}
const km = (a, b, c, d) => GEO.distance(a, b, c, d) / 1000;

// ============ 案例表 ============
const CASES = [
  {
    file: 'feature_真觉寺金刚宝座.json',
    site: '真觉寺金刚宝座',
    modern: '北京石刻艺术博物馆',
    real: [116.3283, 39.9420],
  },
  {
    file: 'feature_觉生寺.json',
    site: '觉生寺',
    modern: '大钟寺古钟博物馆',
    real: [116.3306, 39.9663],
  },
  {
    file: 'feature_先农坛.json',
    site: '先农坛',
    // intro 里写着「后更名为先农坛体育场」，属于真实线索（新增 更名为 动词后抓到）
    modern: '先农坛体育场',
    real: [116.3845, 39.8756],
  },
  {
    file: 'feature_智化寺.json',
    site: '智化寺',
    modern: null,
    real: [116.4250, 39.9160],
  },
];

const feats = {};
for (const c of CASES) {
  feats[c.site] = HMP.decoder.normalize(JSON.parse(fs.readFileSync(path.join(FIX, c.file), 'utf8')));
}

// ============ 1. extractPoi：检索词与校正坐标 ============
console.log('\n=== 1. extractPoi：现用名进入检索词，坐标被校正 ===');
for (const c of CASES) {
  const poi = HMP.card.extractPoi(feats[c.site]);
  console.log(`\n  【${c.site}】`);
  console.log(`    文保名      : ${poi.name}`);
  console.log(`    挖出现用名  : ${JSON.stringify(poi.modernNames)}`);
  console.log(`    检索词(前3) : ${JSON.stringify(poi.searchTerms)}`);
  console.log(`    GCJ02 坐标  : ${poi.gcj.map(v => v.toFixed(5))}`);
  const err = km(poi.gcj[0], poi.gcj[1], GEO.wgs84ToGcj02(c.real[0], c.real[1])[0], GEO.wgs84ToGcj02(c.real[0], c.real[1])[1]);
  console.log(`    与实际位置差: ${err.toFixed(2)} km`);

  check(`${c.site} 校正后坐标误差 < 1km`, err < 1, err.toFixed(2) + ' km');
  if (c.modern) {
    check(`${c.site} 现用名「${c.modern}」进入检索词`,
      poi.searchTerms.includes(c.modern), JSON.stringify(poi.searchTerms));
  } else {
    check(`${c.site} 无现用名线索（依赖坐标兜底）`, poi.modernNames.length === 0,
      JSON.stringify(poi.modernNames));
  }
}

// ============ 2. 名称检索优先用现用名 ============
console.log('\n=== 2. 名称检索优先使用现用名 ===');
(async () => {
  for (const c of CASES.filter(x => x.modern)) {
    const poi = HMP.card.extractPoi(feats[c.site]);
    amapName = [];
    captured.length = 0;
    await HMP.card.searchByName({ amapKey: 'K' }, 'amap', poi);
    const first = captured.length ? new URL(captured[0]).searchParams.get('keywords') : null;
    const city = HMP.naming.extractCity(feats[c.site].admin);
    const expect = `${city} ${c.modern}`;
    check(`${c.site} 首个检索词 = "${expect}"`, first === expect, String(first));
  }

  // ============ 3. 周边搜索找回"改名后"的 POI ============
  console.log('\n=== 3. 周边搜索（改名场景核心）===');
  for (const c of CASES) {
    const poi = HMP.card.extractPoi(feats[c.site]);
    // 模拟高德 around 返回：目标机构 + 若干无关 POI（其中有些更近）
    const [rlo, rla] = GEO.wgs84ToGcj02(c.real[0], c.real[1]);
    const targetName = c.modern || c.site;
    amapAround = [
      // 无关但更近的便利店（应被类型过滤掉）
      { id: 'n1', name: '便利蜂', type: '购物服务;便利店', location: `${rlo + 0.0002},${rla}`, business: {} },
      // 无关但更近的停车场
      { id: 'n2', name: '停车场', type: '交通设施服务;停车场', location: `${rlo + 0.0001},${rla}`, business: {} },
      // 真正的目标（名称与文保名无关）
      { id: 't1', name: targetName, type: '科教文化服务;博物馆',
        location: `${rlo + 0.0008},${rla + 0.0005}`,
        business: { opentimeToday: '09:00-17:00', opentimeWeek: '周二至周日 09:00-17:00', tel: '010-62173543' } },
      // 另一个景点（稍远）
      { id: 't2', name: '某公园', type: '风景名胜;公园',
        location: `${rlo + 0.004},${rla + 0.004}`, business: { opentimeToday: '06:00-21:00' } },
    ];

    const r = await HMP.card.searchNearby({ amapKey: 'K' }, 'amap', poi);
    console.log(`\n  【${c.site}】期望找回：${targetName}`);
    if (r) {
      console.log(`    实际匹配 : ${r.matched.poi.name}（${r.matched.poi.type}）`);
      console.log(`    距离     : ${Math.round(r.dist)} m，名称相似度 ${r.matched.sim.toFixed(3)}`);
    } else {
      console.log('    实际匹配 : null');
    }

    check(`${c.site} 周边搜索命中「${targetName}」`,
      r && r.matched.poi.name === targetName, r ? r.matched.poi.name : 'null');
    check(`${c.site} matchType = location`, r && r.matchType === 'location', r && r.matchType);
    check(`${c.site} 已过滤商业 POI`, !r || !['便利蜂', '停车场'].includes(r.matched.poi.name),
      r && r.matched.poi.name);
  }

  // ============ 4. 类型打分 ============
  console.log('\n=== 4. 类型打分 heritageRank ===');
  check('博物馆 → 2', HMP.card.heritageRank({ name: 'X', type: '科教文化服务;博物馆' }) === 2);
  check('公园 → 2', HMP.card.heritageRank({ name: 'X', type: '风景名胜;公园' }) === 2);
  // 按「可入内」原则：商业类型不再一律排除（酒店/银行/商场都可能是文保现状），
  // 只有设施类才排除；便利店属中性，靠名称/地址交叉印证来取舍。
  check('便利店 → 1（商业类型不再排除）', HMP.card.heritageRank({ name: '便利蜂', type: '购物服务;便利店' }) === 1);
  check('停车场 → 0', HMP.card.heritageRank({ name: 'P', type: '交通设施服务;停车场' }) === 0);
  check('未知类型 → 1', HMP.card.heritageRank({ name: '某某', type: '其他' }) === 1);

  // ============ 5. 整体决策：强名称优先，否则位置 ============
  console.log('\n=== 5. queryOnePoi 决策顺序 ===');
  const poi0 = HMP.card.extractPoi(feats['真觉寺金刚宝座']);

  // 5a) 名称检索有强命中 → 用名称
  amapName = [{ id: 'm1', name: '真觉寺金刚宝座', location: '116.328,39.942', business: { opentimeToday: '09:00-17:00' } }];
  amapAround = [{ id: 't1', name: '北京石刻艺术博物馆', type: '科教文化服务;博物馆', location: '116.3283,39.9420', business: { opentimeToday: '09:00-16:30' } }];
  let res = await HMP.card.queryOnePoi({ amapKey: 'K' }, poi0);
  check('强名称命中时优先用名称', res.ok && res.matchType === 'name', res.matchType);

  // 5b) 名称检索空 → 回退到位置
  amapName = [];
  res = await HMP.card.queryOnePoi({ amapKey: 'K' }, poi0);
  check('名称无结果时回退到位置匹配', res.ok && res.matchType === 'location', res.matchType);
  check('位置匹配到 北京石刻艺术博物馆',
    res.ok && res.info.name === '北京石刻艺术博物馆', res.ok ? res.info.name : 'null');

  // ============ 6. 用现用名检索到的结果应判为「名称匹配」 ============
  console.log('\n=== 6. 用现用名检索 → 判为名称匹配（而非退化成位置匹配）===');
  {
    const poi = HMP.card.extractPoi(feats['真觉寺金刚宝座']);
    // 关键词用的是从 address 挖出的现用名，返回的也是该现用名 POI
    amapName = [{ id: 'm1', name: '北京石刻艺术博物馆', type: '科教文化服务;博物馆',
      location: '116.3283,39.9420', business: { opentimeToday: '09:00-16:30' } }];
    amapAround = [];
    const r = await HMP.card.searchByName({ amapKey: 'K' }, 'amap', poi);
    console.log(`  现用名命中：${r ? r.matched.poi.name : 'null'}，相似度 ${r ? r.matched.sim.toFixed(3) : '-'}`);
    check('现用名命中被认作名称匹配', !!r && r.matchType === 'name', r && r.matchType);
    check('相似度达到强匹配阈值（≥ NAME_STRONG_SIM）',
      !!r && r.matched.sim >= HMP.card.NAME_STRONG_SIM,
      r ? r.matched.sim.toFixed(3) : 'null');
    check('匹配对象是北京石刻艺术博物馆',
      !!r && r.matched.poi.name === '北京石刻艺术博物馆', r && r.matched.poi.name);
  }

  // ============ 7. 百度路径：输入 BD09、参考点同为 BD09 ============
  console.log('\n=== 7. 百度路径使用 BD09（不依赖 ret_coordtype）===');
  {
    const poiB = HMP.card.extractPoi(feats['觉生寺']);
    const [glo, gla] = GEO.wgs84ToGcj02(116.3306, 39.9663);
    const [blo, bla] = GEO.gcj02ToBd09(glo, gla);   // 百度原生 BD09
    amapName = []; amapAround = [];
    baiduName = [];
    baiduAround = [{
      uid: 'b1', name: '大钟寺古钟博物馆',
      detail_info: { type: '博物馆', shop_hours: '09:00-16:30', telephone: '010-82132676' },
      location: { lng: blo + 0.0002, lat: bla + 0.0001 },
    }];

    captured.length = 0;
    const rB = await HMP.card.searchNearby({ baiduAk: 'A' }, 'baidu', poiB);

    const burl = captured.find(u => u.includes('map.baidu.com'));
    check('发起了百度周边请求', !!burl);
    if (burl) {
      const q = new URL(burl).searchParams;
      const [qlat, qlng] = (q.get('location') || '').split(',').map(Number);
      const dLng = Math.abs(qlng - poiB.bd09[0]);
      const dLat = Math.abs(qlat - poiB.bd09[1]);
      console.log(`  请求 location=${q.get('location')}（BD09，lat,lng 顺序）`);
      check('location 为 BD09 且 lat,lng 顺序正确', dLng < 1e-6 && dLat < 1e-6,
        `Δ=(${dLng.toExponential(1)}, ${dLat.toExponential(1)})`);
      check('coord_type=3（声明输入为 BD09）', q.get('coord_type') === '3');
      check('不传 ret_coordtype（返回原生 BD09）', !q.has('ret_coordtype'));
    }
    console.log(`  百度周边命中：${rB ? rB.matched.poi.name : 'null'}（${rB ? Math.round(rB.dist) : '-'} m）`);
    check('百度周边搜索命中目标且距离合理',
      !!rB && rB.matched.poi.name === '大钟寺古钟博物馆' && rB.dist < 100,
      rB ? `${rB.matched.poi.name} / ${Math.round(rB.dist)}m` : 'null');
  }

  console.log('\n结果: 通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
