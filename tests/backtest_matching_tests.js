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
const beforeDir = path.join(tmp, 'before');
fs.mkdirSync(beforeDir);
fs.writeFileSync(path.join(beforeDir, 'matcher.js'),
  require('child_process').execFileSync('git', ['show', 'HEAD:src/content/matcher.js'], { cwd: ROOT, encoding: 'utf8' }));

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

fs.rmSync(tmp, { recursive: true, force: true });
finish();
