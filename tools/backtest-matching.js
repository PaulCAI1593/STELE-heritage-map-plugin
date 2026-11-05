#!/usr/bin/env node
// tools/backtest-matching.js
// #14-L 回测脚本（脚本契约见 02-design/匹配重构/方案-v2.md「回测执行与分工」）。
//
// 用法（参数无隐藏默认值：--kp/--ks/--strong 必须显式传）：
//   node tools/backtest-matching.js --stage L --kp 0.04 --ks 0.02 --strong 0.85 \
//        --out 03-build/开发/证据/task14L [--cases <json>] [--before-src <dir>]
//   node tools/backtest-matching.js --stage S --kp 0.04 --ks 0.02 --strong 0.85 --out <dir>
//   node tools/backtest-matching.js --sweep --stage S ...（35 组：KP 7 档 × KS 5 档）
//
// 输出：<out>/result.json（契约固定结构）+ <out>/report.md（人读表）。
// 退出码：0 = 通过；1 = 硬约束不满足（top1 有差异 / 必需文件缺失 / 数据非法）；2 = 用法错误。
//
// 数据集格式（--cases，默认 tests/fixtures/backtest/cases-L.json）：
// {
//   "meta": {"synthetic": true, "note": "..."},
//   "A": [{id, steleName, expected: "correct"|"wrong"|"unmatched", route, candidates:[{name,lon,lat,rank}]}],
//   "B": [{id, steleName, expected: "institution"|"homonymFalsePick"|"homonymReject", route, candidates:[...]}],
//   "C": [{id, steleName, route, candidates:[...], before: {...}|null, after: {...}|null}]
// }
//
// ⚠️ 阶段 L 只验证「日志/可解释性改动不影响 top1」；KP/KS 惩罚属阶段 S，本阶段不参与打分，
//    因此 --sweep 在 --stage L 下直接判为用法错误（exit 2），避免给出"扫了但没生效"的假结论。

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src/content');
const DEFAULT_CASES = path.join(ROOT, 'tests/fixtures/backtest/cases-L.json');

function usage(msg) {
  if (msg) console.error('用法错误：' + msg);
  console.error('用法: node tools/backtest-matching.js --stage L|S --kp <n> --ks <n> --strong <n> --out <dir> [--cases <json>] [--before-src <dir>] [--sweep]');
  process.exit(2);
}

function parseArgs(argv) {
  const out = { stage: null, kp: null, ks: null, strong: null, out: null, cases: DEFAULT_CASES, beforeSrc: null, sweep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v == null || v.startsWith('--')) usage('参数 ' + a + ' 缺值');
      return v;
    };
    if (a === '--stage') out.stage = val();
    else if (a === '--kp') out.kp = Number(val());
    else if (a === '--ks') out.ks = Number(val());
    else if (a === '--strong') out.strong = Number(val());
    else if (a === '--out') out.out = val();
    else if (a === '--cases') out.cases = path.resolve(val());
    else if (a === '--before-src') out.beforeSrc = path.resolve(val());
    else if (a === '--sweep') out.sweep = true;
    else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 30).join('\n')); process.exit(0); }
    else usage('未知参数 ' + a);
  }
  return out;
}

function loadMatcher(dir) {
  const file = path.join(dir, 'matcher.js');
  if (!fs.existsSync(file)) throw new Error('找不到 matcher.js：' + file);
  const sandbox = { window: { HMP: {} }, console: { log() {}, warn() {}, error() {} }, Math, Number, String, Array, Object, JSON };
  vm.createContext(sandbox);
  // #14-S：核心证据模块必须先于 matcher 加载（与 content_scripts 顺序一致）。
  const neFile = path.join(dir, 'name-evidence.js');
  if (fs.existsSync(neFile)) {
    vm.runInContext(fs.readFileSync(neFile, 'utf8'), sandbox, { filename: neFile });
  }
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  const m = sandbox.window.HMP && sandbox.window.HMP.matcher;
  if (!m || typeof m.pick !== 'function') throw new Error('matcher.js 未导出 matcher.pick');
  return m;
}

// 与业务侧 NAME_MAX_DIST 对齐：名称命中超过 3 km 不采信（runProvider 的闸门）。
const NAME_MAX_DIST = 3000;
function distM(lon1, lat1, lon2, lat2) {
  const R = 6371000, rad = d => d * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function rankOf(c) {
  // 数据集里 rank：2=可参观（文物/景点/博物馆），1=未知，0=设施/商业
  const r = Number(c && c.rank);
  return Number.isFinite(r) ? r : 1;
}

function pickTop1(matcher, c, kp, ks) {
  const target = {
    name: c.steleName,
    nameVariants: Array.isArray(c.nameVariants) && c.nameVariants.length ? c.nameVariants : undefined,
    lon: Number.isFinite(c.targetLon) ? c.targetLon : (c.candidates[0] ? c.candidates[0].lon : null),
    lat: Number.isFinite(c.targetLat) ? c.targetLat : (c.candidates[0] ? c.candidates[0].lat : null),
  };
  const dump = [];
  // 与业务侧一致：设施/商业类（rank 0）在**进入打分前**就被丢弃
  // （card.js 的三路检索都做这个过滤），回测复现同一前置条件。
  const tLon = Number.isFinite(target.lon) ? target.lon : null;
  const tLat = Number.isFinite(target.lat) ? target.lat : null;
  const pool = (c.candidates || []).filter(x => {
    if (rankOf(x) === 0) return false;
    if (tLon != null && tLat != null && Number.isFinite(x.lon) && Number.isFinite(x.lat)) {
      if (distM(tLon, tLat, x.lon, x.lat) > NAME_MAX_DIST) return false;
    }
    return true;
  });
  const m = matcher.pick(target, pool, { rank: rankOf, dump });
  if (!m) return { pick: null, dump };
  return {
    pick: {
      actualPick: m.poi && m.poi.name ? m.poi.name : null,
      score: Number.isFinite(m.score) ? Math.round(m.score * 1e6) / 1e6 : null,
      source: c.route || null,
      sim: Number.isFinite(m.sim) ? Math.round(m.sim * 1e6) / 1e6 : null,
      simAdj: Number.isFinite(m.simAdj) ? Math.round(m.simAdj * 1e6) / 1e6 : (Number.isFinite(m.sim) ? Math.round(m.sim * 1e6) / 1e6 : null),
      dist: Number.isFinite(m.dist) ? Math.round(m.dist) : null,
    },
    dump,
  };
}

let LAST_META = {};

function readCases(file) {
  if (!fs.existsSync(file)) throw new Error('找不到数据集：' + file);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  LAST_META = data.meta || {};
  for (const k of ['A', 'B', 'C']) {
    if (data[k] != null && !Array.isArray(data[k])) throw new Error('数据集 ' + k + ' 必须是数组');
  }
  return data;
}

function classifyABeforeAfter(before, after, expected) {
  const ok = before && after && before.actualPick === after.actualPick;
  const correct = !!(after && expected === 'correct' && after.actualPick);
  return { same: ok, correct };
}

function computeRates(casesB, matcher) {
  let institutionHit = 0, homonymFalsePick = 0, homonymReject = 0, homonymTotal = 0;
  let facilityHit = 0;
  // D-081③：歧义同名点（meta.homonymAmbiguous，如 B13）单列，不计拒识率分母。
  const ambiguousIds = new Set(Array.isArray(LAST_META.homonymAmbiguous) ? LAST_META.homonymAmbiguous : []);
  const homonymAmbiguous = [];
  for (const c of casesB) {
    // runOnce 写的是扁平字段（actualPick 在顶层）；旧版读 c.after.* 恒为 undefined，
    // 导致 B 集机构/同名命中永远统计为 0（总监复验时发现的口径问题）。
    const pickName = c.actualPick !== undefined ? c.actualPick : (c.after ? c.after.actualPick : null);
    const fac = !!(pickName && isFacilityPick(matcher, c.steleName, pickName));
    if (fac) facilityHit++;
    if (c.kind === 'institution') {
      // 设施点不算“机构命中”（它是本体的服务设施，不是办事机构）
      if (pickName && !fac) institutionHit++;
    } else if (c.kind === 'homonym') {
      if (ambiguousIds.has(c.id)) {
        homonymAmbiguous.push({ id: c.id, steleName: c.steleName, actualPick: pickName == null ? null : pickName });
        continue;
      }
      homonymTotal++;
      if (pickName && !fac) homonymFalsePick++;
      else homonymReject++;
    }
  }
  return {
    institutionHit,
    homonymFalsePick,
    facilityHit,
    homonymAmbiguous,
    homonymTotal,
    homonymReject,
    homonymRejectRate: homonymTotal ? Math.round((homonymReject / homonymTotal) * 1000) / 1000 : null,
  };
}

function commitOf(dir) {
  try {
    const { execSync } = require('child_process');
    return execSync('git rev-parse --short HEAD', { cwd: dir, encoding: 'utf8' }).trim();
  } catch (e) { return null; }
}

function runOnce(opts, matcher) {
  // #14-S：标定参数单出口注入（KP/KS/强证据线），不在 matcher 里写死。
  if (matcher && typeof matcher.setCalibration === 'function') {
    matcher.setCalibration({ KP: opts.kp, KS: opts.ks, NAME_STRONG_SIM: opts.strong });
  }
  const data = readCases(opts.cases);
  const cases = { A: [], B: [], C: null, top1Diff: 0 };
  for (const c of data.A || []) {
    const r = pickTop1(matcher, c, opts.kp, opts.ks);
    cases.A.push({
      id: c.id, steleName: c.steleName, expected: c.expected, alias: !!c.alias,
      ...(r.pick || { actualPick: null, score: null, source: c.route || null, sim: null, simAdj: null, dist: null }),
      topCandidates: r.dump.slice(0, 5),
    });
  }
  for (const c of data.B || []) {
    const r = pickTop1(matcher, c, opts.kp, opts.ks);
    cases.B.push({
      id: c.id, steleName: c.steleName, kind: c.kind, expected: c.expected,
      ...(r.pick || { actualPick: null, score: null, source: c.route || null, sim: null, simAdj: null, dist: null }),
    });
  }
  // #20：C 集允许多条用户案例（C01=P13、C02=玄妙观商户错配），逐条跑。
  cases.C = [];
  for (const c of data.C || []) {
    const r = pickTop1(matcher, c, opts.kp, opts.ks);
    cases.C.push({
      id: c.id, steleName: c.steleName, expected: c.expected == null ? null : c.expected,
      candidates: (c.candidates || []).map(x => x && x.name).filter(Boolean),
      before: c.before && Object.keys(c.before).length ? c.before : null,
      after: r.pick,
    });
  }
  return cases;
}

function diffTop1(before, after) {
  let diff = 0;
  const pairs = [];
  for (const k of ['A', 'B']) {
    const b = new Map((before[k] || []).map(x => [x.id, x.actualPick]));
    for (const a of after[k] || []) {
      const p = b.has(a.id) ? b.get(a.id) : undefined;
      if (p !== a.actualPick) diff++;
      pairs.push({ id: a.id, before: p == null ? null : p, after: a.actualPick, same: p === a.actualPick });
    }
  }
  return { diff, pairs };
}

// #22：单条 C 案例判定（期望字段优先）。
//   - expected='unmatched'：必须未匹配；
//   - 候选里有本体：必须选本体（验「本体优先」不被误压）；
//   - expected 含「不得选」：未匹配或非排除点即通过；
//   - 其它：有 pick 且不是排除点即通过。
function verdictOf(matcher, c) {
  const pick = c.after && c.after.actualPick != null ? c.after.actualPick : null;
  const expect = c.expected;
  if (expect === 'unmatched') return { ok: pick === null, why: pick === null ? '未匹配（符合期望）' : '期望未匹配，实际选到 ' + pick };
  const excluded = pick && matcher && typeof matcher.exclusionKindOf === 'function'
    ? matcher.exclusionKindOf(c.steleName, pick) : null;
  if (excluded) return { ok: false, why: '选中被排除点(' + excluded.kind + ')：' + pick };
  const hasSelf = (c.candidates || []).indexOf(c.steleName) >= 0;
  if (hasSelf) return { ok: pick === c.steleName, why: pick === c.steleName ? '选本体' : (pick ? '本体在候选内但选了 ' + pick : '本体在候选内却未匹配') };
  if (typeof expect === 'string' && expect.indexOf('不得选') >= 0) return { ok: pick === null, why: pick === null ? '未匹配（符合期望）' : '期望不选排除点，实际选到 ' + pick };
  return { ok: pick !== null, why: pick === null ? '未匹配' : 'pick 非排除点' };
}

function isFacilityPick(matcher, steleName, pickName) {
  if (!pickName || !matcher || typeof matcher.isFacility !== 'function') return false;
  return matcher.isFacility(steleName, pickName) === true;
}

// #14-S2：A 集统计必须看“选到的实体”，不能只看有没有 pick。
//   facilityHit：选中的是本体+设施后缀（游客服务中心/停车场…），不计 correct。
function summarizeA(cases, matcher) {
  const counts = { correct: 0, wrong: 0, unmatched: 0, facilityHit: 0, alias: 0 };
  for (const c of cases) {
    // D-081：别名点单列，不进 A 的正确率硬约束
    if (c.alias) { counts.alias++; continue; }
    if (!c.actualPick) counts.unmatched++;
    else if (isFacilityPick(matcher, c.steleName, c.actualPick)) {
      counts.facilityHit++;
      counts.wrong++;
    } else if (c.expected === 'correct') counts.correct++;
    else counts.wrong++;
  }
  return counts;
}

function mdTable(rows) {
  if (!rows.length) return '_无案例_';
  const head = '| id | stele | before top1 | after top1 | 一致 |\n|---|---|---|---|---|';
  return head + '\n' + rows.map(r => `| ${r.id} | ${r.steleName} | ${r.before == null ? '（未匹配）' : r.before} | ${r.after == null ? '（未匹配）' : r.after} | ${r.same ? '是' : '**否**'} |`).join('\n');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.stage || !['L', 'S'].includes(opts.stage)) usage('--stage 必须是 L 或 S');
  if (!Number.isFinite(opts.kp) || !Number.isFinite(opts.ks) || !Number.isFinite(opts.strong)) {
    usage('--kp / --ks / --strong 必须显式给数值（无隐藏默认值）');
  }
  if (!opts.out) usage('--out 必传');
  if (opts.sweep && opts.stage === 'L') usage('--sweep 属阶段 S（KP/KS 惩罚尚未引入），阶段 L 不适用');

  const afterMatcher = loadMatcher(SRC);
  const beforeMatcher = opts.beforeSrc ? loadMatcher(opts.beforeSrc) : afterMatcher;

  const outDir = path.resolve(opts.out);
  fs.mkdirSync(outDir, { recursive: true });

  const grid = [];
  if (opts.sweep) {
    for (let kp = 0.02; kp <= 0.0801; kp += 0.01) {
      for (let ks = 0.01; ks <= 0.0501; ks += 0.01) {
        grid.push({ kp: Math.round(kp * 100) / 100, ks: Math.round(ks * 100) / 100 });
      }
    }
  } else {
    grid.push({ kp: opts.kp, ks: opts.ks });
  }

  const sweepRows = [];
  let firstResult = null;
  for (const g of grid) {
    const after = runOnce({ ...opts, kp: g.kp, ks: g.ks }, afterMatcher);
    const before = opts.beforeSrc ? runOnce({ ...opts, kp: g.kp, ks: g.ks }, beforeMatcher) : after;
    const d = diffTop1(before, after);
    if (!firstResult) firstResult = { after, before, d, params: g };
    sweepRows.push({ kp: g.kp, ks: g.ks, A: summarizeA(after.A, afterMatcher), B: computeRates(after.B, afterMatcher), top1Diff: d.diff });
  }

  const hard = [];
  if (!firstResult) hard.push('没有可执行案例');
  const top1Diff = firstResult ? firstResult.d.diff : 0;
  const changedIds = firstResult ? firstResult.d.pairs.filter(p => !p.same).map(p => p.id) : [];
  // 阶段 L 的核心命题是「行为不变」；阶段 S 就是要改变 top1，不以此判失败。
  if (opts.stage === 'L' && top1Diff !== 0) hard.push('top1 差异 ' + top1Diff + ' 条（硬约束要求 0）');
  // 阶段 L 的核心命题是「改动前后行为不变」，缺改前源码就无法证明；阶段 S 是扫参，不强求。
  if (opts.stage === 'L' && !opts.beforeSrc) hard.push('未提供 --before-src：无法证明「改动前后」（当前 before 与 after 是同一份源码）');

  const result = {
    stage: opts.stage,
    params: { kp: opts.kp, ks: opts.ks, floorP: 0.35, floorS: 0.6, strong: opts.strong },
    commit: commitOf(ROOT),
    A: { counts: summarizeA(firstResult ? firstResult.after.A : [], afterMatcher), cases: firstResult ? firstResult.after.A : [] },
    B: {
      counts: computeRates(firstResult ? firstResult.after.B : [], afterMatcher),
      cases: firstResult ? firstResult.after.B : [],
    },
    C: firstResult ? firstResult.after.C : [],
    D: { suites: [], total: 0, pass: 0, fail: 0, note: '由 npm test 产出，本脚本不代跑' },
    top1Diff,
    // #19：S 阶段把差异定位成「预期」并给出 id；L 阶段仍以 0 为硬约束。
    expectedDiff: opts.stage === 'S'
      ? { count: top1Diff, ids: changedIds, note: '设施硬压带来的改善/未匹配，不作硬约束' }
      : null,
    beforeAfter: firstResult ? firstResult.d.pairs : [],
    metadata: {
      generatedAt: new Date().toISOString(),
      cases: path.relative(ROOT, opts.cases),
      beforeSrc: opts.beforeSrc ? path.relative(ROOT, opts.beforeSrc) : null,
      sweep: opts.sweep,
      stageNote: opts.stage === 'L'
        ? '阶段 L：只验证日志/可解释性改动不影响 top1；KP/KS 不参与打分（simAdj=sim）'
        : '阶段 S：KP/KS 参与评分（由后续 commit 实现；当前 matcher 未变更时不生效）',
    },
  };
  // #22：C 集逐条判定（verdict 用 expected 字段 + 候选里是否有本体），任一条不符即硬约束失败。
  //   L/S 两个阶段都判：C 是用户真机案例，不允许静默只报第一条。
  result.C = (result.C || []).map(cc => Object.assign({}, cc, { verdict: verdictOf(afterMatcher, cc) }));
  for (const cc of result.C) {
    if (!cc.verdict.ok) hard.push(cc.id + ' 不符：' + cc.verdict.why);
  }

  // ── #14-S：阶段 S 的验收计数与强证据线三档 ──
  let strongSweep = null;
  if (opts.stage === 'S') {
    const beforeCounts = opts.beforeSrc
      ? summarizeA(runOnce({ ...opts, kp: opts.kp, ks: opts.ks }, beforeMatcher).A, afterMatcher) : null;
    const aCounts = result.A.counts;
    if (beforeCounts && aCounts.correct < beforeCounts.correct) {
      hard.push('A 集正确数下降：' + beforeCounts.correct + ' → ' + aCounts.correct);
    }
    if (result.B.counts.institutionHit !== 0) hard.push('B 集机构命中 ' + result.B.counts.institutionHit + '（要求 0）');
    if (result.B.counts.facilityHit !== 0) hard.push('B 集设施命中 ' + result.B.counts.facilityHit + '（要求 0）');
    if (result.B.counts.homonymFalsePick !== 0) hard.push('B 集远同名误选 ' + result.B.counts.homonymFalsePick + '（要求 0）');
    strongSweep = [];
    for (const st of [0.75, 0.80, 0.85]) {
      const r = runOnce({ ...opts, kp: opts.kp, ks: opts.ks, strong: st }, afterMatcher);
      strongSweep.push({ strong: st, A: summarizeA(r.A, afterMatcher), B: computeRates(r.B, afterMatcher), C: (r.C || []).map(c => c.after) });
    }
    result.strongSweep = strongSweep;
    result.beforeCounts = beforeCounts;
    if (opts.sweep) {
      // 连通块：A 正确数最大且 B 机构命中为 0 的格子里，4 邻接成块大小。
      const key = (kp, ks) => kp.toFixed(2) + '/' + ks.toFixed(2);
      const cells = new Map(sweepRows.map(r => [key(r.kp, r.ks), r]));
      const maxCorrect = Math.max(...sweepRows.map(r => r.A.correct));
      const okSet = new Set(sweepRows.filter(r => r.A.correct === maxCorrect && r.B.institutionHit === 0 && r.B.facilityHit === 0).map(r => key(r.kp, r.ks)));
      const kps = [...new Set(sweepRows.map(r => r.kp))].sort((a, b) => a - b);
      const kss = [...new Set(sweepRows.map(r => r.ks))].sort((a, b) => a - b);
      const seen = new Set();
      const blocks = [];
      for (const k of okSet) {
        if (seen.has(k)) continue;
        const stack = [k]; seen.add(k);
        const members = [];
        while (stack.length) {
          const cur = stack.pop(); members.push(cur);
          const [ckp, cks] = cur.split('/').map(Number);
          const nb = [
            key(ckp, cks - 0.01), key(ckp, cks + 0.01),
            key(ckp - 0.01, cks), key(ckp + 0.01, cks),
          ];
          for (const n of nb) {
            if (okSet.has(n) && !seen.has(n)) { seen.add(n); stack.push(n); }
          }
        }
        blocks.push({ size: members.length, members: members.sort() });
      }
      blocks.sort((a, b) => b.size - a.size);
      const gridJson = {
        stage: 'S', params: { kp: opts.kp, ks: opts.ks, strong: opts.strong },
        criteria: 'A.correct 最大 且 B.institutionHit=0 且 B.facilityHit=0',
        groups: sweepRows.length, maxCorrect,
        blocks, largestBlock: blocks.length ? blocks[0].size : 0,
        rows: sweepRows,
        kpAxis: kps, ksAxis: kss,
      };
      fs.writeFileSync(path.join(outDir, 'grid.json'), JSON.stringify(gridJson, null, 2));
      result.grid = { groups: sweepRows.length, maxCorrect, largestBlock: gridJson.largestBlock, blocks: blocks.slice(0, 5) };
    }
  }

  if (opts.sweep && sweepRows.length !== 35) hard.push('扫参组数 ' + sweepRows.length + ' ≠ 35');

  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));

  const md = [
    '# 匹配回测报告（' + opts.stage + ' 阶段）',
    '',
    '- 生成时间：' + result.metadata.generatedAt,
    '- 参数：kp=' + opts.kp + '，ks=' + opts.ks + '，strong=' + opts.strong + '，floorP=0.35，floorS=0.6',
    '- 数据集：`' + result.metadata.cases + '`' + (result.metadata.beforeSrc ? '；改前源码：`' + result.metadata.beforeSrc + '`' : ''),
    opts.stage === 'L'
      ? '- top1 差异：**' + top1Diff + '** 条（硬约束 = 0）'
      : '- 预期差异：**' + top1Diff + '** 条（' + (changedIds.length ? changedIds.join('、') : '无') + '；设施硬压带来的改善/未匹配，不作硬约束）',
    '- 说明：' + result.metadata.stageNote,
    '',
    '## A 集（' + result.A.counts.correct + ' 正确 / ' + result.A.counts.wrong + ' 错误 / ' + result.A.counts.unmatched + ' 未匹配 / ' + result.A.counts.facilityHit + ' 设施误配）',
    '',
    mdTable(firstResult ? firstResult.d.pairs.filter(p => (firstResult.after.A || []).some(a => a.id === p.id)) : []),
    '',
    '## B 集（机构命中 ' + result.B.counts.institutionHit + ' / 设施命中 ' + result.B.counts.facilityHit + ' / 远同名误选 ' + result.B.counts.homonymFalsePick
      + ' / 拒识率 ' + result.B.counts.homonymRejectRate + ' = 拒绝 ' + result.B.counts.homonymReject + ' / 有效 ' + result.B.counts.homonymTotal
      + '；歧义同名单列 ' + ((result.B.counts.homonymAmbiguous || []).length) + ' 条不计分母）',
    '',
    '| id | stele | 期望 | after top1 |',
    '|---|---|---|---|',
    ...(result.B.cases.length ? result.B.cases.map(c => `| ${c.id} | ${c.steleName} | ${c.expected} | ${c.actualPick == null ? '（未匹配）' : c.actualPick} |`) : ['_无案例_']),
    '',
    ...((result.B.counts.homonymAmbiguous || []).length
      ? ['### 歧义同名（不计入拒识率分母）', '',
         '| id | stele | after top1 |', '|---|---|---|',
         ...result.B.counts.homonymAmbiguous.map(a => '| ' + a.id + ' | ' + a.steleName + ' | ' + (a.actualPick == null ? '（未匹配）' : a.actualPick) + ' |'), '']
      : []),
    '## C 集（用户真机案例）',
    '',
    ...(result.C && result.C.length
      ? ['| id | stele | expected | pick | sim | dist | source | verdict |', '|---|---|---|---|---|---|---|---|',
         ...result.C.map(c => '| ' + c.id + ' | ' + c.steleName + ' | ' + (c.expected == null ? '—' : c.expected) + ' | '
           + (c.after && c.after.actualPick ? c.after.actualPick : '（未匹配）') + ' | '
           + (c.after && c.after.sim != null ? c.after.sim : '—') + ' | '
           + (c.after && c.after.dist != null ? c.after.dist + ' m' : '—') + ' | '
           + (c.after && c.after.source ? c.after.source : '—') + ' | '
           + (c.verdict.ok ? '✅ ' : '❌ ') + c.verdict.why + ' |')]
      : ['_无案例_']),
    '',
  ];
  if (opts.sweep) {
    md.push('## 扫参 ' + sweepRows.length + ' 组', '', '| kp | ks | 正确 | 错误 | 未匹配 | 机构命中 | top1差异 |', '|---|---|---|---|---|---|---|');
    for (const r of sweepRows) md.push(`| ${r.kp} | ${r.ks} | ${r.A.correct} | ${r.A.wrong} | ${r.A.unmatched} | ${r.B.institutionHit} | ${r.top1Diff} |`);
    md.push('');
  }
  md.push(opts.stage === 'S' ? '## 硬约束（S 阶段不含 top1 差异）' : '## 硬约束', '');
  md.push(hard.length ? hard.map(h => '- ❌ ' + h).join('\n') : '- ✅ 全部满足');
  fs.writeFileSync(path.join(outDir, 'report.md'), md.join('\n') + '\n');

  console.log('result.json → ' + path.join(outDir, 'result.json'));
  console.log('report.md   → ' + path.join(outDir, 'report.md'));
  console.log('top1Diff=' + top1Diff + ' A=' + JSON.stringify(result.A.counts) + ' B=' + JSON.stringify(result.B.counts));
  console.log('C=' + JSON.stringify((result.C || []).map(c => ({ id: c.id, pick: c.after && c.after.actualPick }))));
  if (hard.length) {
    console.error('硬约束未满足：\n- ' + hard.join('\n- '));
    process.exit(1);
  }
  process.exit(0);
}

try { main(); } catch (e) {
  console.error('回测失败：' + (e && e.stack || e));
  process.exit(1);
}
