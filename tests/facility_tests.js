// tests/facility_tests.js
// #14-S2 · 设施点硬压：STELE 名是候选前缀 + 设施后缀 ⇒ simAdj ≤0.5、不吃 mult、不当结果
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const env = require('./_env');
const { check, finish } = env.makeChecker('facility');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src/content');

function loadMatcher(withEvidence) {
  const sandbox = { window: { HMP: {} }, console: { log() {}, warn() {}, error() {} }, Math, Number, String, Array, Object, JSON };
  vm.createContext(sandbox);
  if (withEvidence) vm.runInContext(fs.readFileSync(path.join(SRC, 'name-evidence.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(SRC, 'matcher.js'), 'utf8'), sandbox);
  return sandbox.window.HMP.matcher;
}
const M = loadMatcher(true);
check('导出 isFacility', typeof M.isFacility === 'function');

// 正例：设施后缀（总监点名词表）
const CASES = [
  ['承德避暑山庄及其周围寺庙', '承德避暑山庄及其周围寺庙游客服务中心', '游客服务中心'],
  ['南阳武侯祠', '南阳武侯祠警务工作站', '警务工作站'],
  ['南阳武侯祠', '南阳武侯祠派出所', '派出所'],
  ['保国寺', '保国寺停车场', '停车场'],
  ['故宫', '故宫游客服务中心', '游客服务中心'],
  ['故宫', '故宫售票处', '售票处'],
  ['明孝陵', '明孝陵检票口', '检票口'],
  ['泰山', '泰山索道', '索道'],
  ['西湖', '西湖码头', '码头'],
  ['灵隐寺', '灵隐寺商店', '商店'],
  ['灵隐寺', '灵隐寺餐厅', '餐厅'],
  ['灵隐寺', '灵隐寺厕所', '厕所'],
  ['明孝陵', '明孝陵公交站', '公交站'],
  ['明孝陵', '明孝陵地铁站', '地铁站'],
  ['良渚遗址-莫角山遗址', '良渚遗址-莫角山遗址游客服务中心', '游客服务中心'],
];
for (const [t, c, w] of CASES) {
  check('设施点：' + t + ' → ' + c, M.isFacility(t, c) === true, 'word=' + w);
}

// 负例：身份词 / 非前缀 / 同名 / 空
const NEG = [
  ['故宫', '故宫博物院'],
  ['故宫', '故宫'],
  ['良渚遗址-莫角山遗址', '良渚古城遗址公园'],
  ['保国寺', '保国寺古建筑博物馆'],
  ['保国寺', '保国寺森林公园'],
  ['南阳武侯祠', '南阳市武侯祠'],
  ['南阳武侯祠', '成都武侯祠博物馆'],
  ['', '游客服务中心'],
  ['消防', ''],
];
for (const [t, c] of NEG) {
  check('非设施：' + (t || '（空）') + ' → ' + (c || '（空）'), M.isFacility(t, c) === false);
}

// 评分：设施点 simAdj ≤ 0.5 且不吃类型加成
const facCand = { name: '承德避暑山庄及其周围寺庙游客服务中心', lon: 117.94, lat: 40.99, rank: 2 };
const fac = M.scoreCandidate('承德避暑山庄及其周围寺庙', ['承德避暑山庄及其周围寺庙'], facCand,
  { refLon: 117.94, refLat: 40.99, source: 'name', rankFn: () => 2 });
check('设施点：facility=true 且词正确', fac.facility === true && fac.facilityWord === '游客服务中心',
  JSON.stringify({ facility: fac.facility, word: fac.facilityWord }));
check('设施点：simAdj ≤ 0.5', fac.simAdj <= 0.5 + 1e-9, String(fac.simAdj));
check('设施点：不吃类型加成（rank2 也 mult=1）', fac.mult === 1, String(fac.mult));
check('设施点：simAdj 仍低于强证据线', fac.simAdj < M.CALIBRATION.NAME_STRONG_SIM);

// pick：设施点永不当结果
const tgt = { name: '承德避暑山庄及其周围寺庙', lon: 117.94, lat: 40.99 };
const mixed = M.pick(tgt, [
  { name: '承德避暑山庄及其周围寺庙游客服务中心', lon: 117.94, lat: 40.99, rank: 2 },
  { name: '避暑山庄', lon: 117.94, lat: 40.995, rank: 2 },
], { rank: c => c.rank });
check('pick 跳过设施点，取非设施本体', !!mixed && mixed.poi.name === '避暑山庄', mixed ? mixed.poi.name : 'null');
const onlyFac = M.pick(tgt, [
  { name: '承德避暑山庄及其周围寺庙游客服务中心', lon: 117.94, lat: 40.99, rank: 2 },
  { name: '承德避暑山庄及其周围寺庙停车场', lon: 117.94, lat: 40.99, rank: 1 },
], { rank: c => c.rank });
check('负例：只有设施候选 → 未匹配（不认设施点）', onlyFac === null, onlyFac ? onlyFac.poi.name : 'null');

// dump 带出 facility 标记
const dump = [];
M.pick(tgt, [{ name: '承德避暑山庄及其周围寺庙游客服务中心', lon: 117.94, lat: 40.99, rank: 2 }],
  { rank: c => c.rank, dump });
check('dump 每条带 facility/facilityWord', dump.length === 1 && dump[0].facility === true && dump[0].facilityWord === '游客服务中心',
  JSON.stringify(dump[0] && { facility: dump[0].facility, word: dump[0].facilityWord }));

// 回测口径静态断言：B 集读扁平 actualPick、A 集排除别名、设施计数存在
const bt = fs.readFileSync(path.join(ROOT, 'tools/backtest-matching.js'), 'utf8');
check('backtest：B 集用扁平 actualPick（不再读 c.after.*）', /c\.actualPick !== undefined \? c\.actualPick : \(c\.after/.test(bt));
check('backtest：summarizeA 有 facilityHit 且排除 alias', /facilityHit/.test(bt) && /if \(c\.alias\)/.test(bt));
check('backtest：B 集有 facilityHit 计数', /facilityHit\+\+/.test(bt));
check('backtest：硬约束含 B 设施命中为 0', /B 集设施命中/.test(bt));

finish();
