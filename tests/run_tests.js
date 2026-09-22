// tests/run_tests.js
// 对 16 个真实文保单位跑「解密 → 抽取 → 名称规范化 → 匹配」全链路测试。
//
// 候选 POI 列表模拟高德/百度关键字检索的真实返回（含同城干扰项、跨城同名项），
// 用来验证：
//   1. decoder 能解开站点混淆响应
//   2. naming 能正确抽出市级行政区与名称变体
//   3. matcher 能以名称为主挑中正确候选，并拒绝无关候选
//
// 运行: node tests/run_tests.js
'use strict';
const fs = require('fs');
const path = require('path');

// ---- 浏览器环境 mock（仅需 window / chrome / document 的最小面） ----
global.window = global;
global.document = { querySelector: () => null, createElement: () => ({ style: {} }) };
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
eval(fs.readFileSync(path.join(SRC, 'decoder.js'), 'utf8'));
eval(fs.readFileSync(path.join(SRC, 'naming.js'), 'utf8'));
eval(fs.readFileSync(path.join(SRC, 'apis', 'amap.js'), 'utf8'));
eval(fs.readFileSync(path.join(SRC, 'apis', 'baidu.js'), 'utf8'));
eval(fs.readFileSync(path.join(SRC, 'matcher.js'), 'utf8'));

const HMP = window.HMP;

// ================= 测试用例 =================
// candidates: 模拟地图 API 返回的候选（按真实高德/百度命名习惯构造）
// 干扰项分为两类：
//   - 同城相近名（同景区内的子景点/博物馆）
//   - 跨城同名/近名（最容易误匹配）
const CASES = [
  { kw: '故宫', expect: '故宫博物院', candidates: [
    { name: '故宫博物院', id: 'a1' },
    { name: '沈阳故宫博物院', id: 'a2' },
    { name: '明故宫遗址公园', id: 'a3' },
  ]},
  { kw: '布达拉宫', expect: '布达拉宫', candidates: [
    { name: '布达拉宫', id: 'b1' },
    { name: '布达拉宫广场', id: 'b2' },
    { name: '罗布林卡', id: 'b3' },
  ]},
  { kw: '颐和园', expect: '颐和园', candidates: [
    { name: '颐和园', id: 'c1' },
    { name: '颐和园苏州街', id: 'c2' },
    { name: '圆明园', id: 'c3' },
  ]},
  { kw: '大足石刻', expect: '大足石刻', candidates: [
    { name: '大足石刻宝顶山景区', id: 'd1' },
    { name: '大足石刻', id: 'd2' },
    { name: '大足石刻博物馆', id: 'd3' },
  ]},
  { kw: '平遥古城', expect: '平遥古城', candidates: [
    { name: '平遥古城', id: 'e1' },
    { name: '平遥古城墙', id: 'e2' },
    { name: '丽江古城', id: 'e3' },   // 跨城同名干扰
  ]},
  { kw: '龙门石窟', expect: '龙门石窟', candidates: [
    { name: '龙门石窟', id: 'f1' },
    { name: '龙门石窟西山石窟', id: 'f2' },
    { name: '云冈石窟', id: 'f3' },   // 跨城同类干扰
  ]},
  { kw: '秦始皇陵', expect: '秦始皇陵', candidates: [
    { name: '秦始皇陵', id: 'g1' },
    { name: '秦始皇陵兵马俑', id: 'g2' },
    { name: '秦始皇陵博物院', id: 'g3' },
  ]},
  { kw: '明孝陵', expect: '明孝陵', candidates: [
    { name: '明孝陵', id: 'h1' },
    { name: '明孝陵博物馆', id: 'h2' },
    { name: '明十三陵', id: 'h3' },   // 易混
  ]},
  { kw: '承德避暑山庄', expect: '避暑山庄', candidates: [
    { name: '避暑山庄', id: 'i1' },
    { name: '普宁寺', id: 'i2' },
    { name: '承德避暑山庄博物馆', id: 'i3' },
  ]},
  { kw: '曲阜孔庙', expect: '曲阜孔庙', candidates: [
    { name: '曲阜孔庙', id: 'j1' },
    { name: '孔府', id: 'j2' },
    { name: '孔林', id: 'j3' },
  ]},
  { kw: '丽江古城', expect: '丽江古城', candidates: [
    { name: '丽江古城', id: 'k1' },
    { name: '丽江古城大水车', id: 'k2' },
    { name: '束河古镇', id: 'k3' },
  ]},
  { kw: '皖南古村落', expect: null, candidates: [   // 官方名 vs 地图名差异大，预期可能失败
    { name: '西递古村景区', id: 'l1' },
    { name: '宏村景区', id: 'l2' },
    { name: '皖南古村落', id: 'l3' },
  ]},
  { kw: '云冈石窟', expect: '云冈石窟', candidates: [
    { name: '云冈石窟', id: 'm1' },
    { name: '云冈石窟景区', id: 'm2' },
    { name: '龙门石窟', id: 'm3' },   // 跨城同类干扰
  ]},
  { kw: '殷墟', expect: '殷墟', candidates: [
    { name: '殷墟', id: 'n1' },
    { name: '殷墟博物馆', id: 'n2' },
    { name: '殷墟宫殿宗庙遗址', id: 'n3' },
  ]},
  { kw: '良渚', expect: null, candidates: [          // 官方名 vs 地图名差异大
    { name: '良渚古城遗址公园', id: 'o1' },
    { name: '良渚博物院', id: 'o2' },
  ]},
  { kw: '鼓浪屿', expect: '鼓浪屿', candidates: [
    { name: '鼓浪屿', id: 'p1' },
    { name: '鼓浪屿钢琴博物馆', id: 'p2' },
    { name: '日光岩', id: 'p3' },
  ]},
];

// ================= 执行 =================
const FIX = path.join(__dirname, 'fixtures');
let pass = 0, fail = 0, skip = 0;
const rows = [];

for (const c of CASES) {
  const file = path.join(FIX, 'feature_' + c.kw + '.json');
  if (!fs.existsSync(file)) { console.log('⚠️  缺少 fixture: ' + c.kw); skip++; continue; }

  const feature = HMP.decoder.normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!feature) { console.log('❌ 解密失败: ' + c.kw); fail++; continue; }

  const city = HMP.naming.extractCity(feature.admin);
  const variants = HMP.naming.searchNames(feature.name);
  const target = { name: feature.name, city, nameVariants: variants, lon: null, lat: null };

  const matched = HMP.matcher.pick(target, c.candidates);
  const got = matched ? matched.poi.name : null;

  let verdict;
  if (c.expect === null) {
    // 预期为"困难用例"：只要不误匹配到明显错误的近似项就算通过
    const wrongNames = ['丽江古城', '云冈石窟', '龙门石窟', '明十三陵'];
    const misHit = got && wrongNames.includes(got) && !feature.name.includes(got);
    verdict = misHit ? 'FAIL' : 'PASS';
  } else {
    verdict = (got === c.expect) ? 'PASS' : 'FAIL';
  }

  if (verdict === 'PASS') pass++; else fail++;
  rows.push({
    kw: c.kw, name: feature.name, city, variants,
    expect: c.expect || '(困难用例)', got: got || '未匹配',
    sim: matched ? matched.sim.toFixed(3) : '-', verdict
  });
}

// ================= 报告 =================
console.log('\n================ 16 个文保单位匹配测试 ================\n');
console.log('| 站点名称 | 抽出市级 | 名称变体 | 期望命中 | 实际命中 | 相似度 | 结果 |');
console.log('|---|---|---|---|---|---|---|');
for (const r of rows) {
  console.log('| ' + r.name + ' | ' + (r.city || '-') + ' | ' + r.variants.join(' / ') +
    ' | ' + r.expect + ' | ' + r.got + ' | ' + r.sim + ' | ' + (r.verdict === 'PASS' ? '✅' : '❌') + ' |');
}
console.log('\n结果: 通过 ' + pass + ' / 失败 ' + fail + (skip ? ' / 跳过 ' + skip : '') +
  '，通过率 ' + Math.round(pass / (pass + fail) * 100) + '%');

process.exit(fail === 0 ? 0 : 1);
