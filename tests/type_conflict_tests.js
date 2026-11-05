// tests/type_conflict_tests.js
// #29 · 类型词冲突（十里庙遗址 ≠ 十里庙清真寺）与地名兜底（十里庙 → 南阳十里庙）
//   规则：
//   ① 类型词从原始名识别（不剥噪声）：双侧有类型词、族不同且非兼容 ⇒ 冲突，
//      simAdj≤0.5、不吃类型加成、pick/统一池跳过；
//   ② 候选包含目标（…遗址文化园 ⊃ …遗址）= 同址强证据 simAdj≥0.92，tier 2；
//   ③ 目标包含候选（白马寺遗址 ⊃ 白马寺）= 兼容按原分；
//   ④ 候选无类型词、名字含目标地名核心 ⇒ weakMatch（tier 0，卡片一律给距离提示）。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const env = require('./_env');
const { check, finish } = env.makeChecker('type');

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

check('导出 typeFamilyOf / typeConflictOf / sameSiteOf', typeof M.typeFamilyOf === 'function'
  && typeof M.typeConflictOf === 'function' && typeof M.sameSiteOf === 'function');

// 真机日志：STELE「十里庙遗址」（target 112.509,33.034），候选距离 664/328/340/651/46219 m
const target = { name: '十里庙遗址', lon: 112.509, lat: 33.034 };
function at(name, meters, rank) {
  return { name, lon: target.lon, lat: target.lat + meters / 111320, rank: rank == null ? 1 : rank };
}
const REAL = [
  at('十里庙清真寺', 664, 1),
  at('南阳十里庙', 328, 1),
  at('十里庙民生副食店', 340, 0),
  at('十里庙小卖部', 651, 0),
  at('方城十里庙公墓', 46219, 1),
];
const rank = c => c.rank;

// ---- ① 真实 5 候选：清真寺/商户/公墓全排除，兜底到地名「南阳十里庙」 ----
const dump1 = [];
const p1 = M.pick(target, REAL, { rank, dump: dump1 });
check('①真实 5 候选：pick = 南阳十里庙（地名兜底 328 m）', !!p1 && p1.poi.name === '南阳十里庙',
  p1 ? p1.poi.name : 'null');
check('①地名兜底标 weakMatch + tier 0 + 不是 exact',
  !!p1 && p1.weakMatch === true && p1.tier === 0 && p1.exactName === false,
  p1 ? JSON.stringify({ weak: p1.weakMatch, tier: p1.tier, exact: p1.exactName }) : 'null');
check('①距离约 328 m', !!p1 && Math.abs(p1.dist - 328) <= 2, p1 ? String(Math.round(p1.dist)) : 'null');
const get = n => dump1.find(d => d.name === n) || {};
check('①清真寺 dump：typeConflict + site/religion 族',
  get('十里庙清真寺').typeConflict === true
  && get('十里庙清真寺').typeFamily.target === 'site'
  && get('十里庙清真寺').typeFamily.cand === 'religion',
  JSON.stringify(get('十里庙清真寺').typeFamily));
check('①副食店/小卖部 dump：借用名被排除（商户路径或类型冲突）', (() => {
  const a = get('十里庙民生副食店'), b = get('十里庙小卖部');
  const bad = x => x.excludeKind === 'merchant' || x.typeConflict === true;
  return bad(a) && bad(b);
})(), JSON.stringify([get('十里庙民生副食店').excludeKind, get('十里庙小卖部').typeConflict]));
check('①公墓 dump：typeConflict（site/funeral）', get('方城十里庙公墓').typeConflict === true,
  JSON.stringify(get('方城十里庙公墓').typeFamily));

// ---- ② 加「十里庙遗址文化园」200 m：同址强证据压过地名兜底 ----
const withPark = REAL.concat([at('十里庙遗址文化园', 200, 2)]);
const p2 = M.pick(target, withPark, { rank });
check('②加文化园：pick = 十里庙遗址文化园（同址强证据 tier 2）',
  !!p2 && p2.poi.name === '十里庙遗址文化园', p2 ? p2.poi.name : 'null');
check('②同址强证据 simAdj ≥ 0.92、sameSite true、非 exact',
  !!p2 && p2.sameSite === true && p2.simAdj >= 0.92 && p2.exactName === false,
  p2 ? JSON.stringify({ same: p2.sameSite, simAdj: p2.simAdj, exact: p2.exactName }) : 'null');
check('②文化园不显示坐标偏差（3 km 内）', !!p2 && p2.dist < 3000,
  p2 ? String(Math.round(p2.dist)) : 'null');

// ---- ③ 只剩异类候选：清真寺/副食店/小卖部/公墓 → 未匹配 ----
const onlyBad = [REAL[0], REAL[2], REAL[3], REAL[4]];
const p3 = M.pick(target, onlyBad, { rank });
check('③只剩异类 → 未匹配（不认清真寺/商户/公墓）', p3 === null, p3 ? p3.poi.name : 'null');

// ---- ④ 兼容：白马寺遗址 ⊃ 白马寺（目标包含候选，按原分） ----
const t4 = { name: '白马寺遗址', lon: 112.6, lat: 34.7 };
const c4 = [{ name: '白马寺', lon: 112.6, lat: 34.7009, rank: 2 }];
const p4 = M.pick(t4, c4, { rank });
const f4 = M.typeConflictOf('白马寺遗址', '白马寺');
check('④白马寺遗址 ⊃ 白马寺：不判冲突（targetContains）',
  !!f4 && f4.conflict === false && f4.targetContains === true, JSON.stringify(f4));
check('④命中白马寺（100 m）', !!p4 && p4.poi.name === '白马寺', p4 ? p4.poi.name : 'null');

// ---- ⑤ 既有正例不回退 ----
function pickOne(tName, cName, meters) {
  const t = { name: tName, lon: 112.5, lat: 33.0 };
  return M.pick(t, [{ name: cName, lon: t.lon, lat: t.lat + meters / 111320, rank: 2 }], { rank });
}
const r1 = pickOne('靳岗天主教堂', '天主堂', 6193);
check('⑤靳岗天主教堂 → 天主堂 6.2 km（短名不回退）', !!r1 && r1.poi.name === '天主堂' && r1.shortForm === true,
  r1 ? JSON.stringify({ n: r1.poi.name, short: r1.shortForm }) : 'null');
const r2 = pickOne('南阳武侯祠', '南阳武侯祠', 143);
check('⑤南阳武侯祠 → 本体（exact 不回退）', !!r2 && r2.poi.name === '南阳武侯祠' && r2.exactName === true,
  r2 ? r2.poi.name : 'null');
const r3 = pickOne('玄妙观', '玄妙观', 0);
check('⑤玄妙观 → 本体', !!r3 && r3.poi.name === '玄妙观', r3 ? r3.poi.name : 'null');
const r4 = pickOne('上海国际饭店', '上海国际饭店', 0);
check('⑤上海国际饭店 → 本体（类型词饭店不误杀）', !!r4 && r4.poi.name === '上海国际饭店', r4 ? r4.poi.name : 'null');
const m5 = M.scoreCandidate('马勒住宅', ['马勒住宅'],
  { name: '上海马勒别墅饭店', lon: 112.5, lat: 33.0011, rank: 2 }, { rank });
check('⑤马勒住宅 → 上海马勒别墅饭店：不被新规则丢弃（exclusionKind 空、无类型冲突）',
  m5 && m5.excludeKind === '' && m5.typeConflict === false && Number.isFinite(m5.score),
  JSON.stringify({ ex: m5 && m5.excludeKind, tc: m5 && m5.typeConflict, score: m5 && m5.score }));
const r6 = pickOne('高平铁佛寺', '铁佛寺', 80);
check('⑤高平铁佛寺 → 铁佛寺（短名不回退）', !!r6 && r6.poi.name === '铁佛寺' && r6.shortForm === true,
  r6 ? r6.poi.name : 'null');
const r7 = pickOne('上海城隍庙', '城隍庙', 90);
check('⑤上海城隍庙 → 城隍庙（短名不回退）', !!r7 && r7.poi.name === '城隍庙', r7 ? r7.poi.name : 'null');
const r8 = pickOne('天安门广场', '广场', 480);
check('⑤天安门广场 → 广场：不加成（纯通名不作证据）', r8 === null, r8 ? r8.poi.name : 'null');
const r9 = pickOne('河南省博物院', '博物院', 420);
check('⑤河南省博物院 → 博物院：不加成（纯通名不作证据）', r9 === null, r9 ? r9.poi.name : 'null');

// ---- ⑥ 展示口径静态断言：地名兜底 <3 km 也给距离提示；普通匹配仍只在 >3 km 提示 ----
const cardSrc = fs.readFileSync(path.join(SRC, 'card.js'), 'utf8');
check('⑥卡片：地名兜底 weakMatch 一律取距离（不受 3 km 下限限制）',
  /weakMatch && Number\.isFinite\(sc\.dist\)/.test(cardSrc)
  && /Math\.round\(sc\.dist \/ 100\) \/ 10 : distanceKmOf\(sc\.dist\)/.test(cardSrc));
check('⑥卡片：提示仍走 #26 的 distance 文案与 data-hmp-note="distance"',
  /请核对是否同一处/.test(cardSrc) && /'data-hmp-note': 'distance'/.test(cardSrc));
// #29 收尾：expectedDistanceKm 校验的是「点位到选中点的直线距离」（任何距离都取 1 位小数），
// 不是「卡片是否显示提示」；同址/地名兜底 <3 km 也要能锚定数据里的距离。
check('⑥回测：距离校验对任意命中都取 1 位小数（不再以 3 km 为门槛）',
  /function distanceKmOf\(c\) \{[\s\S]{0,200}return Math\.round\(a\.dist \/ 100\) \/ 10;/.test(
    fs.readFileSync(path.join(ROOT, 'tools/backtest-matching.js'), 'utf8')));

finish();
