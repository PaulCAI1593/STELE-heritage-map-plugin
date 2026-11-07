#!/usr/bin/env node
// tests/community_exact_tests.js —— #23 行政社区/服务站排除 + #24 同名优先与坐标偏差
// 只读源码 + vm；不启动浏览器（几何量测在证据脚本里）。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src', 'content');
const matcherSrc = fs.readFileSync(path.join(SRC, 'matcher.js'), 'utf8');
const nameEvSrc = fs.readFileSync(path.join(SRC, 'name-evidence.js'), 'utf8');
const cardSrc = fs.readFileSync(path.join(SRC, 'card.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(SRC, 'content.css'), 'utf8');
const logSrc = fs.readFileSync(path.join(SRC, 'decision-log.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('✅ ' + name); }
  else { fail++; console.log('❌ ' + name + (detail ? '  [' + detail + ']' : '')); }
}

// ---------------- matcher 沙箱 ----------------
const sb = {
  window: { HMP: {} }, console: { log() {}, warn() {} },
  Math, Number, String, Array, Object, JSON, RegExp, Infinity, NaN,
};
vm.createContext(sb);
vm.runInContext(nameEvSrc, sb);
vm.runInContext(matcherSrc, sb);
const M = sb.window.HMP.matcher;

function mk(name, opts) {
  const o = opts || {};
  return { name, lat: o.lat == null ? 33.0021 : o.lat, lon: o.lon == null ? 112.5321 : o.lon, rank: o.rank == null ? 2 : o.rank, type: o.type || '风景名胜' };
}
function pickName(target, cands) {
  const r = M.pick({ name: target, lat: 33.0021, lon: 112.5321 }, cands.map(c => mk(c.name, c)));
  return r && r.poi ? r.poi.name : null;
}

// ---------------- #23 行政社区/服务站 ----------------
console.log('\n=== #23 行政社区/服务站排除 ===');
const ADMIN = [
  '东关街道玄妙观社区退役军人服务站',
  '宛城区东关街道玄妙观社区',
  '玄妙观社区居委会',
  '玄妙观居委会',
];
check('community：四条行政点都判为 community',
  ADMIN.every(n => (M.exclusionKindOf('玄妙观', n) || {}).kind === 'community'),
  JSON.stringify(ADMIN.map(n => M.exclusionKindOf('玄妙观', n))));
check('community：isCommunity 导出且对行政点为 true',
  typeof M.isCommunity === 'function' && ADMIN.every(n => M.isCommunity(n) === true));
check('community：本体（玄妙观）不是社区点', M.isCommunity('玄妙观') === false && M.isCommunity('玄妙观景区') === false);
check('community：仅行政点候选 → 未匹配', pickName('玄妙观', ADMIN.map(name => ({ name }))) === null);
check('community：行政点 + 本体 → 选本体（不被社区名顶掉）',
  pickName('玄妙观', [{ name: '宛城区东关街道玄妙观社区' }, { name: '玄妙观', lon: 112.5320, lat: 33.0020 }]) === '玄妙观');
check('community：行政点 simAdj ≤ 0.5 且不吃类型加成',
  (() => {
    const sc = M.scoreCandidate('玄妙观', ['玄妙观'], mk('东关街道玄妙观社区退役军人服务站'), { refLon: 112.5321, refLat: 33.0021, source: 'name', rankFn: () => 2 });
    return sc.simAdj <= 0.5 && sc.mult === 1 && sc.excludeKind === 'community';
  })());

// ---------------- #24 同名优先 ----------------
console.log('\n=== #24 同名判定 ===');
check('exactName：玄妙观 == 玄妙观', M.isExactName('玄妙观', '玄妙观') === true);
check('exactName：玄妙观 == 玄妙观（含括号补充）', M.isExactName('玄妙观', '玄妙观（南阳市）') === true);
check('exactName：玄妙观 != 玄妙观宰鸡店', M.isExactName('玄妙观', '玄妙观宰鸡店') === false);
check('exactName：scoreCandidate 对同名候选标 exactName',
  M.scoreCandidate('玄妙观', ['玄妙观'], mk('玄妙观', { lat: 33.0621 }), { refLon: 112.5321, refLat: 33.0021, source: 'name', rankFn: () => 2 }).exactName === true);
check('exactName：6.7 km 外的同名候选仍在候选里（不被距离过滤）',
  (() => {
    const r = M.pick({ name: '玄妙观', lat: 33.0021, lon: 112.5321 }, [mk('玄妙观', { lat: 33.0621, lon: 112.5321 })]);
    return !!r && r.poi.name === '玄妙观' && Math.abs(r.dist - 6672) < 400;
  })());
check('COORD_DRIFT_MAX_DIST 导出且为 10000', M.COORD_DRIFT_MAX_DIST === 10000);

// ---------------- 决策日志：exactName / coordinateDriftKm ----------------
console.log('\n=== 决策日志字段 ===');
const logSb = { window: { HMP: {} }, chrome: { runtime: { getManifest: () => ({ version: '0.4.2' }) }, storage: { local: { get(k, cb) { cb({}); }, set(o, cb) { cb && cb(); } } } }, console: { log() {} }, Date, JSON, Math, Object, Array, String, Number };
vm.createContext(logSb);
vm.runInContext(logSrc, logSb);
const DL = logSb.window.HMP.decisionLog;
const entry = {
  stele: { id: 'P13', name: '玄妙观' },
  routes: {
    name: { candCount: 5, bestSim: 1, candidates: [{ name: '玄妙观', sim: 1, dist: 6672, score: 0.672 }, { name: '玄妙观宰鸡店', sim: 1, dist: 614, score: 0.752, excludeKind: 'merchant' }, { name: '玄妙观社区居委会', sim: 1, dist: 154, score: 0.724, excludeKind: 'community' }] },
    address: { candCount: 10, bestSim: 0, candidates: [] },
    nearby: { candCount: 20, bestSim: 0, candidates: [] },
  },
  final: { pickedName: '玄妙观', sim: 1, simAdj: 1, dist: 6672, score: 0.672, source: 'name', exactName: true, coordinateDriftKm: 6.7, why: ['选中「玄妙观」'] },
};
const v2 = DL.__test.normalizeV2(entry);
check('日志：三路候选带 exactName（本体 true / 宰鸡店 false / 社区 false）',
  v2.routes.name.candidates.find(c => c.name === '玄妙观' && c.dist === 6672).exactName === true &&
  v2.routes.name.candidates.find(c => c.name === '玄妙观宰鸡店').exactName === false &&
  v2.routes.name.candidates.find(c => c.name === '玄妙观社区居委会').exactName === false);
check('日志：final.exactName = true', v2.final.exactName === true);
check('日志：final.coordinateDriftKm = 6.7（1 位小数）', v2.final.coordinateDriftKm === 6.7);
check('日志：schema 仍为 2（加字段不升版本）', v2.schema === 2 && DL.__test.normalizeV2({}).schema === 2);

// ---------------- 卡片：显示与 why 语义 ----------------
console.log('\n=== 卡片显示 / why ===');
check('卡片：#68 drift 警示块标题「同名地点，坐标偏差约 X 公里」+ 副行「位置以点位地址为准」',
  /buildAlert\(.drift.,\s*\n?\s*.同名地点，坐标偏差约 /.test(cardSrc) &&
  /位置以点位地址为准/.test(cardSrc) &&
  /hmp-alert/.test(cardSrc));
check('卡片：#68 非 exact 警示块标题「该地点距点位约 X 公里」+ 副行「请核对是否同一处」',
  /buildAlert\(.distance.,/.test(cardSrc) && /该地点距点位约 /.test(cardSrc) && /请核对是否同一处/.test(cardSrc));
const warnSrc = cardSrc.slice(cardSrc.indexOf('const SVG_NS'), cardSrc.indexOf('// ========== 卡片渲染 =========='));
check('卡片：#68 未开放提醒复用同一组件（closure 分支，文字一字不改、无 ⚠ 字符）',
  /buildAlert\('closure',/.test(cardSrc) &&
  /地图信息显示该点位可能不开放（含「' \+ hint \+ '」）/.test(cardSrc) &&
  /建议先电话确认再前往。/.test(cardSrc) &&
  /'⚠ /.test(cardSrc) === false);
check('卡片：#68 警示块含内联 SVG 三角叹号（不用 emoji）',
  /createElementNS\(SVG_NS, .path.\)/.test(warnSrc) && /hmp-alert-ic/.test(warnSrc) &&
  !/[\u26A0\u2757\u26A1]/.test(warnSrc), warnSrc.slice(0, 80));
check('卡片：drift 只在 coordinateDriftKm 非空时渲染',
  /if \(state\.coordinateDriftKm != null\)/.test(cardSrc));
check('卡片：exact 候选放宽到 COORD_DRIFT_MAX_DIST（不是写死 10000）',
  /COORD_DRIFT_MAX_DIST/.test(cardSrc) && /hardLimit/.test(cardSrc));
// #27：排序优先级从「exact 布尔」升级为三档 exact > shortForm > 其余（同档比统一分）。
// #29：三档升级为四档 exact 3 > 同址强证据 2 > shortForm 1 > 其余 0。
check('卡片：exact 候选优先于非同名（#29 四档：exact > 同址 > shortForm > 其余）',
  /const tier = exactCand \? 3 : \(candSame \? 2 : \(candShort \? 1 : 0\)\)/.test(cardSrc) && /tier > best\.tier/.test(cardSrc));
check('卡片：#68 警示块 CSS（浅黄底 #FFF6E8 / 左橙条 3px #D98E32 / 圆角 4 / padding 7px 9px）',
  /#hmp-opening-card \.hmp-alert \{[^}]*background: #FFF6E8/.test(cssSrc) &&
  /#hmp-opening-card \.hmp-alert \{[^}]*border-left: 3px solid #D98E32/.test(cssSrc) &&
  /#hmp-opening-card \.hmp-alert \{[^}]*border-radius: 4px/.test(cssSrc) &&
  /#hmp-opening-card \.hmp-alert \{[^}]*padding: 7px 9px/.test(cssSrc));
check('卡片：#68 标题 13px/600 #7A4A00、副行 11.5px opacity .82、图标 14px #B26A00',
  /#hmp-opening-card \.hmp-alert-title \{[^}]*font-size: 13px/.test(cssSrc) &&
  /#hmp-opening-card \.hmp-alert-title \{[^}]*font-weight: 600/.test(cssSrc) &&
  /#hmp-opening-card \.hmp-alert-title \{[^}]*color: #7A4A00/.test(cssSrc) &&
  /#hmp-opening-card \.hmp-alert-sub \{[^}]*font-size: 11\.5px/.test(cssSrc) &&
  /#hmp-opening-card \.hmp-alert-sub \{[^}]*opacity: \.82/.test(cssSrc) &&
  /#hmp-opening-card \.hmp-alert-ic \{[^}]*width: 14px/.test(cssSrc) &&
  /#hmp-opening-card \.hmp-alert-ic \{[^}]*color: #B26A00/.test(cssSrc));
// 对比度实算：#7A4A00 于 #FFF6E8（WCAG 2.1）
function lum(h){const c=[0,2,4].map(i=>{let v=parseInt(h.slice(i,i+2),16)/255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);});return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2];}
const warnBg=lum('FFF6E8'), warnInk=lum('7A4A00');
const warnCr=+((Math.max(warnBg,warnInk)+0.05)/(Math.min(warnBg,warnInk)+0.05)).toFixed(2);
check('卡片：#68 #7A4A00 于 #FFF6E8 对比度 ≥ 4.5（实算 ' + warnCr + ':1）', warnCr >= 4.5, String(warnCr));
check('why：失败原因只在未命中时写（note && !m）', /if \(note && !m\)/.test(cardSrc) && !/if \(note\) why\.push\(note\)/.test(cardSrc));
check('why：命中时写「选中「…」」事实', /why\.push\('选中「'/.test(cardSrc));
check('payload 带 coordinateDriftKm 并进渲染态', /coordinateDriftKm: \(result\.matched/.test(cardSrc) && /coordinateDriftKm: cacheData\.coordinateDriftKm/.test(cardSrc));

console.log('\n结果: 通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
