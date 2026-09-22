// tests/switch_tests.js
// 点位切换时序测试 —— 针对"从其他点位切到某点位时，开放信息不自动更新"。
//
// 站点的真实时序不可控：切点位的导航、以及站点自己的 /api/v1/feature/{id} 请求，
// 谁先谁后并不固定。旧实现里 fetch 劫持拿到响应就无条件派发，于是
// 「上一个点位的迟到响应」会把卡片钉回旧点位；而 URL 兜底看到 hijacked 里
// 已有当前点位的 id，就认为"派发过了"直接 return —— 卡片永久停在上一个点位。
//
// 这里只测 content.js 的派发序列（不加载 card.js）：
//   1) 新点位响应先到、旧点位迟到响应后到 → 最后一次派发必须是新点位
//   2) 新点位响应早于导航返回（先缓存）→ 导航到位后必须补派发
//   3) 切走后到达的旧响应不得派发
//   4) 同一点位重复派发是幂等的（不会来回刷）
//
// 运行: node tests/switch_tests.js
'use strict';
const fs = require('fs');
const path = require('path');

// ================= 浏览器环境桩 =================
const loc = { pathname: '/zhcn/', hash: '', origin: 'http://stele.geogv.org' };
global.location = loc;

const listeners = {};
global.CustomEvent = class CustomEvent {
  constructor(type, init) { this.type = type; this.detail = init && init.detail; }
};

// setTimeout 用真实实现（content.js 依赖 30ms/800ms 的延时）；
// setInterval 只记录回调，避免测试进程被定时器拖住。
const intervalFns = [];
global.setInterval = (fn) => { intervalFns.push(fn); return intervalFns.length; };
global.clearInterval = () => {};

global.document = {
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, remove() {} }),
  body: { appendChild() {}, querySelector: () => null },
};

global.Request = class Request { constructor(url) { this.url = url; } };

// fetch 桩：把待处理的请求登记下来，由测试决定何时、以什么顺序响应
const pending = [];
function respond(id, data) {
  const i = pending.findIndex(p => p.id === id);
  if (i < 0) throw new Error('没有待响应的请求: ' + id);
  const [p] = pending.splice(i, 1);
  p.resolve({
    ok: true,
    status: 200,
    clone() { return { text: () => Promise.resolve(JSON.stringify(data)) }; },
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}
function pendingIds() { return pending.map(p => p.id); }

global.window = global;
global.window.addEventListener = (type, fn) => {
  (listeners[type] = listeners[type] || []).push(fn);
};
global.window.dispatchEvent = (ev) => {
  for (const fn of (listeners[ev.type] || [])) fn(ev);
  return true;
};
global.fetch = (input) => {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  const m = url.match(/\/api\/v1\/(?:feature|query)\/([^/?]+)/);
  const id = m ? decodeURIComponent(m[1]) : 'other';
  return new Promise((resolve) => pending.push({ id, resolve }));
};

// 记录所有派发给 card.js 的点位
const poiEvents = [];
listeners['hmp:poi-loaded'] = [];
window.addEventListener('hmp:poi-loaded', (ev) => {
  poiEvents.push(ev.detail && ev.detail.name);
});
const last = () => poiEvents[poiEvents.length - 1];

const origPush = (p) => { loc.pathname = p; };
global.history = {
  pushState(state, title, url) { origPush(url); },
  replaceState(state, title, url) { origPush(url); },
};

// 加载被测代码（decoder 在前，content.js 依赖它）
const SRC = path.join(__dirname, '..', process.env.HMP_SRC || 'src', 'content');
eval(fs.readFileSync(path.join(SRC, 'decoder.js'), 'utf8'));
eval(fs.readFileSync(path.join(SRC, 'content.js'), 'utf8'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const feature = (name) => ({ name, geom: { coordinates: [0, 0] }, admin: [] });

// 导航到某点位：改 URL 并触发被钩住的 pushState
async function navigate(id) {
  history.pushState({}, '', '/zhcn/geo/' + id);
  await sleep(50);   // content.js 在 pushState 后 30ms 调 checkUrl
}

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (detail ? '  → ' + detail : '')); }
}

(async () => {
  // ============ 1. 旧点位迟到响应不得覆盖新点位 ============
  console.log('\n=== 1. 新点位响应先到、旧点位迟到响应后到 ===');
  poiEvents.length = 0;

  await navigate('OLD');
  const reqOld = global.fetch('/api/v1/feature/OLD?locale=zhcn');
  respond('OLD', feature('上一个点位'));
  await reqOld; await sleep(30);
  check('导航后先派发旧点位', last() === '上一个点位', JSON.stringify(poiEvents));

  await navigate('NEW');
  const reqNew = global.fetch('/api/v1/feature/NEW?locale=zhcn');
  respond('NEW', feature('上海孙中山故居'));
  await reqNew; await sleep(30);
  check('切到新点位后派发了新点位', last() === '上海孙中山故居', JSON.stringify(poiEvents));

  // 旧点位的另一个请求（预取 / 慢响应）现在才回来
  const lateOld = global.fetch('/api/v1/feature/OLD?locale=zhcn');
  respond('OLD', feature('上一个点位'));
  await lateOld; await sleep(40);
  check('旧点位迟到响应不得改变当前卡片', last() === '上海孙中山故居', JSON.stringify(poiEvents));
  check('旧点位迟到响应根本不派发', poiEvents.filter(n => n === '上一个点位').length === 1,
    JSON.stringify(poiEvents));

  // 兜底轮询也不该把卡片弄回旧点位
  for (const fn of intervalFns) await fn();
  await sleep(30);
  check('兜底轮询后仍是新点位', last() === '上海孙中山故居', JSON.stringify(poiEvents));

  // ============ 2. 响应早于导航返回 → 导航到位后必须补派发 ============
  console.log('\n=== 2. 响应早于导航返回（先缓存，后补派发）===');
  poiEvents.length = 0;

  // 站点先发请求（URL 还停在上一个点位）
  const preReq = global.fetch('/api/v1/feature/EARLY?locale=zhcn');
  respond('EARLY', feature('响应早到的点位'));
  await preReq;
  await sleep(20);
  check('URL 未变时只缓存、不派发', poiEvents.length === 0, JSON.stringify(poiEvents));

  await navigate('EARLY');
  check('导航到位后补派发成功（旧实现会永久卡住）',
    last() === '响应早到的点位', JSON.stringify(poiEvents));

  // ============ 3. 切走后到达的旧响应 ============
  console.log('\n=== 3. 切走后到达的旧响应 ===');
  poiEvents.length = 0;
  poiEvents.push('占位');

  await navigate('P1');
  await navigate('P2');             // P1 还在路上就切到 P2
  const reqP2 = global.fetch('/api/v1/feature/P2?locale=zhcn');
  respond('P2', feature('第二个点位'));
  await reqP2; await sleep(30);
  const lateP1 = global.fetch('/api/v1/feature/P1?locale=zhcn');
  respond('P1', feature('第一个点位'));   // P1 迟到了
  await lateP1; await sleep(40);
  // 再等过 P1 那次兜底拉取的 800ms 窗口，确认旧点位不会被补派发
  await sleep(850);
  check('只应看到第二个点位', poiEvents.filter(n => n === '第一个点位').length === 0,
    JSON.stringify(poiEvents));
  check('第二点位已派发', poiEvents.indexOf('第二个点位') >= 0, JSON.stringify(poiEvents));

  // ============ 4. 幂等：同一点位不会反复派发 ============
  console.log('\n=== 4. 同一点位重复派发是幂等的 ===');
  poiEvents.length = 0;
  await navigate('SAME');
  const reqSame = global.fetch('/api/v1/feature/SAME?locale=zhcn');
  respond('SAME', feature('同一点位'));
  await reqSame; await sleep(30);
  const n1 = poiEvents.length;
  for (const fn of intervalFns) await fn();
  await sleep(30);
  check('重复检查不会重复派发', poiEvents.length === n1, `${n1} → ${poiEvents.length}`);

  // ============ 5. A → B → A 来回切，每次都要重新派发 ============
  // 实测场景：项目组 ↔ 子项目 来回点。若用"派发过的集合"做幂等，
  // 切回已经派发过的点位会被当成"早就派发过"而跳过，卡片永久停在子项目上。
  console.log('\n=== 5. 来回切换（项目组 ↔ 子项目）===');
  poiEvents.length = 0;

  const rA = global.fetch('/api/v1/feature/GRP?locale=zhcn');
  await navigate('GRP');
  respond('GRP', feature('项目组'));
  await rA; await sleep(30);
  check('第一次进入项目组：已派发', last() === '项目组', JSON.stringify(poiEvents));

  const rB = global.fetch('/api/v1/feature/KID1?locale=zhcn');
  await navigate('KID1');
  respond('KID1', feature('子项目'));
  await rB; await sleep(30);
  check('点进子项目：已派发', last() === '子项目', JSON.stringify(poiEvents));

  await navigate('GRP');      // 切回项目组：它的 feature 已经躺在 hijacked 里
  await sleep(40);
  check('切回项目组：必须重新派发（旧实现会永久停在子项目）',
    last() === '项目组', JSON.stringify(poiEvents));

  await navigate('KID1');
  await sleep(40);
  check('再点进子项目：已派发', last() === '子项目', JSON.stringify(poiEvents));

  await navigate('GRP');
  await sleep(40);
  check('再切回项目组：仍然重新派发', last() === '项目组', JSON.stringify(poiEvents));

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
