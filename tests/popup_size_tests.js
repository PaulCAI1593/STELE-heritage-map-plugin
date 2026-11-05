// tests/popup_size_tests.js
// #12 弹窗自适应宽度：五档映射、边界、availWidth 夹取、变量写入（vm 真执行）、CSS/加载顺序断言。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeChecker } = require('./_env');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const SIZE_PATH = path.join(SRC, 'popup', 'popup-size.js');
const sizeSrc = fs.readFileSync(SIZE_PATH, 'utf8');
const html = fs.readFileSync(path.join(SRC, 'popup', 'popup.html'), 'utf8');
const css = fs.readFileSync(path.join(SRC, 'popup', 'popup.css'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const { check, finish } = makeChecker('popup-size');
const { pickPopupWidth } = require(SIZE_PATH);

// ---------------- 1. 五档映射 ----------------
console.log('\n=== 五档：screenW → 弹窗宽度 ===');
check('3840（4K）→ 560', pickPopupWidth(3840) === 560);
check('2560 → 560', pickPopupWidth(2560) === 560);
check('2559 落到 520 档', pickPopupWidth(2559) === 520);
check('1920 → 520', pickPopupWidth(1920) === 520);
check('1536 → 480', pickPopupWidth(1536) === 480);
check('1535 落到 440 档', pickPopupWidth(1535) === 440);
check('1280 → 440', pickPopupWidth(1280) === 440);
check('1279 落到 400 档', pickPopupWidth(1279) === 400);
check('800 → 400（最小档）', pickPopupWidth(800) === 400);
check('宽度永不超过 560', [3840, 2560, 1920, 1536, 1280].every(w => pickPopupWidth(w) <= 560));
check('宽度永不低于 400（普通屏）', [1280, 1024, 800].every(w => pickPopupWidth(w) === 400 || pickPopupWidth(w) >= 440));

// ---------------- 2. 非法输入 ----------------
console.log('\n=== 非法输入一律 400 ===');
check('undefined → 400', pickPopupWidth(undefined) === 400);
check('null → 400', pickPopupWidth(null) === 400);
check('NaN → 400', pickPopupWidth(NaN) === 400);
check('字符串 "1920" → 400（不隐式转换）', pickPopupWidth('1920') === 400);
check('-1 → 400', pickPopupWidth(-1) === 400);

// ---------------- 3. availWidth 夹取 ----------------
console.log('\n=== availWidth 夹取 ===');
check('1920 屏、可用宽 1000 → 520 不被夹', pickPopupWidth(1920, 1000) === 520);
check('2560 屏、可用宽 500 → 460', pickPopupWidth(2560, 500) === 460);
check('2560 屏、可用宽 100 → 保底 400（下限）', pickPopupWidth(2560, 100) === 400);
check('默认取 screen.availWidth（Node 下无 screen 不影响）', pickPopupWidth(3840, undefined) === 560);

// ---------------- 4. 真执行：写变量、挂 API ----------------
console.log('\n=== 脚本行为：写 --hmp-popup-w 与挂 window.HMP.popupSize ===');
function runInFakeDom(screenW, availW) {
  const writes = [];
  const ctx = {
    window: {},
    document: { documentElement: { style: { setProperty(k, v) { writes.push([k, v]); } } } },
    screen: { width: screenW, availWidth: availW === undefined ? screenW : availW },
    module: { exports: {} },
    console
  };
  vm.createContext(ctx);
  vm.runInContext(sizeSrc, ctx);
  return { writes, ctx };
}
{
  const a = runInFakeDom(3840);
  check('4K 下写入 --hmp-popup-w=560px', a.writes.length === 1 && a.writes[0][0] === '--hmp-popup-w' && a.writes[0][1] === '560px');
  check('只写这一个变量（单一出口）', a.writes.every(w => w[0] === '--hmp-popup-w'));
  check('挂到 window.HMP.popupSize.pickPopupWidth', typeof a.ctx.window.HMP === 'object' && typeof a.ctx.window.HMP.popupSize.pickPopupWidth === 'function');
  check('window 上也能算出同样结果', a.ctx.window.HMP.popupSize.pickPopupWidth(1920) === 520);
}
{
  const b = runInFakeDom(2560, 500);
  check('availWidth 夹取生效：写入 460px', b.writes[0] && b.writes[0][1] === '460px');
}
{
  const c = runInFakeDom(1024);
  check('1024 屏写入 400px', c.writes[0] && c.writes[0][1] === '400px');
}
check('module.exports 暴露 pickPopupWidth（Node 测试用）', typeof require(SIZE_PATH).pickPopupWidth === 'function');
const sizeCode = sizeSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
check('不读 cookie、不发网络请求（只看可执行代码）', !/cookie|fetch\s*\(|XMLHttpRequest|localStorage/.test(sizeCode));

// ---------------- 5. CSS 与 HTML 接线 ----------------
console.log('\n=== CSS 单一出口 / 旧写法已删 / 加载顺序 ===');
// #21：Chrome 扩展弹窗宽度由内容推出，100vw 会自指导致首帧锁窄（真机实测）——单一出口只用变量。
check('存在唯一的 `html,body{width:var(--hmp-popup-w,400px)` 出口',
  (css.match(/html,body\{width:var\(--hmp-popup-w,400px\)/g) || []).length === 1);
check('popup.css 不含 100vw（含 min()/max-width 写法）', !/100vw/.test(css));
check('不再有 width:380px', !css.includes('width:380px'));
check('不再有 max-width:100vw', !css.includes('max-width:100vw'));
check('不再有 min-height:100vh', !css.includes('min-height:100vh'));
check('不再有 @media (min-width:400px)', !/@media\s*\(min-width:\s*400px\)/.test(css));
check('.popup 用 min-height:0', /\.popup\{min-height:0/.test(css));
check('没有 !important 叠宽度档', !/width:[^;]*!important/.test(css));
// 长内容不变量：sticky 底栏（#12 §五-3），前提是 .popup 不再裁切子元素
check('.hmp-foot 用 position:sticky + bottom:0', /\.hmp-foot\{[^}]*position:sticky[^}]*bottom:0/.test(css));
check('.popup 已去掉 overflow:hidden（否则 sticky 不生效）', !/\.popup\{[^}]*overflow:hidden/.test(css));
check('未引入 scrollbar-gutter（sticky 单方案，避免预留槽压缩档位宽度）', !css.includes('scrollbar-gutter'));
{
  const iCss = html.indexOf('popup.css');
  const iSize = html.indexOf('popup-size.js');
  const iPopup = html.indexOf('popup.js');
  check('popup.html 在 head 引入 popup-size.js', iSize > 0 && iSize < html.indexOf('</head>'));
  check('popup-size.js 在 popup.css 之后', iSize > iCss);
  check('popup-size.js 在 popup.js 之前', iSize < iPopup);
}
check('版本 0.4.2：manifest', manifest.version === '0.4.2');
check('版本 0.4.2：package.json', pkg.version === '0.4.2');
check('package.json 把本套接进 npm test', /popup_size_tests\.js/.test(pkg.scripts.test));
check('DATA_VERSION 未动（仍 46）', /DATA_VERSION\s*=\s*46/.test(fs.readFileSync(path.join(SRC, 'content', 'cache.js'), 'utf8')));

finish();
