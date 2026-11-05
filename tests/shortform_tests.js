// tests/shortform_tests.js
// #27 · 短名后缀：候选是 STELE 名的尾部简称（靳岗天主教堂 → 天主堂）
//   规则严格限定：后缀关系（剥通名后比较）+ 候选 ≥3 字 + 前缀 1–4 字 + 剥通名后 ≥2 字专名。
//   simAdj 抬到 0.86，sim 原值不动；设施/商户/行政/机关排除照旧；
//   距离上限与 COORD_DRIFT_MAX_DIST 同源（10000 m）——真实案例天主堂在 6.2 km。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const env = require('./_env');
const { check, finish } = env.makeChecker('shortform');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src/content');

function loadMatcher() {
  const sandbox = { window: { HMP: {} }, console: { log() {}, warn() {}, error() {} }, Math, Number, String, Array, Object, JSON };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(SRC, 'name-evidence.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(SRC, 'matcher.js'), 'utf8'), sandbox);
  return sandbox.window.HMP.matcher;
}
const M = loadMatcher();
check('导出 shortFormOf', typeof M.shortFormOf === 'function');

// ---- 正例：尾部简称，剥通名后仍有专名 ----
const POS = [
  ['靳岗天主教堂', '天主堂', '天主'],
  ['上海城隍庙', '城隍庙', '城隍'],
  ['高平铁佛寺', '铁佛寺', '铁佛'],
  ['南阳武侯祠', '武侯祠', '武侯'],
];
for (const [t, c, core] of POS) {
  const r = M.shortFormOf(t, c);
  check('短名后缀：' + t + ' → ' + c, !!r && r.core === core, JSON.stringify(r));
}
check('短名后缀：前缀长度记 2', ((M.shortFormOf('靳岗天主教堂', '天主堂') || {}).prefixLen) === 2);

// ---- 反例（任务书 §二 必须守住）----
const NEG = [
  ['靳岗天主教堂', '教堂', '泛词：剥「教堂」后没有专名'],
  ['西安城墙', '城墙', '整名就是通名'],
  ['河南省博物院', '博物院', '整名就是通名'],
  ['圣约翰大学近代建筑 白宫', '白宫', '候选 2 字 / 前缀过长'],
  ['天安门广场', '广场', '整名就是通名'],
  ['南阳武侯祠', '成都武侯祠', '不是后缀关系'],
  ['故宫', '故宫博物院', '候选比目标长，不是短名'],
];
for (const [t, c, why] of NEG) {
  check('非短名：' + t + ' → ' + c + '（' + why + '）', M.shortFormOf(t, c) === null);
}

// ---- 打分：simAdj 抬到 0.86，sim 原值不动 ----
const sc = M.scoreCandidate('靳岗天主教堂', ['靳岗天主教堂'], { name: '天主堂', lon: 112.53, lat: 33.0122 }, { refLon: 112.53, refLat: 33.0104, source: 'name' });
check('短名候选 sim 仍是原值 0.5', sc.sim === 0.5, 'sim=' + sc.sim);
check('短名候选 simAdj = 0.86', sc.simAdj === 0.86, 'simAdj=' + sc.simAdj);
check('短名候选 shortForm/shortFormCore', sc.shortForm === true && sc.shortFormCore === '天主', JSON.stringify([sc.shortForm, sc.shortFormCore]));
check('短名不吃排除类型', sc.excludeKind === '' && sc.facility === false);

// 地址路的候选名同样可能"看起来是短名"，但短名只属于名称证据：source=address 不抬分
const scAddr = M.scoreCandidate('靳岗天主教堂', ['靳岗天主教堂'], { name: '天主堂', lon: 112.53, lat: 33.0122 }, { refLon: 112.53, refLat: 33.0104, source: 'address' });
check('地址路不套短名规则', scAddr.shortForm === false && scAddr.simAdj < 0.86, 'simAdj=' + scAddr.simAdj);

// ---- pick：200 m 的短名候选要能采用 ----
const dump = [];
const hit = M.pick({ name: '靳岗天主教堂', lon: 112.53, lat: 33.0104 },
  [{ name: '天主堂', lon: 112.53, lat: 33.0122 }, { name: '教堂', lon: 112.53, lat: 33.0122 }],
  { dump });
check('短名候选被采用（教堂泛词不抢）', !!hit && hit.poi.name === '天主堂', hit && hit.poi.name);
check('采用后 sim 保留 0.5、simAdj 0.86', !!hit && hit.sim === 0.5 && hit.simAdj === 0.86,
  hit && JSON.stringify([hit.sim, hit.simAdj]));
check('dump 记 shortForm/shortFormCore', dump.some(d => d.name === '天主堂' && d.shortForm === true && d.shortFormCore === '天主'),
  JSON.stringify(dump.map(d => [d.name, d.shortForm, d.shortFormCore])));

// ---- 真实案例（用户 0.4.3 决策记录 14/17）：天主堂 6,193 m，靳岗 72 km ----
const realDump = [];
const real = M.pick({ name: '靳岗天主教堂', lon: 112.509, lat: 33.034 }, [
  { name: '靳岗', lon: 112.509, lat: 33.6867 },
  { name: '天主堂', lon: 112.509, lat: 33.0897 },
  { name: '靳岗街道', lon: 112.509, lat: 33.0633 },
  { name: '靳岗乡人民政府', lon: 112.509, lat: 33.0633 },
  { name: '靳岗村', lon: 112.509, lat: 33.1568 },
  { name: '三津汤包(020县道店)', lon: 112.509, lat: 33.0383 },
], { dump: realDump });
check('真实候选：选中天主堂（不被 72 km 的「靳岗」抢走）',
  !!real && real.poi.name === '天主堂', real && real.poi.name);
check('真实候选：6.2 km 在 10 km 内被采用（sim 0.5 / simAdj 0.86 / shortForm true）',
  !!real && real.shortForm === true && real.sim === 0.5 && real.simAdj === 0.86 && real.dist > 6000 && real.dist < 6400,
  real && JSON.stringify([real.sim, real.simAdj, Math.round(real.dist), real.shortForm]));

// ---- pick：>10 km 的短名候选不采用（与 COORD_DRIFT_MAX_DIST 同源）----
const farDump = [];
const far = M.pick({ name: '靳岗天主教堂', lon: 112.53, lat: 33.0104 },
  [{ name: '天主堂', lon: 112.53, lat: 33.1104 }], { dump: farDump });
check('短名候选 >10 km 不采用', far === null, far && far.poi.name);
check('>10 km 的 dump 仍标 shortForm（只是不采用）', farDump[0] && farDump[0].shortForm === true);

// ---- 纯通名候选不作名称证据（C06：教堂 120 / 礼拜堂 260 / 城墙 330 / 博物院 420 / 广场 480）----
const genDump = [];
const gen = M.pick({ name: '靳岗天主教堂', lon: 112.509, lat: 33.034 }, [
  { name: '教堂', lon: 112.509, lat: 33.0351 },
  { name: '礼拜堂', lon: 112.509, lat: 33.0363 },
  { name: '城墙', lon: 112.509, lat: 33.037 },
  { name: '博物院', lon: 112.509, lat: 33.0378 },
  { name: '广场', lon: 112.509, lat: 33.0383 },
], { dump: genDump });
check('纯通名候选全部跳过 → 未匹配（教堂 sim 0.727 也不能过）', gen === null, gen && gen.poi.name);
check('纯通名 dump 标 generic 且不进结果',
  genDump.filter(d => d.generic).length === 5 && genDump.every(d => d.generic !== true || d.poi),
  JSON.stringify(genDump.map(d => [d.name, d.generic])));
check('isGenericName：教堂/城墙/博物院/广场 为纯通名，天主堂/靳岗街道 不是',
  M.isGenericName('靳岗天主教堂', '教堂') === true &&
  M.isGenericName('靳岗天主教堂', '城墙') === true &&
  M.isGenericName('靳岗天主教堂', '博物院') === true &&
  M.isGenericName('靳岗天主教堂', '广场') === true &&
  M.isGenericName('靳岗天主教堂', '天主堂') === false &&
  M.isGenericName('靳岗天主教堂', '靳岗街道') === false);

// ---- pick：exact 不得被短名压过 ----
const exDump = [];
const ex = M.pick({ name: '南阳武侯祠', lon: 112.53, lat: 33.0104 },
  [{ name: '武侯祠', lon: 112.53, lat: 33.0104 }, { name: '南阳武侯祠', lon: 112.53, lat: 33.0112 }], { dump: exDump });
check('exact 优先于短名', !!ex && ex.poi.name === '南阳武侯祠' && ex.exactName === true,
  ex && JSON.stringify([ex.poi.name, ex.exactName]));

// ---- pick：借用（商户/设施）名不得靠短名规则复活 ----
const mDump = [];
const mHit = M.pick({ name: '靳岗天主教堂', lon: 112.53, lat: 33.0104 },
  [{ name: '靳岗天主教堂宰鸡店', lon: 112.53, lat: 33.0105 }], { dump: mDump });
check('商户借用名不因短名规则被采用', mHit === null, mHit && mHit.poi.name);
check('商户借用名 shortForm=false', mDump[0] && mDump[0].shortForm === false, JSON.stringify(mDump[0] && [mDump[0].shortForm, mDump[0].excludeKind]));

finish();
