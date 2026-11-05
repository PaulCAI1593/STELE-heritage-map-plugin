// tests/scoring_v2_tests.js
// #14-S · 评分行为改造：单出口标定、缺席惩罚、类型后置、来源先验、统一取最高
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const env = require('./_env');
const { check, finish } = env.makeChecker('scoring-v2');

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
check('导出 CALIBRATION / setCalibration / scoreCandidate', !!M.CALIBRATION &&
  typeof M.setCalibration === 'function' && typeof M.scoreCandidate === 'function');
check('CALIBRATION 初值齐全（KP/KS/FLOOR_P/FLOOR_S/NAME_STRONG_SIM）',
  ['KP', 'KS', 'FLOOR_P', 'FLOOR_S', 'NAME_STRONG_SIM'].every(k => k in M.CALIBRATION),
  JSON.stringify(M.CALIBRATION));
check('来源先验 name 1.0 / address 0.85 / nearby 0.75',
  M.SOURCE_PRIOR.name === 1 && M.SOURCE_PRIOR.address === 0.85 && M.SOURCE_PRIOR.nearby === 0.75,
  JSON.stringify(M.SOURCE_PRIOR));

// 单出口：setCalibration 生效；非法值忽略
M.setCalibration({ KP: 0.06 });
check('setCalibration 改已知数值键', M.CALIBRATION.KP === 0.06, String(M.CALIBRATION.KP));
M.setCalibration({ KP: 'x', UNKNOWN: 1 });
check('负例：非法值/未知键被忽略', M.CALIBRATION.KP === 0.06 && !('UNKNOWN' in M.CALIBRATION));
M.setCalibration({ KP: 0.04, KS: 0.02, FLOOR_P: 0.35, FLOOR_S: 0.6, NAME_STRONG_SIM: 0.85 });

// 缺席惩罚：P13 边界（前缀 3 字）→ simAdj = sim × max(0.35,1-0.04×3)
const cand = { name: '南阳市武侯祠', lon: 112.53, lat: 32.99, rank: 2 };
const base = M.scoreCandidate('南阳武侯祠', ['南阳武侯祠'], cand,
  { refLon: 112.53, refLat: 32.99, source: 'name', rankFn: () => 2 });
const expFac = Math.max(0.35, 1 - 0.04 * 3);
check('缺席惩罚：simAdj = sim × max(FLOOR_P,1-KP×prefix) × max(FLOOR_S,1-KS×suffix)',
  Math.abs(base.simAdj - base.sim * expFac) < 1e-9 &&
  Math.abs(base.absence - expFac) < 1e-9,
  JSON.stringify({ sim: base.sim, simAdj: base.simAdj, absence: base.absence }));
check('simAdj 不超过 sim（惩罚只降不升）', base.simAdj <= base.sim + 1e-9, String(base.simAdj));

// 类型加成后置：simAdj 未到强证据线时 rank2 不吃 1.12
const weak = M.scoreCandidate('南阳武侯祠', ['南阳武侯祠'], { name: '南阳市武侯祠', lon: 112.53, lat: 32.99 },
  { refLon: 112.53, refLat: 32.99, source: 'name', rankFn: () => 2 });
check('类型加成后置：simAdj<强证据线时 mult=1', weak.simAdj < M.CALIBRATION.NAME_STRONG_SIM && weak.mult === 1,
  JSON.stringify({ simAdj: weak.simAdj, mult: weak.mult }));

// 机关类：即使 rankFn 给 2 也降为 rank1，不吃 1.12
const inst = M.scoreCandidate('南阳武侯祠', ['南阳武侯祠'], { name: '南阳市武侯祠管理处', lon: 112.53, lat: 32.99 },
  { refLon: 112.53, refLat: 32.99, source: 'name', rankFn: () => 2 });
check('机关类 typeRank 降为 1、不吃 1.12（保留原有机构后缀 0.85 降权）',
  inst.typeRank === 1 && inst.mult === 0.85,
  JSON.stringify({ typeRank: inst.typeRank, mult: inst.mult }));

// 来源先验：同一候选、同一 sim，address 得分 = name × 0.85
const viaName = M.scoreCandidate('南阳市博物馆', ['南阳市博物馆'], { name: '南阳市博物馆', lon: 112.5, lat: 33 },
  { refLon: 112.5, refLat: 33, source: 'name', rankFn: () => 2 });
const viaAddr = M.scoreCandidate('南阳市博物馆', ['南阳市博物馆'], { name: '南阳市博物馆', lon: 112.5, lat: 33 },
  { refLon: 112.5, refLat: 33, source: 'address', rankFn: () => 2 });
check('来源先验：同名同距下 address 分 = name 分 × 0.85',
  Math.abs(viaAddr.score / viaName.score - 0.85) < 1e-9,
  JSON.stringify({ name: viaName.score, address: viaAddr.score }));

// 无核心证据（弃权）时退化为旧行为 simAdj=sim，保证不影响既有语义
const none = M.scoreCandidate('南阳武侯祠', ['南阳武侯祠'], { name: '完全不相干的商铺', lon: 112.53, lat: 32.99 },
  { refLon: 112.53, refLat: 32.99, source: 'name', rankFn: () => 1 });
check('负例：核心弃权时不施加缺席惩罚（simAdj=sim）', none.abstain === false ||
  Math.abs(none.simAdj - none.sim) < 1e-9, JSON.stringify({ abstain: none.abstain, simAdj: none.simAdj }));

// 统一取最高：三路候选合并后按同一公式比较（用 pick 的 source 先验模拟）
const cands = [
  { name: '南阳市武侯祠', lon: 112.53, lat: 32.99, rank: 2 },
  { name: '南阳市武侯祠管理处', lon: 112.53, lat: 32.99, rank: 2 },
];
const dump = [];
const picked = M.pick({ name: '南阳武侯祠', lon: 112.53, lat: 32.99, nameVariants: ['南阳武侯祠'] },
  cands, { rank: c => (c.rank == null ? 1 : c.rank), dump });
check('pick：机关类候选不会因类型加成压过本体', !!picked && picked.poi.name === '南阳市武侯祠',
  picked ? picked.poi.name : 'null');
check('pick dump 含统一评分的可解释字段（simAdj/absence/sourcePrior）',
  dump.length > 0 && ['simAdj', 'absence', 'sourcePrior', 'mult'].every(k => k in dump[0]),
  JSON.stringify(Object.keys(dump[0] || {})));

// 加载链：manifest 必须在 matcher 之前加载 name-evidence.js
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/manifest.json'), 'utf8'));
const js = (manifest.content_scripts || []).flatMap(cs => cs.js || []);
const iNe = js.indexOf('content/name-evidence.js');
const iMatcher = js.indexOf('content/matcher.js');
check('manifest：name-evidence.js 先于 matcher.js 加载', iNe >= 0 && iMatcher > iNe,
  'name-evidence=' + iNe + ', matcher=' + iMatcher);
// 强证据线读单出口（静态断言：card.js 不再把 0.85 当唯一来源）
const cardSrc = fs.readFileSync(path.join(SRC, 'card.js'), 'utf8');
check('card.js 强证据线读 matcher.CALIBRATION（单出口）',
  /CALIBRATION\.NAME_STRONG_SIM/.test(cardSrc) && /const strongSim = /.test(cardSrc));

// 回测脚本：阶段 S 的验收计数与 NAME_STRONG_SIM 三档在真实数据集上可跑（单独脚本覆盖，这里只查实现）
const bt = fs.readFileSync(path.join(ROOT, 'tools/backtest-matching.js'), 'utf8');
check('回测脚本 stage S：注入 setCalibration', /setCalibration\(\{ KP: opts\.kp/.test(bt));
check('回测脚本 stage S：输出 strongSweep 三档', /for \(const st of \[0\.75, 0\.80, 0\.85\]\)/.test(bt));
check('回测脚本 sweep：写 grid.json 并统计连通块', /grid\.json/.test(bt) && /largestBlock/.test(bt));

finish();
