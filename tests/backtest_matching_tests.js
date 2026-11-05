// tests/backtest_matching_tests.js
// #14-L：回测脚本契约（tools/backtest-matching.js）
// 运行: node tests/backtest_matching_tests.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const env = require('./_env');
const { check, finish } = env.makeChecker('backtest-matching');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'tools/backtest-matching.js');
const CASES = path.join(ROOT, 'tests/fixtures/backtest/cases-L.json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-bt-'));
// #14-S 语义更新：阶段 L 的「行为不变」现在用「同一份源码」验证（L 的日志改动自身中性）。
// 「跨阶段（#14-L 基线 → #14-S 当前）」的行为差异另测，并如实要求 exit 1。
const beforeDir = path.join(tmp, 'before');
fs.mkdirSync(beforeDir);
fs.copyFileSync(path.join(ROOT, 'src/content/matcher.js'), path.join(beforeDir, 'matcher.js'));
fs.copyFileSync(path.join(ROOT, 'src/content/name-evidence.js'), path.join(beforeDir, 'name-evidence.js'));
const beforeS = path.join(tmp, 'before-S');
fs.mkdirSync(beforeS);
fs.writeFileSync(path.join(beforeS, 'matcher.js'),
  require('child_process').execFileSync('git', ['show', 'b09022a:src/content/matcher.js'], { cwd: ROOT, encoding: 'utf8' }));

function run(args) {
  try {
    const out = execFileSync(process.execPath, [TOOL].concat(args), { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

const base = ['--stage', 'L', '--kp', '0.04', '--ks', '0.02', '--strong', '0.85'];

// 负例①：缺 --kp → 用法错误 exit 2
const miss = run(['--stage', 'L', '--ks', '0.02', '--strong', '0.85', '--out', path.join(tmp, 'x')]);
check('负例：缺 --kp 时 exit 2（无隐藏默认值）', miss.code === 2, 'exit=' + miss.code);

// 负例②：--sweep 配阶段 L 不适用 → exit 2
const sw = run(base.concat(['--sweep', '--out', path.join(tmp, 'y')]));
check('负例：--stage L 下 --sweep 判用法错误', sw.code === 2, 'exit=' + sw.code);

// 负例③：--out 缺失 → exit 2
const noOut = run(base);
check('负例：缺 --out 时 exit 2', noOut.code === 2, 'exit=' + noOut.code);

// 正例：阶段 L + 改前源码 → exit 0，top1 差异 0
const outDir = path.join(tmp, 'ok');
const ok = run(base.concat(['--out', outDir, '--cases', CASES, '--before-src', beforeDir]));
check('阶段 L：exit 0', ok.code === 0, 'exit=' + ok.code + ' ' + ok.out.slice(-200));
const result = JSON.parse(fs.readFileSync(path.join(outDir, 'result.json'), 'utf8'));
check('result.json 契约字段齐全', ['stage', 'params', 'commit', 'A', 'B', 'C', 'D', 'metadata'].every(k => k in result),
  JSON.stringify(Object.keys(result)));
check('A 段含 counts 与 cases', result.A && !!result.A.counts && Array.isArray(result.A.cases),
  JSON.stringify(result.A && result.A.counts));
check('B 段含 counts 与 cases', result.B && !!result.B.counts && Array.isArray(result.B.cases),
  JSON.stringify(result.B && result.B.counts));
check('cases[] 每条字段齐全', result.A.cases.concat(result.B.cases).every(c =>
  ['id', 'steleName', 'actualPick', 'score', 'source', 'sim', 'simAdj', 'dist'].every(k => k in c)),
  JSON.stringify(Object.keys(result.A.cases[0] || {})));
check('改动前后 top1 差异 = 0', result.top1Diff === 0, 'diff=' + result.top1Diff);
// #14-S：与 #14-L 基线（b09022a）比，评分行为应确实改变，且脚本如实以 exit 1 报出差异。
const crossDir = path.join(tmp, 'cross');
const cross = run(base.concat(['--out', crossDir, '--cases', CASES, '--before-src', beforeS]));
const crossResult = JSON.parse(fs.readFileSync(path.join(crossDir, 'result.json'), 'utf8'));
check('跨阶段（b09022a → 当前）：差异如实报告（exit 1 ⇔ top1Diff>0）',
  (cross.code === 1) === (crossResult.top1Diff > 0),
  'exit=' + cross.code + ' diff=' + crossResult.top1Diff);
check('params 如实记录（无隐藏默认）',
  result.params.kp === 0.04 && result.params.ks === 0.02 && result.params.strong === 0.85,
  JSON.stringify(result.params));
check('report.md 已生成', fs.existsSync(path.join(outDir, 'report.md')));

// 正例：--sweep 配阶段 S 生成 35 组
const outSweep = path.join(tmp, 'sweep');
const sweep = run(['--stage', 'S', '--kp', '0.04', '--ks', '0.02', '--strong', '0.85', '--sweep', '--out', outSweep, '--cases', CASES]);
check('阶段 S：--sweep exit 0', sweep.code === 0, 'exit=' + sweep.code + ' ' + sweep.out.slice(-200));
const md = fs.readFileSync(path.join(outSweep, 'report.md'), 'utf8');
check('扫参表 7×5 = 35 行', (md.match(/^\| 0\.0[2-8] \| 0\.0[1-5] \|/gm) || []).length === 35,
  'rows=' + (md.match(/^\| 0\.0[2-8] \| 0\.0[1-5] \|/gm) || []).length);

// 负例④：改前源码与当前不同（模拟行为变化）→ 差异 > 0 时 exit 1
const brokenDir = path.join(tmp, 'broken');
fs.mkdirSync(brokenDir);
fs.writeFileSync(path.join(brokenDir, 'matcher.js'), `
(function(){window.HMP=window.HMP||{};window.HMP.matcher={pick:function(){return null;}};})();`);
const diff = run(base.concat(['--out', path.join(tmp, 'diff'), '--cases', CASES, '--before-src', brokenDir]));
const diffResult = JSON.parse(fs.readFileSync(path.join(tmp, 'diff', 'result.json'), 'utf8'));
check('负例：behavior 改动导致 top1 差异 > 0 → exit 1', diff.code === 1 && diffResult.top1Diff > 0,
  'exit=' + diff.code + ' diff=' + diffResult.top1Diff);

// #22：C 集全量遍历 + 逐条 verdict（不得静默只报 C[0]）
const casesWithC = JSON.parse(fs.readFileSync(CASES, 'utf8'));
casesWithC.C = [
  { id: 'CX1', steleName: '玄妙观', expected: 'unmatched', route: 'name', targetLon: 112.53, targetLat: 33.0,
    candidates: [{ name: '玄妙观宰鸡店', lon: 112.531, lat: 33.001, rank: 1, type: '餐饮' }] },
  { id: 'CX2', steleName: '玄妙观', expected: '不得选商户口', route: 'name', targetLon: 112.53, targetLat: 33.0,
    candidates: [{ name: '玄妙观宰鸡店', lon: 112.531, lat: 33.001, rank: 1, type: '餐饮' },
                 { name: '玄妙观', lon: 112.53, lat: 33.0, rank: 2, type: '风景名胜' }] },
];
const cFile = path.join(tmp, 'cases-c.json');
fs.writeFileSync(cFile, JSON.stringify(casesWithC));
const outC = path.join(tmp, 'c');
const cRun = run(['--stage', 'S', '--kp', '0.04', '--ks', '0.02', '--strong', '0.85', '--out', outC, '--cases', cFile]);
const cRes = JSON.parse(fs.readFileSync(path.join(outC, 'result.json'), 'utf8'));
const cMd = fs.readFileSync(path.join(outC, 'report.md'), 'utf8');
check('#22 C 集遍历全部案例并逐条 verdict（不只 C[0]）',
  cRun.code === 0 && cRes.C.length === 2 && cRes.C.every(c => c.verdict && c.verdict.ok) && /CX1/.test(cMd) && /CX2/.test(cMd),
  'exit=' + cRun.code + ' C=' + JSON.stringify(cRes.C.map(c => ({ id: c.id, ok: c.verdict && c.verdict.ok }))));

// #22b：C 段 drift 校验（expectedDriftKm ± driftToleranceKm，容差缺省 0.05 km）。
// drift 口径与业务侧 final.coordinateDriftKm 一致：仅完全同名且距离 > 3 km 时存在，1 位小数公里。
// target(112.529, 33.004) → 玄妙观(112.529, 33.064003) ≈ 6672 m ⇒ drift 6.7 km。
const driftCases = JSON.parse(fs.readFileSync(CASES, 'utf8'));
const driftC = (id, expectedDriftKm) => ({
  id, steleName: '玄妙观', expected: '玄妙观', route: 'name', targetLon: 112.529, targetLat: 33.004,
  expectedDriftKm, driftToleranceKm: 0.05,
  candidates: [{ name: '玄妙观', lon: 112.529, lat: 33.064003, rank: 2, type: '风景名胜' }],
});
driftCases.C = [driftC('CD1', 6.7)];
const dFile = path.join(tmp, 'cases-drift-ok.json');
fs.writeFileSync(dFile, JSON.stringify(driftCases));
const outD = path.join(tmp, 'd');
const dRun = run(base.concat(['--out', outD, '--cases', dFile, '--before-src', beforeDir]));
const dRes = JSON.parse(fs.readFileSync(path.join(outD, 'result.json'), 'utf8'));
const dMd = fs.readFileSync(path.join(outD, 'report.md'), 'utf8');
check('#22b C 段 drift 在期望容差内 → exit 0，result/report 列出 drift',
  dRun.code === 0 && dRes.C[0].drift === 6.7 && dRes.C[0].verdict.ok && /6\.7 km/.test(dMd),
  'exit=' + dRun.code + ' drift=' + (dRes.C[0] && dRes.C[0].drift) + ' verdict=' + JSON.stringify(dRes.C[0] && dRes.C[0].verdict));

// 负例：期望 5.0 km 而实际 6.7 km（差 1.7 ≫ 0.05）⇒ 该条失败、整体 exit 1。
driftCases.C = [driftC('CD1', 6.7), driftC('CD2', 5.0)];
const dBadFile = path.join(tmp, 'cases-drift-bad.json');
fs.writeFileSync(dBadFile, JSON.stringify(driftCases));
const outDBad = path.join(tmp, 'd-bad');
const dBadRun = run(base.concat(['--out', outDBad, '--cases', dBadFile, '--before-src', beforeDir]));
const dBadRes = JSON.parse(fs.readFileSync(path.join(outDBad, 'result.json'), 'utf8'));
const dOk = dBadRes.C.find(c => c.id === 'CD1');
const dBad = dBadRes.C.find(c => c.id === 'CD2');
check('#22b C 段 drift 超出容差 → 该条失败且整体 exit 1（不靠放宽容差掩盖）',
  dBadRun.code === 1 && dOk && dOk.verdict.ok && dBad && !dBad.verdict.ok && /超出期望/.test(dBad.verdict.why),
  'exit=' + dBadRun.code + ' CD1=' + JSON.stringify(dOk && dOk.verdict) + ' CD2=' + JSON.stringify(dBad && dBad.verdict));

// #22b 附：forbiddenPicks 命中直接判失败（C02c 用；即使 expected 本身允许该点也不放过）。
const forbCases = JSON.parse(fs.readFileSync(CASES, 'utf8'));
forbCases.C = [{
  id: 'CF1', steleName: '玄妙观', expected: '玄妙观', route: 'name', targetLon: 112.529, targetLat: 33.004,
  forbiddenPicks: ['玄妙观'], candidates: [{ name: '玄妙观', lon: 112.529, lat: 33.004, rank: 2 }],
}];
const fFile = path.join(tmp, 'cases-forbidden.json');
fs.writeFileSync(fFile, JSON.stringify(forbCases));
const outF = path.join(tmp, 'f');
const fRun = run(base.concat(['--out', outF, '--cases', fFile, '--before-src', beforeDir]));
const fRes = JSON.parse(fs.readFileSync(path.join(outF, 'result.json'), 'utf8'));
check('#22b C 段 forbiddenPicks 命中 → 失败（防商户/机关/行政点漏回）',
  fRun.code === 1 && fRes.C[0] && !fRes.C[0].verdict.ok && /选中禁止点/.test(fRes.C[0].verdict.why),
  'exit=' + fRun.code + ' verdict=' + JSON.stringify(fRes.C[0] && fRes.C[0].verdict));

// #27：expected 写成具体名称时必须真选到该点（C05 用；不能只看"选了个非排除点"）。
const nameCases = JSON.parse(fs.readFileSync(CASES, 'utf8'));
nameCases.C = [{
  id: 'CN1', steleName: '靳岗天主教堂', expected: '天主堂', route: 'name',
  targetLon: 112.5035, targetLat: 33.0325,
  candidates: [{ name: '天主堂', lon: 112.5035, lat: 33.0343, rank: 2, type: '风景名胜' }],
}];
const nFile = path.join(tmp, 'cases-name.json');
fs.writeFileSync(nFile, JSON.stringify(nameCases));
const outN = path.join(tmp, 'n');
const nRun = run(['--stage', 'S', '--kp', '0.04', '--ks', '0.02', '--strong', '0.85', '--out', outN, '--cases', nFile, '--before-src', beforeDir]);
const nRes = JSON.parse(fs.readFileSync(path.join(outN, 'result.json'), 'utf8'));
check('#27 C 段 expected=具体名称，选到该点 → 通过',
  nRun.code === 0 && nRes.C[0].after.actualPick === '天主堂' && nRes.C[0].verdict.ok && /选到期望点/.test(nRes.C[0].verdict.why),
  'exit=' + nRun.code + ' C=' + JSON.stringify(nRes.C[0] && { pick: nRes.C[0].after.actualPick, verdict: nRes.C[0].verdict }));

// 负例：expected=天主堂，候选只有泛词「教堂」且被选中 ⇒ 必须失败（"选了非排除点"不算过）
nameCases.C = [{
  id: 'CN2', steleName: '靳岗天主教堂', expected: '天主堂', route: 'name',
  targetLon: 112.5035, targetLat: 33.0325,
  candidates: [{ name: '教堂', lon: 112.5035, lat: 33.0343, rank: 2, type: '风景名胜' }],
}];
const nBadFile = path.join(tmp, 'cases-name-bad.json');
fs.writeFileSync(nBadFile, JSON.stringify(nameCases));
const outNBad = path.join(tmp, 'n-bad');
const nBadRun = run(['--stage', 'S', '--kp', '0.04', '--ks', '0.02', '--strong', '0.85', '--out', outNBad, '--cases', nBadFile, '--before-src', beforeDir]);
const nBadRes = JSON.parse(fs.readFileSync(path.join(outNBad, 'result.json'), 'utf8'));
check('#27 C 段 expected 不符 → 失败且 exit 1（负例）',
  nBadRun.code === 1 && nBadRes.C[0] && !nBadRes.C[0].verdict.ok && /期望 天主堂/.test(nBadRes.C[0].verdict.why),
  'exit=' + nBadRun.code + ' verdict=' + JSON.stringify(nBadRes.C[0] && nBadRes.C[0].verdict));

// #27：C 段 expectedDistanceKm 校验（与 #22b drift 同构，C05 用它锚定 6.2 km）。
const distCase = (id, lonLatOffsetM) => ({
  id, steleName: '靳岗天主教堂', expected: '天主堂', route: 'name',
  targetLon: 112.509, targetLat: 33.034,
  expectedDistanceKm: 6.2, distanceToleranceKm: 0.05,
  candidates: [{ name: '天主堂', lon: 112.509, lat: 33.034 + lonLatOffsetM / 111320, rank: 2, type: '风景名胜' }],
});
const distCases = JSON.parse(fs.readFileSync(CASES, 'utf8'));
distCases.C = [distCase('CD1', 6193)];
const distFile = path.join(tmp, 'cases-dist.json');
fs.writeFileSync(distFile, JSON.stringify(distCases));
const distOut = path.join(tmp, 'd');
const distRun = run(['--stage', 'S', '--kp', '0.04', '--ks', '0.02', '--strong', '0.85', '--out', distOut, '--cases', distFile, '--before-src', beforeDir]);
const distRes = JSON.parse(fs.readFileSync(path.join(distOut, 'result.json'), 'utf8'));
check('#27 C 段距离在期望容差内 → 通过（distance 6.2）',
  distRun.code === 0 && distRes.C[0].distance === 6.2 && distRes.C[0].verdict.ok && /距离 6\.2 km（期望 6\.2/.test(distRes.C[0].verdict.why),
  'exit=' + distRun.code + ' C=' + JSON.stringify(distRes.C[0] && { distance: distRes.C[0].distance, verdict: distRes.C[0].verdict }));

// 负例：期望 6.2 km，实际约 4.0 km ⇒ 必须失败（不能用"容差差不多"掩盖）
distCases.C = [distCase('CD2', 4000)];
const distBadFile = path.join(tmp, 'cases-dist-bad.json');
fs.writeFileSync(distBadFile, JSON.stringify(distCases));
const distBadOut = path.join(tmp, 'd-bad');
const distBadRun = run(['--stage', 'S', '--kp', '0.04', '--ks', '0.02', '--strong', '0.85', '--out', distBadOut, '--cases', distBadFile, '--before-src', beforeDir]);
const distBadRes = JSON.parse(fs.readFileSync(path.join(distBadOut, 'result.json'), 'utf8'));
check('#27 C 段距离超出期望容差 → 失败且 exit 1（负例）',
  distBadRun.code === 1 && distBadRes.C[0] && !distBadRes.C[0].verdict.ok && /超出期望 6\.2/.test(distBadRes.C[0].verdict.why),
  'exit=' + distBadRun.code + ' verdict=' + JSON.stringify(distBadRes.C[0] && distBadRes.C[0].verdict));

fs.rmSync(tmp, { recursive: true, force: true });
finish();
