// tests/geo_tests.js
// 坐标校正与坐标系转换测试。
//
// 这是「文保名称 ≠ 现用名」得以解决的基础：站点坐标经仿射校正后误差约 150 m，
// 于是可以用「周边搜索」按位置找回 POI，完全不依赖名称。
//
// 运行: node tests/geo_tests.js
'use strict';
const fs = require('fs');
const path = require('path');

global.window = global;
eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'geo.js'), 'utf8'));
const G = window.HMP.geo;

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (detail ? '  → ' + detail : '')); }
}
const d = (lo1, la1, lo2, la2) => G.distance(lo1, la1, lo2, la2) / 1000; // km

// ============ 1. 校正精度：16 个拟合点 ============
console.log('\n=== 1. 校正精度（16 个拟合点，真实坐标约 ±1km）===');
const TRAIN = [
  ['故宫', 113.13104, 41.50963, 116.397, 39.918],
  ['布达拉宫', 87.4554, 31.1297, 91.117, 29.657],
  ['颐和园', 113.0160, 41.5929, 116.275, 39.999],
  ['大足石刻', 102.2768, 31.1850, 105.700, 29.700],
  ['平遥古城', 108.8507, 38.7642, 112.175, 37.190],
  ['龙门石窟', 109.1492, 36.0900, 112.470, 34.550],
  ['秦始皇陵', 105.8804, 35.9109, 109.270, 34.380],
  ['明孝陵', 115.6154, 33.5569, 118.830, 32.060],
  ['承德避暑山庄', 114.6913, 42.6021, 117.940, 40.990],
  ['曲阜孔庙', 113.7347, 37.1369, 116.980, 35.600],
  ['丽江古城', 96.7198, 28.3119, 100.234, 26.872],
  ['皖南古村落', 114.7549, 31.3801, 117.990, 29.900],
  ['云冈石窟', 109.8171, 41.7087, 113.120, 40.110],
  ['殷墟', 111.0261, 37.6701, 114.300, 36.130],
  ['良渚', 116.7866, 31.8760, 119.980, 30.420],
  ['鼓浪屿', 114.8318, 25.8603, 118.070, 24.440],
];
let sum = 0, worst = 0, worstName = '';
for (const [name, slo, sla, rlo, rla] of TRAIN) {
  const [clo, cla] = G.steleToWgs84(slo, sla);
  const e = d(clo, cla, rlo, rla);
  sum += e;
  if (e > worst) { worst = e; worstName = name; }
}
const avg = sum / TRAIN.length;
console.log(`  平均误差 ${avg.toFixed(2)} km，最大 ${worst.toFixed(2)} km（${worstName}）`);
check('平均误差 < 2 km', avg < 2, avg.toFixed(2) + ' km');
check('最大误差 < 5 km', worst < 5, worst.toFixed(2) + ' km');

// 对照：不校正时的误差
const noFix = TRAIN.map(([, slo, sla, rlo, rla]) => d(slo, sla, rlo, rla));
const noFixAvg = noFix.reduce((a, b) => a + b, 0) / noFix.length;
console.log(`  对照：不校正时平均误差 ${noFixAvg.toFixed(0)} km`);
check('校正把误差降低至少 100 倍', noFixAvg / avg > 100,
  (noFixAvg / avg).toFixed(0) + '×');

// ============ 2. 留出验证：5 个改名案例（未参与拟合）============
console.log('\n=== 2. 留出验证：改名案例（未参与拟合）===');
const HOLDOUT = [
  ['真觉寺金刚宝座', 'feature_真觉寺金刚宝座.json', 116.3283, 39.9420, '北京石刻艺术博物馆'],
  ['觉生寺', 'feature_觉生寺.json', 116.3306, 39.9663, '大钟寺古钟博物馆'],
  ['智化寺', 'feature_智化寺.json', 116.4250, 39.9160, '北京文博交流馆'],
  ['先农坛', 'feature_先农坛.json', 116.3845, 39.8756, '北京古代建筑博物馆'],
  ['保国寺', 'feature_保国寺.json', 121.5170, 29.9820, '保国寺古建筑博物馆'],
];

// 需要 decoder 解出站点坐标
eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'decoder.js'), 'utf8'));
const D = window.HMP.decoder;
const FIX = path.join(__dirname, 'fixtures');

let hsum = 0, hworst = 0;
for (const [name, file, rlo, rla, modern] of HOLDOUT) {
  const feat = D.normalize(JSON.parse(fs.readFileSync(path.join(FIX, file), 'utf8')));
  const c = feat.geom.coordinates;
  const [clo, cla] = G.steleToWgs84(c[0], c[1]);
  const e = d(clo, cla, rlo, rla);
  hsum += e;
  if (e > hworst) hworst = e;
  console.log(`  ${name.padEnd(14)} 误差 ${e.toFixed(2)} km  → 现用名：${modern}`);
}
const havg = hsum / HOLDOUT.length;
console.log(`  留出平均误差 ${havg.toFixed(2)} km，最大 ${hworst.toFixed(2)} km`);
check('留出平均误差 < 1 km', havg < 1, havg.toFixed(2) + ' km');
check('留出最大误差 < 1 km（足以支撑 1km 周边搜索）', hworst < 1, hworst.toFixed(2) + ' km');

// ============ 2b. 百度坐标系下的校正精度 ============
// 仿射校正是「站点 → 真实 WGS84」，与地图厂商无关；再经 WGS84→GCJ02→BD09
// 转到各家坐标系。需验证转到 BD09 后精度不下降。
console.log('\n=== 2b. 三个坐标系下的校正精度对比（5 个留出点）===');
{
  const FIXD = path.join(__dirname, 'fixtures');
  let sw = 0, sg = 0, sb = 0;
  console.log('  | 点位 | →WGS84 | →GCJ02(高德) | →BD09(百度) |');
  console.log('  |---|---|---|---|');
  for (const [name, file, rlo, rla] of HOLDOUT) {
    const feat = D.normalize(JSON.parse(fs.readFileSync(path.join(FIXD, file), 'utf8')));
    const [slo, sla] = feat.geom.coordinates;
    const w = G.steleToWgs84(slo, sla);
    const g = G.steleToGcj02(slo, sla);
    const b = G.steleToBd09(slo, sla);
    const rg = G.wgs84ToGcj02(rlo, rla);
    const rb = G.gcj02ToBd09(rg[0], rg[1]);
    const ew = d(w[0], w[1], rlo, rla);
    const eg = d(g[0], g[1], rg[0], rg[1]);
    const eb = d(b[0], b[1], rb[0], rb[1]);
    sw += ew; sg += eg; sb += eb;
    console.log(`  | ${name} | ${ew.toFixed(3)} | ${eg.toFixed(3)} | ${eb.toFixed(3)} |`);
  }
  const aw = sw / HOLDOUT.length, ag = sg / HOLDOUT.length, ab = sb / HOLDOUT.length;
  console.log(`  | **平均** | **${aw.toFixed(3)}** | **${ag.toFixed(3)}** | **${ab.toFixed(3)}** |`);
  check('百度坐标系平均误差 < 1 km', ab < 1, ab.toFixed(3) + ' km');
  check('百度坐标系精度与高德相当（差 < 50 m）', Math.abs(ab - ag) < 0.05,
    Math.abs(ab - ag).toFixed(3) + ' km');
}

// ============ 3. 坐标系转换 ============
console.log('\n=== 3. 坐标系转换 WGS84 → GCJ02 → BD09 ===');
const wgs = [116.397, 39.918]; // 故宫
const gcj = G.wgs84ToGcj02(wgs[0], wgs[1]);
const bd = G.gcj02ToBd09(gcj[0], gcj[1]);

console.log(`  WGS84 ${wgs} → GCJ02 ${gcj.map(v => v.toFixed(6))} → BD09 ${bd.map(v => v.toFixed(6))}`);
const gcjShift = d(wgs[0], wgs[1], gcj[0], gcj[1]);
const bdShift = d(gcj[0], gcj[1], bd[0], bd[1]);
console.log(`  GCJ02 偏移 ${(gcjShift * 1000).toFixed(0)} m，BD09 相对 GCJ02 偏移 ${(bdShift * 1000).toFixed(0)} m`);

// 标准 GCJ02 算法在北京一带约偏移 500–600 m；BD09 再叠加约 0.0065°/0.006° 的
// 固定平移（≈800–900 m）。这里断言量级正确即可。
check('GCJ02 偏移在 300–800 m（符合火星坐标特征）', gcjShift > 0.3 && gcjShift < 0.8,
  (gcjShift * 1000).toFixed(0) + ' m');
check('BD09 相对 GCJ02 偏移在 400–1200 m', bdShift > 0.4 && bdShift < 1.2,
  (bdShift * 1000).toFixed(0) + ' m');
check('GCJ02 ≠ WGS84（确实做了转换）', Math.abs(gcj[0] - wgs[0]) > 1e-4);

// 境外应原样返回
const outside = G.wgs84ToGcj02(139.6917, 35.6895); // 东京
check('境外坐标不做 GCJ02 偏移', outside[0] === 139.6917 && outside[1] === 35.6895);

// 便捷组合
const [slo, sla] = [113.06352, 41.53819]; // 真觉寺站点坐标
const [mwlon, mwlat] = G.steleToWgs84(slo, sla);
const [mg, mgla] = G.steleToGcj02(slo, sla);
const [mb, mbla] = G.steleToBd09(slo, sla);
console.log(`\n  真觉寺：站点 ${slo},${sla}`);
console.log(`          → WGS84 ${mwlon.toFixed(5)},${mwlat.toFixed(5)}`);
console.log(`          → GCJ02 ${mg.toFixed(5)},${mgla.toFixed(5)}   (高德用)`);
console.log(`          → BD09  ${mb.toFixed(5)},${mbla.toFixed(5)}   (百度用)`);
const composedGcj = G.wgs84ToGcj02(mwlon, mwlat);
check('steleToGcj02 == steleToWgs84 → wgs84ToGcj02',
  mg === composedGcj[0] && mgla === composedGcj[1]);
const composedBd = G.gcj02ToBd09(composedGcj[0], composedGcj[1]);
check('steleToBd09 == steleToGcj02 → gcj02ToBd09',
  mb === composedBd[0] && mbla === composedBd[1]);

// ============ 3b. 往返一致性 ============
console.log('\n=== 3b. 往返换算一致性 ===');
{
  const pts = [
    ['北京', 116.397, 39.918],
    ['上海', 121.473, 31.230],
    ['拉萨', 91.117, 29.657],
  ];
  let maxG = 0, maxB = 0;
  for (const [city, lo, la] of pts) {
    // WGS84 → GCJ02 → WGS84
    const g = G.wgs84ToGcj02(lo, la);
    const backW = G.gcj02ToWgs84(g[0], g[1]);
    const eG = d(lo, la, backW[0], backW[1]) * 1000; // m
    // GCJ02 → BD09 → GCJ02
    const b = G.gcj02ToBd09(lo, la);
    const backG = G.bd09ToGcj02(b[0], b[1]);
    const eB = d(lo, la, backG[0], backG[1]) * 1000; // m
    maxG = Math.max(maxG, eG); maxB = Math.max(maxB, eB);
    console.log(`  ${city}: WGS84↔GCJ02 往返 ${eG.toFixed(2)} m，GCJ02↔BD09 往返 ${eB.toFixed(2)} m`);
  }
  check('WGS84↔GCJ02 往返误差 < 1 m', maxG < 1, maxG.toFixed(2) + ' m');
  check('GCJ02↔BD09 往返误差 < 1 m', maxB < 1, maxB.toFixed(2) + ' m');
}

// ============ 4. 合理性校验 ============
console.log('\n=== 4. isPlausible ===');
check('中国境内为 true', G.isPlausible(116.4, 39.9) === true);
check('境外为 false', G.isPlausible(139.7, 35.7) === false);
check('NaN 为 false', G.isPlausible(NaN, 39.9) === false);

console.log('\n结果: 通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
