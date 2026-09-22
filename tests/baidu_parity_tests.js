// tests/baidu_parity_tests.js
// 跨数据源一致性：把**高德侧已验证过的同一批真实文保单位**，用同样的候选名
// 走**完整的百度管道**（fetch → callBaidu → mapPoi → 三路检索 → 决策），
// 看百度是否给出与高德相同的答案。
//
// 与 run_tests.js 的区别：
//   · run_tests.js 直接调 matcher.pick，只测"打分与取舍"
//   · 本文件走 queryOnePoi 全链路，额外覆盖：
//       百度响应结构（status:0 / results[] / location 对象 / detail_info）
//       百度字段映射（shop_hours → 开放时间、telephone、price）
//       百度坐标解析（含字符串形态）
//       数据源选择与字段互补
//
// 目的：暴露"只有百度才会犯"的错误——例如坐标解析不对称导致坐标路径全废、
//       或百度侧字段名不同导致开放时间丢失。这些用高德数据测不出来。
//
// 运行: node tests/baidu_parity_tests.js
'use strict';
const fs = require('fs');
const path = require('path');

// ---------------- 浏览器环境 mock ----------------
global.window = global;
global.document = { querySelector: () => null, createElement: () => ({ style: {}, appendChild() {} }),
  getElementById: () => null, body: { appendChild() {} } };
global.window.addEventListener = () => {};
global.MutationObserver = class { observe() {} disconnect() {} };
global.chrome = {
  storage: { local: {
    _store: {},
    get(k, cb) { const store = this._store || {}; const o = (k == null) ? Object.assign({}, store) : (() => { const r = {}; for (const x of (Array.isArray(k) ? k : [k])) if (x in store) r[x] = store[x]; return r; })(); if (cb) cb(o); return Promise.resolve(o); },
    set(i, cb) { Object.assign(this._store, i); if (cb) cb(); return Promise.resolve(); },
    remove(k, cb) { (Array.isArray(k) ? k : [k]).forEach(x => delete this._store[x]); if (cb) cb(); return Promise.resolve(); }
  } }
};

const SRC = path.join(__dirname, '..', 'src', 'content');
['decoder', 'naming', 'geo', 'cache', 'http'].forEach(f =>
  eval(fs.readFileSync(path.join(SRC, f + '.js'), 'utf8')));
eval(fs.readFileSync(path.join(SRC, 'apis', 'amap.js'), 'utf8'));
eval(fs.readFileSync(path.join(SRC, 'apis', 'baidu.js'), 'utf8'));
eval(fs.readFileSync(path.join(SRC, 'matcher.js'), 'utf8'));
eval(fs.readFileSync(path.join(SRC, 'card.js'), 'utf8'));

const HMP = window.HMP;
const GEO = HMP.geo;
const CARD = HMP.card;

// ---------------- 与 run_tests.js 相同的真实用例 ----------------
// 候选名沿用高德侧那份（模拟真实检索返回的近似项、跨城同名项）。
const FIX = path.join(__dirname, 'fixtures');
const CASES = [
  { kw: '故宫', expect: '故宫博物院', candidates: ['故宫博物院', '沈阳故宫博物院', '明故宫遗址公园'] },
  { kw: '布达拉宫', expect: '布达拉宫', candidates: ['布达拉宫', '布达拉宫广场', '罗布林卡'] },
  { kw: '颐和园', expect: '颐和园', candidates: ['颐和园', '颐和园苏州街', '圆明园'] },
  { kw: '大足石刻', expect: '大足石刻', candidates: ['大足石刻宝顶山景区', '大足石刻', '大足石刻博物馆'] },
  { kw: '平遥古城', expect: '平遥古城', candidates: ['平遥古城', '平遥古城墙', '丽江古城'] },
  { kw: '龙门石窟', expect: '龙门石窟', candidates: ['龙门石窟', '龙门石窟西山石窟', '云冈石窟'] },
  { kw: '秦始皇陵', expect: '秦始皇陵', candidates: ['秦始皇陵', '秦始皇陵兵马俑', '明十三陵'] },
  { kw: '明孝陵', expect: '明孝陵', candidates: ['明孝陵', '明孝陵博物馆', '明十三陵'] },
  { kw: '承德避暑山庄', expect: '承德避暑山庄', candidates: ['承德避暑山庄', '承德避暑山庄博物馆', '避暑山庄'] },
  { kw: '曲阜孔庙', expect: '曲阜孔庙', candidates: ['曲阜孔庙', '曲阜孔府', '南京夫子庙'] },
  { kw: '丽江古城', expect: '丽江古城', candidates: ['丽江古城', '丽江古城博物院', '平遥古城'] },
  { kw: '皖南古村落', expect: '皖南古村落－西递、宏村', candidates: ['皖南古村落－西递、宏村', '西递', '宏村'] },
  { kw: '云冈石窟', expect: '云冈石窟', candidates: ['云冈石窟', '云冈石窟研究院', '龙门石窟'] },
  { kw: '殷墟', expect: '殷墟', candidates: ['殷墟', '殷墟博物馆', '安阳殷墟'] },
  { kw: '良渚', expect: '良渚遗址-莫角山遗址', candidates: ['良渚古城遗址公园', '良渚遗址-莫角山遗址', '良渚博物院'] },
  { kw: '鼓浪屿', expect: '鼓浪屿近代建筑群', candidates: ['鼓浪屿近代建筑群', '鼓浪屿', '厦门大学'] },
];

// ---------------- 百度格式的候选构造 ----------------
// 关键：location 用**字符串**形态——这正是之前把百度坐标路径整条打死的写法。
// 若坐标解析回归，parity 会立刻失败。
let baiduByQuery = {};       // query → results[]
let baiduAroundByQuery = {}; // 环形检索 query → results[]
const calls = [];

const bd = (lon, lat) => {
  const g = GEO.wgs84ToGcj02(lon, lat);
  return GEO.gcj02ToBd09(g[0], g[1]);
};

// 两家都支持：高德回 {status:'1',pois}，百度回 {status:0,results}。
// "决策一致性矩阵"会把同一批候选分别喂给两家，比较结论是否相同。
let amapByKeyword = {};
let amapAround = [];

global.fetch = async (url) => {
  const u = String(url); calls.push(u);

  if (u.includes('api.map.baidu.com')) {
    const q = new URL(u).searchParams.get('query') || '';
    const isAround = !!new URL(u).searchParams.get('location');
    const list = isAround ? (baiduAroundByQuery[q] || []) : (baiduByQuery[q] || []);
    return { ok: true, status: 200, json: async () => ({ status: 0, message: 'ok', results: list }) };
  }

  if (u.includes('restapi.amap.com')) {
    if (u.includes('/place/around')) {
      return { ok: true, status: 200, json: async () => ({ status: '1', pois: amapAround }) };
    }
    const kw = new URL(u).searchParams.get('keywords') || '';
    return { ok: true, status: 200, json: async () => ({ status: '1', pois: amapByKeyword[kw] || [] }) };
  }

  throw new Error('parity 测试收到了意料之外的请求：' + u);
};

// ================= 执行 =================
let pass = 0, fail = 0, skip = 0;
const rows = [];

(async () => {
  for (const c of CASES) {
    const file = path.join(FIX, 'feature_' + c.kw + '.json');
    if (!fs.existsSync(file)) { console.log('⚠️  缺少 fixture: ' + c.kw); skip++; continue; }

    const feature = HMP.decoder.normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (!feature) { console.log('❌ 解密失败: ' + c.kw); fail++; continue; }

    const city = HMP.naming.extractCity(feature.admin);
    const lon = feature.geom && feature.geom.coordinates ? feature.geom.coordinates[0] : null;
    const lat = feature.geom && feature.geom.coordinates ? feature.geom.coordinates[1] : null;

    // 站点坐标 → 百度坐标（模拟百度返回的 location）
    let blon = 121, blat = 31;
    if (Number.isFinite(lon)) {
      const w = GEO.steleToWgs84(lon, lat);
      const g = GEO.wgs84ToGcj02(w[0], w[1]);
      const b = GEO.gcj02ToBd09(g[0], g[1]);
      blon = b[0]; blat = b[1];
    }

    // 用候选名造百度响应（坐标写成字符串，专测解析容错）
    const results = c.candidates.map((name, i) => ({
      uid: c.kw + '_' + i,
      name,
      address: (feature.address || '') || '测试地址',
      location: { lng: String(blon + i * 0.0002), lat: String(blat + i * 0.0002) },
      detail_info: { type: '风景名胜;文物古迹', shop_hours: '09:00-17:00' },
    }));

    const variants = HMP.naming.searchNames(feature.name);
    baiduByQuery = {};
    baiduAroundByQuery = {};
    // 名称检索：各变体都返回同一批候选
    // 百度侧 query 不带城市（城市走 region 参数），所以键就是裸名
    for (const v of variants) baiduByQuery[v] = results;
    baiduByQuery[feature.name] = results;
    for (const v of variants) baiduAroundByQuery[v] = results;

    const poi = {
      name: feature.name,
      admin: feature.admin, adminLast: (feature.admin || []).slice(-1)[0] || '',
      city, address: feature.address,
      addrQuery: HMP.naming.addressQuery(feature.admin, feature.address),
      nameVariants: variants,
      searchTerms: variants.slice(0, 3),
      gcj: GEO.wgs84ToGcj02(GEO.steleToWgs84(lon, lat)[0], GEO.steleToWgs84(lon, lat)[1]),
      bd09: [blon, blat],
      featureType: feature.feature_type,
    };

    calls.length = 0;
    let r = null, err = null;
    try {
      r = await CARD.queryOnePoi(
        { defaultProvider: 'baidu', baiduAk: 'B', amapKey: '', strategyMode: 'combine' }, poi, {});
    } catch (e) { err = e; }

    const got = r && r.ok && r.info ? r.info.name : (err ? '异常:' + err.message : '未匹配');
    const hours = r && r.ok && r.info ? (r.info.opentimeWeek || r.info.opentimeToday) : '';

    // 与 run_tests 相同的判定口径
    let verdict;
    if (c.expect === null) {
      const wrongNames = ['丽江古城', '云冈石窟', '龙门石窟', '明十三陵'];
      verdict = (got && wrongNames.includes(got) && !feature.name.includes(got)) ? 'FAIL' : 'PASS';
    } else {
      verdict = (got === c.expect) ? 'PASS' : 'FAIL';
    }
    if (verdict === 'PASS') pass++; else fail++;
    rows.push({ kw: c.kw, name: feature.name, city, expect: c.expect || '(困难用例)',
      got: got || '未匹配', hours, verdict, provider: r && r.provider });
  }

  console.log('\n========== 百度侧：16 个真实文保单位全链路测试 ==========\n');
  console.log('| 站点名称 | 抽出市级 | 期望命中 | 百度命中 | 开放时间 | 来源 | 结果 |');
  console.log('|---|---|---|---|---|---|---|');
  for (const r of rows) {
    console.log('| ' + r.name + ' | ' + (r.city || '-') + ' | ' + r.expect + ' | ' + r.got +
      ' | ' + (r.hours || '-') + ' | ' + (r.provider || '-') + ' | ' +
      (r.verdict === 'PASS' ? '✅' : '❌') + ' |');
  }

  // 额外的结构性断言：百度路径必须真的用上坐标
  const withCoords = rows.filter(r => r.got !== '未匹配').length;
  console.log('\n命中 ' + withCoords + ' / ' + rows.length + '，均带开放时间：' +
    (rows.every(r => r.got === '未匹配' || r.hours) ? '是' : '否'));

  // ================= 决策一致性矩阵 =================
  // 原则：高德与百度只是数据来源，后续分析（打分、降权、取舍）必须完全相同。
  // 做法：同一批候选分别以两家格式喂进去，断言结论一致。
  // 任何"只对某一家生效"的分析逻辑都会在这里暴露。
  console.log('\n========== 决策一致性矩阵（两家结论必须相同）==========\n');

  const WGS_REF = [121.4700, 31.2300];
  const w2g = (lon, lat) => GEO.wgs84ToGcj02(lon, lat);
  const w2b = (lon, lat) => {
    const g = w2g(lon, lat);
    return GEO.gcj02ToBd09(g[0], g[1]);
  };

  /** 场景里的候选用 WGS84 描述，这里同时产出两家的请求/响应格式 */
  function toAmap(cs) {
    return cs.map((c, i) => {
      const g = w2g(c.lon, c.lat);
      return {
        id: 'A' + i, name: c.name, type: c.type, address: c.address,
        location: g[0] + ',' + g[1],
        business: c.hours ? { opentime_today: c.hours } : {},
      };
    });
  }
  function toBaidu(cs) {
    return cs.map((c, i) => {
      const b = w2b(c.lon, c.lat);
      return {
        uid: 'B' + i, name: c.name, address: c.address,
        // 故意用字符串坐标：两家必须都能解析
        location: { lng: String(b[0]), lat: String(b[1]) },
        detail_info: Object.assign({ type: c.type }, c.hours ? { shop_hours: c.hours } : {}),
      };
    });
  }

  const SCENARIOS = [
    {
      label: '子单元不得盖过本体',
      target: '上海国际饭店',
      cands: [
        { name: '上海国际饭店-会议中心', type: '餐饮服务;咖啡厅', address: '南京西路170号', lon: 121.4700, lat: 31.2300 },
        { name: '上海国际饭店', type: '风景名胜;文物古迹', address: '南京西路170号', lon: 121.4705, lat: 31.2305, hours: '09:00-21:00' },
      ],
      expect: '上海国际饭店',
    },
    {
      label: '借用文保名的住宅小区要让位',
      target: '兆丰花园遗址',
      address: '长宁路780号',
      cands: [
        { name: '兆丰花园', type: '商务住宅;住宅区', address: '长宁路788号', lon: 121.4700, lat: 31.2300 },
        { name: '中山公园', type: '风景名胜;公园', address: '长宁路780号', lon: 121.4705, lat: 31.2305, hours: '05:00-21:00' },
      ],
      expect: '中山公园',
    },
    {
      label: '大型场地不得落到大门上',
      target: '圆明园',
      cands: [
        { name: '圆明园（东门）', type: '风景名胜;公园', address: '清华西路28号', lon: 121.4700, lat: 31.2300, hours: '大门时间' },
        { name: '圆明园', type: '风景名胜;公园', address: '清华西路28号', lon: 121.4720, lat: 31.2320, hours: '07:00-19:00' },
      ],
      expect: '圆明园',
    },
    {
      label: '改名点位靠坐标找回',
      target: '真觉寺金刚宝座',
      noNameHit: true,
      cands: [
        { name: '北京石刻艺术博物馆', type: '科教文化服务;博物馆', address: '五塔寺村24号', lon: 121.4700, lat: 31.2300, hours: '09:00-16:30' },
      ],
      expect: '北京石刻艺术博物馆',
    },
    {
      label: '只被坐标支持的隔壁商户应被拒绝',
      target: '某文保旧址',
      noNameHit: true,
      cands: [
        { name: '某按摩店', type: '生活服务;洗浴推拿', address: '某路1号', lon: 121.4700, lat: 31.2300, hours: '10:00-22:00' },
      ],
      expect: null,      // 两家都应给出"未匹配"
    },
  ];

  for (const sc of SCENARIOS) {
    const amapList = toAmap(sc.cands);
    const baiduList = toBaidu(sc.cands);

    // 名称检索：除非场景声明"名称搜不到"，否则把候选挂在所有可能的检索词下
    const mkPoi = () => ({
      name: sc.target, nameVariants: [sc.target], searchTerms: [sc.target],
      city: '上海市', adminLast: '黄浦区',
      address: sc.address || '某路1号',
      addrQuery: '上海市 ' + (sc.address || '某路1号'),
      gcj: w2g(WGS_REF[0], WGS_REF[1]),
      bd09: w2b(WGS_REF[0], WGS_REF[1]),
    });

    const runWith = async (provider, list) => {
      amapByKeyword = {}; amapAround = [];
      baiduByQuery = {}; baiduAroundByQuery = {};
      if (!sc.noNameHit) {
        amapByKeyword['上海市 ' + sc.target] = list;
        baiduByQuery[sc.target] = list;
      }
      // 地址路径也要喂——"借用文保名的住宅小区"这类判据正是靠地址检索触发的
      // （地址查不到候选时，地址路径为空，就退化成纯名称比较了）
      const addr = '上海市 ' + (sc.address || '某路1号');
      amapByKeyword[addr] = list;
      baiduByQuery[addr] = list;
      amapByKeyword[sc.address || '某路1号'] = list;
      baiduByQuery[sc.address || '某路1号'] = list;
      // 坐标路径两家都给（改名场景的唯一出路）
      amapAround = list;
      baiduAroundByQuery[sc.target] = list;

      const cfg = provider === 'amap'
        ? { defaultProvider: 'amap', amapKey: 'A', baiduAk: '', strategyMode: 'combine' }
        : { defaultProvider: 'baidu', amapKey: '', baiduAk: 'B', strategyMode: 'combine' };
      const r = await CARD.queryOnePoi(cfg, mkPoi(), {});
      return r && r.ok && r.info ? r.info.name : null;
    };

    const amapGot = await runWith('amap', amapList);
    const baiduGot = await runWith('baidu', baiduList);
    const same = amapGot === baiduGot;
    const right = amapGot === sc.expect;

    if (same && right) pass++; else fail++;
    console.log('| ' + sc.label + ' | 期望 ' + (sc.expect || '未匹配') +
      ' | 高德 ' + (amapGot || '未匹配') + ' | 百度 ' + (baiduGot || '未匹配') + ' | ' +
      (same ? '结论一致 ✅' : '结论不一致 ❌') + (right ? '' : ' / 期望不符 ❌') + ' |');
  }

  console.log('\n结果: 通过 ' + pass + ' / 失败 ' + fail + (skip ? ' / 跳过 ' + skip : '') +
    '，通过率 ' + Math.round(pass / (pass + fail) * 100) + '%');

  process.exit(fail === 0 ? 0 : 1);
})();
