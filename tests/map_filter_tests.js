// tests/map_filter_tests.js
// #61 地图「只显示收藏」：分组并集 / 状态机 / 桥的 setFilter 与 token 校验 / manifest 声明。
// 运行: node tests/map_filter_tests.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const env = require('./_env');
const { check, finish } = env.makeChecker('map-filter');

const SRC = path.join(__dirname, '..', 'src');
const bridgeSrc = fs.readFileSync(path.join(SRC, 'content', 'map-bridge.js'), 'utf8');
const filterSrc = fs.readFileSync(path.join(SRC, 'content', 'map-filter.js'), 'utf8');
const M = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));

const HC_LAYERS = [
  'hc_site_trad', 'hc_site_hisbldg', 'hc_site_reg', 'hc_site_comp',
  'hc_site_l6', 'hc_site_l5', 'hc_site_l4', 'hc_site_cn', 'hc_site_whc',
  'hc_traditional_village',
];

function makeSandbox(extra) {
  const listeners = {};
  const sb = {
    console, Promise, JSON, Math, Date, Number, String, Array, Object, RegExp, Error,
    setTimeout, clearTimeout, Proxy, Reflect,
  };
  sb.window = sb;
  sb.self = sb;
  sb.addEventListener = (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); };
  sb.removeEventListener = () => {};
  sb.dispatchEvent = (ev) => {
    const list = listeners[ev.type] || [];
    list.slice().forEach(fn => fn(ev));
    return true;
  };
  sb.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
  Object.assign(sb, extra || {});
  sb.emit = (type, detail) => sb.dispatchEvent({ type, detail });
  return vm.createContext(sb);
}

// ---------------- 1. 纯逻辑（isolated 侧） ----------------
const fctx = makeSandbox();
vm.runInContext(filterSrc, fctx, { filename: 'content/map-filter.js' });
const core = fctx.window.HMP && fctx.window.HMP.mapFilter;

check('map-filter 暴露 HMP.mapFilter（core 可测）', !!(core && core.computeKids && core.next), !!core);

const LIB = core.normalizeLibrary({
  groups: [
    { id: 'g-been', name: '已去', system: true, createdAt: 0 },
    { id: 'g-want', name: '想去', system: true, createdAt: 1 },
    { id: 'g-custom', name: '洛阳', system: false, createdAt: 5 },
  ],
  items: [
    { steleId: 'k1', groupId: 'g-been' },
    { steleId: 'k2', groupId: 'g-want' },
    { steleId: 'k3', groupId: 'g-custom' },
    { steleId: 'k4', groupId: 'g-want' },
  ],
});
check('normalizeLibrary 保留分组顺序（系统组在前 + 自定义组）',
  core.groupIds(LIB).join(',') === 'g-been,g-want,g-custom', core.groupIds(LIB).join(','));

check('勾选组 → kids 并集（含自定义组）',
  core.computeKids(LIB, ['g-been', 'g-custom']).join(',') === 'k1,k3',
  core.computeKids(LIB, ['g-been', 'g-custom']).join(','));
check('全选 → 全部 kids（同 steleId 不重复）',
  core.computeKids(LIB, core.groupIds(LIB)).length === 4, String(core.computeKids(LIB, core.groupIds(LIB)).length));
check('全关 → 空集（表示全部隐藏）', core.computeKids(LIB, []).length === 0);
check('未知分组 id 被忽略', core.computeKids(LIB, ['nope']).length === 0);

// 空库 / schema 1 兼容
const EMPTY = core.normalizeLibrary({});
check('空库回落到默认两组（已去/想去）', core.groupIds(EMPTY).join(',') === 'g-been,g-want', core.groupIds(EMPTY).join(','));
check('空库无条目', EMPTY.items.length === 0);
const V1 = core.normalizeLibrary({ schema: 1, items: [{ steleId: 'x', groupId: 'g-want' }] });
check('schema 1 原始值可读（无 groups 时补默认组）', V1.groups.length === 2 && V1.items.length === 1);

// 状态机：off → on → toggle → restore
let st = core.freshState();
check('初始 off、面板收起、无勾选', st.mode === 'off' && st.panelOpen === false && st.checked.length === 0);
let r = core.next(st, { type: 'button' }, LIB);
st = r.state;
check('off 点按钮 → on + 面板展开 + 全选 + 立即 apply 全部 kids',
  st.mode === 'on' && st.panelOpen === true && st.checked.length === 3 &&
  r.effect && r.effect.cmd === 'apply' && r.effect.kids.length === 4,
  JSON.stringify(r.effect));
r = core.next(st, { type: 'toggle-group', id: 'g-want' }, LIB);
st = r.state;
check('on 时关一个组 → 该组条目移出，面板不收起',
  st.panelOpen === true && st.checked.indexOf('g-want') < 0 && r.effect.cmd === 'apply' &&
  r.effect.kids.indexOf('k2') < 0 && r.effect.kids.length === 2, JSON.stringify(r.effect.kids));
r = core.next(st, { type: 'toggle-group', id: 'g-want' }, LIB);
st = r.state;
check('再开该组 → 回到全部', r.effect.kids.length === 4, JSON.stringify(r.effect.kids));
r = core.next(st, { type: 'close-panel' }, LIB);
st = r.state;
check('点外部/Esc 只收面板、保持 on、不发命令',
  st.mode === 'on' && st.panelOpen === false && r.effect === null);
r = core.next(st, { type: 'button' }, LIB);
st = r.state;
check('on（面板收起）再点按钮 → 还原 off + clear（不是重新展开）',
  st.mode === 'off' && st.panelOpen === false && r.effect && r.effect.cmd === 'clear',
  JSON.stringify(r.effect));
check('还原后所有分组都不勾选', st.checked.length === 0);
r = core.next(st, { type: 'button' }, LIB);
st = r.state;
check('close-panel 后再进 on 可再次全选', st.checked.length === 3 && st.mode === 'on');

// 全关 → apply 空 kids
let off = core.next(st, { type: 'toggle-group', id: 'g-been' }, LIB).state;
off = core.next(off, { type: 'toggle-group', id: 'g-want' }, LIB).state;
off = core.next(off, { type: 'toggle-group', id: 'g-custom' }, LIB);
check('所有分组都关 → apply 空 kids（地图全隐藏）',
  off.state.checked.length === 0 && off.effect.cmd === 'apply' && off.effect.kids.length === 0);

// off 时 toggle 不发命令
const offState = core.freshState();
check('off 时分组开关不发 apply', core.next(offState, { type: 'toggle-group', id: 'g-been' }, LIB).effect === null);

// 收藏数据变化：不改变勾选、实时重算；已删组被剔除
const reduced = {
  groups: [LIB.groups[0], LIB.groups[1]],
  items: [LIB.items[0], LIB.items[1]],
};
let libState = core.next(core.freshState(), { type: 'button' }, LIB).state;
const changed = core.next(libState, { type: 'library' }, reduced);
check('收藏变化且 on → 不改勾选（只剔除已删组）并重算',
  changed.state.checked.join(',') === 'g-been,g-want' && changed.effect.cmd === 'apply' &&
  changed.effect.kids.join(',') === 'k1,k2', JSON.stringify(changed.effect));
check('收藏变化且 off → 不发命令',
  core.next(core.freshState(), { type: 'library' }, reduced).effect === null);

// apply 事件 detail 形状
const cmd = core.buildCommand('apply', ['k1']);
check('命令 detail 形状 {cmd, kids, token}',
  cmd.cmd === 'apply' && Array.isArray(cmd.kids) && typeof cmd.token === 'string' && cmd.token.length > 8,
  JSON.stringify(cmd));

// ---------------- 2. 桥（MAIN world） ----------------
function makeBridgeSandbox() {
  const sb = makeSandbox();
  const maps = [];
  class FakeMap {
    constructor() {
      this.calls = [];
      this.handlers = {};
      maps.push(this);
    }
    getStyle() { return { layers: HC_LAYERS.map(id => ({ id, type: 'symbol' })) }; }
    setFilter(id, expr) { this.calls.push({ id, expr }); }
    on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  }
  sb.mapboxglValue = { Map: FakeMap, supported() { return true; }, version: '1.7.0' };
  sb.maps = maps;
  return sb;
}

const bctx = makeBridgeSandbox();
vm.runInContext(bridgeSrc, bctx, { filename: 'content/map-bridge.js' });
bctx.window.mapboxgl = bctx.mapboxglValue;           // 触发 setter + Proxy 包装
check('桥拦截 window.mapboxgl 赋值并返回包装对象', !!bctx.window.mapboxgl && bctx.window.mapboxgl.version === '1.7.0');
const map1 = new bctx.window.mapboxgl.Map();
check('Proxy 包 Map 构造：新实例被收集', bctx.window.__HMP_MAP_BRIDGE__.instances().length === 1);

const app1 = { type: 'hmp:map-filter', detail: { cmd: 'apply', kids: ['k1', 'k2'], token: 'tok-1' } };
bctx.emit(app1.type, app1.detail);
const applyCalls = map1.calls.filter(c => c.id === 'hc_site_cn')[0];
check('apply：9 个 hc_site* 层 + hc_traditional_village 全部 setFilter',
  map1.calls.length === HC_LAYERS.length && HC_LAYERS.every(id => map1.calls.some(c => c.id === id)),
  String(map1.calls.length));
check('apply 表达式 = [in, [get, kid], [literal, kids]]',
  JSON.stringify(applyCalls.expr) === JSON.stringify(['in', ['get', 'kid'], ['literal', ['k1', 'k2']]]),
  JSON.stringify(applyCalls.expr));
check('非文保层不被设置（负例）',
  !map1.calls.some(c => c.id === 'water' || c.id === 'road'));

// 非法 token 忽略
const before = map1.calls.length;
bctx.emit('hmp:map-filter', { cmd: 'apply', kids: ['k9'], token: 'tok-2' });
check('非法 token 的命令被忽略（不新增 setFilter）', map1.calls.length === before, String(map1.calls.length - before));

// 新实例在 apply 状态下自动补设
const map2 = new bctx.window.mapboxgl.Map();
check('新建地图实例后自动补设过滤（站点二次创建地图）',
  map2.calls.length === HC_LAYERS.length &&
  JSON.stringify(map2.calls[0].expr[2][1]) === JSON.stringify(['k1', 'k2']),
  String(map2.calls.length));

// style.load 后补设
const map1Before = map1.calls.length;
(map1.handlers['style.load'] || []).forEach(fn => fn());
check('style.load 后重新补设全部层',
  map1.calls.length - map1Before === HC_LAYERS.length, String(map1.calls.length - map1Before));

// clear 全部置 null
bctx.emit('hmp:map-filter', { cmd: 'clear', kids: [], token: 'tok-1' });
const lastClear = map1.calls.slice(-HC_LAYERS.length);
check('clear：全部文保层 setFilter(id, null)',
  lastClear.length === HC_LAYERS.length && lastClear.every(c => c.expr === null && HC_LAYERS.indexOf(c.id) >= 0),
  JSON.stringify(lastClear.map(c => c.id)));

// ack 形状
let acks = [];
bctx.addEventListener('hmp:map-filter-ack', ev => acks.push(ev.detail));
bctx.emit('hmp:map-filter', { cmd: 'apply', kids: ['k3'], token: 'tok-1' });
check('桥回 ack {token, cmd, ok, instances}',
  acks.length === 1 && acks[0].token === 'tok-1' && acks[0].cmd === 'apply' && acks[0].ok === true &&
  acks[0].instances === 2, JSON.stringify(acks[0]));

// ---------------- 2b. READY 时序（#62 D-171） ----------------
// 真实顺序：桥在 MAIN world 的 document_start 先跑并派发 READY；filter 到 document_idle 才注册监听。
// 修法：filter 注册完监听主动 PING，桥立即回 READY —— 这条通道在真实时序下必达。
const orderCtx = makeBridgeSandbox();
vm.runInContext(bridgeSrc, orderCtx, { filename: 'content/map-bridge.js' });
vm.runInContext(filterSrc, orderCtx, { filename: 'content/map-filter.js' });
const orderBridge = orderCtx.window.HMP.mapFilter.__bridge();
check('#62 桥先加载、filter 后加载：bridgeSeen 最终为 true（PING → READY）',
  orderBridge.seen === true, JSON.stringify(orderBridge));
check('#62 PING 必达：桥收到 filter 的 ping 至少 1 次',
  orderCtx.window.__HMP_MAP_BRIDGE__.pings() >= 1,
  String(orderCtx.window.__HMP_MAP_BRIDGE__.pings()));
check('#62 不误报「不支持」：未触发降级注入',
  orderBridge.injectTried === false && orderBridge.usedFallback === false, JSON.stringify(orderBridge));

// 反向顺序保留：桥晚于 filter 时，一次性 READY 仍能把 bridgeSeen 置真
const revCtx = makeSandbox();
vm.runInContext(filterSrc, revCtx, { filename: 'content/map-filter.js' });
const revBefore = revCtx.window.HMP.mapFilter.__bridge();
vm.runInContext(bridgeSrc, revCtx, { filename: 'content/map-bridge.js' });
const revAfter = revCtx.window.HMP.mapFilter.__bridge();
check('#62 桥晚于 filter 加载：一次性 READY 仍置 bridgeSeen（旧通道未破坏）',
  revBefore.seen === false && revAfter.seen === true,
  JSON.stringify([revBefore, revAfter]));

check('#62 静态：桥监听 hmp:map-filter-ping，filter 在监听后主动 ping',
  bridgeSrc.indexOf('hmp:map-filter-ping') >= 0 &&
  filterSrc.indexOf("addEventListener(READY_EVENT") >= 0 &&
  filterSrc.lastIndexOf('pingBridge();') > filterSrc.indexOf("addEventListener(READY_EVENT"));

// ---------------- 2c. #63 视觉与定位（面板脚注 / 图例对齐 / 造型令牌） ----------------
const SUM_ALL = core.summary(LIB, core.groupIds(LIB));
check('#63 脚注汇总：全选 3/3 组、4 个点位',
  SUM_ALL.selectedGroups === 3 && SUM_ALL.totalGroups === 3 && SUM_ALL.points === 4, JSON.stringify(SUM_ALL));
const SUM_ONE = core.summary(LIB, ['g-been']);
check('#63 脚注汇总：只选「已去」→ 1/3 组、1 个点位',
  SUM_ONE.selectedGroups === 1 && SUM_ONE.totalGroups === 3 && SUM_ONE.points === 1, JSON.stringify(SUM_ONE));
const SUM_NONE = core.summary(LIB, []);
check('#63 脚注汇总：全不选 → 0/3 组、0 个点位（右侧显示未选择分组）',
  SUM_NONE.selectedGroups === 0 && SUM_NONE.totalGroups === 3 && SUM_NONE.points === 0, JSON.stringify(SUM_NONE));
check('#63 脚注汇总：未知分组不计入已选',
  core.summary(LIB, ['nope']).selectedGroups === 0);

// 定位：按钮底边 = 图例顶边 - 8，右缘对齐；1440×900 与 1280×800 各验一次
const POS_1440 = core.positionFor({ right: 1434, top: 833 }, 1440, 900);
check('#63 定位 1440×900：右缘与图例对齐（right=6）、间隙 8px（bottom=75）',
  POS_1440.right === 6 && POS_1440.bottom === 75, JSON.stringify(POS_1440));
check('#63 定位 1440×900：按钮底边 = 900-75 = 825，距图例顶 833 为 8px',
  900 - POS_1440.bottom === 825 && 833 - (900 - POS_1440.bottom) === 8);
const POS_1280 = core.positionFor({ right: 1274, top: 733 }, 1280, 800);
check('#63 定位 1280×800：right=6、bottom=75（同样对齐与 8px 间隙）',
  POS_1280.right === 6 && POS_1280.bottom === 75, JSON.stringify(POS_1280));
check('#63 量不到图例时回退 right:10 / bottom:76',
  core.positionFor(null, 1440, 900).right === 10 && core.positionFor(null, 1440, 900).bottom === 76 &&
  core.FALLBACK.right === 10 && core.FALLBACK.bottom === 76 && core.FALLBACK.gap === 8);

// 造型令牌（照任务书 §二，静态核对）
const cssTokens = [
  ['面板宽 232', 'width:232px'],
  ['面板圆角 8', 'border-radius:8px'],
  ['行高 38', 'height:38px'],
  ['按钮高 36', 'height:36px'],
  ['按钮圆角 4', 'border-radius:4px'],
  ['按钮 off 描边/阴影', 'box-shadow:0 0 0 1px rgba(0,0,0,.10),0 1px 3px rgba(0,0,0,.10)'],
  ['激活底色 #2B3035', '#2B3035'],
  ['计数徽标 .badge', '.badge'],
  ['徽标仅 on 态显示', '.btn.is-on .badge'],
  ['面板脚注 .pfoot', '.pfoot'],
  ['未选择分组红色 #B23A2E', '#B23A2E'],
  ['自绘勾选框 .box', '.box'],
  ['原生 input 视觉隐藏', 'opacity:0'],
  ['reduced-motion 处理', 'prefers-reduced-motion'],
  ['兜底定位 right:10px;bottom:76px', 'right:10px;bottom:76px'],
];
cssTokens.forEach(([label, token]) => check(`#63 CSS：${label}`, filterSrc.indexOf(token) >= 0, token));

const jsTokens = [
  ['按钮文案', '只显示收藏'],
  ['脚注左「已选」', "createTextNode('已选 ')"] ,
  ['脚注右「共」', "createTextNode('共 ')"],
  ['脚注单位「个点位」', '个点位'],
  ['全不选文案', '未选择分组'],
  ['定位函数 positionFor', 'function positionFor'],
  ['量图例 findLegend', 'function findLegend'],
  ['resize 重量', "addEventListener('resize', positionUi)"],
];
jsTokens.forEach(([label, token]) => check(`#63 JS：${label}`, filterSrc.indexOf(token) >= 0, token));

// 对比度：正文/标题/计数/脚注在 #fff 上 ≥ 4.5（负例：mock 原色 #8A8F98=3.25、#9AA0A6=2.64 不达标）
function relLum(hex) {
  const c = hex.replace('#', '').match(/../g).map(x => parseInt(x, 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = hex => (1.05) / (relLum(hex) + 0.05);
const CONTRAST_TOKENS = { 组名: '#2B3035', 标题脚注: '#6B7079', 计数: '#70757D', 未选择: '#B23A2E', 脚注粗体: '#5F6469' };
Object.keys(CONTRAST_TOKENS).forEach(label => {
  const c = contrast(CONTRAST_TOKENS[label]);
  check(`#63 对比度：${label} ${CONTRAST_TOKENS[label]} = ${c.toFixed(2)} ≥ 4.5`, c >= 4.5, c.toFixed(2));
});
check('#63 负例：mock 原色 #9AA0A6 对比度不足（<4.5），确认加深是必要的', contrast('#9AA0A6') < 4.5);
check('#63 负例：mock 原色 #8A8F98 对比度不足（<4.5），确认加深是必要的', contrast('#8A8F98') < 4.5);

// ---------------- 3. manifest ----------------
check('manifest minimum_chrome_version = 111（world:"MAIN" 需要）', M.minimum_chrome_version === '111');
const MAIN_CS = (M.content_scripts || []).filter(c => c.world === 'MAIN');
check('存在 world:"MAIN" 的 document_start 桥脚本',
  MAIN_CS.length === 1 && MAIN_CS[0].run_at === 'document_start' &&
  MAIN_CS[0].js.indexOf('content/map-bridge.js') >= 0, JSON.stringify(MAIN_CS));
check('桥脚本只匹配 STELE 中文站',
  MAIN_CS.length === 1 && MAIN_CS[0].matches.length === 1 &&
  MAIN_CS[0].matches[0] === '*://stele.geogv.org/zhcn/*', JSON.stringify(MAIN_CS[0] && MAIN_CS[0].matches));
check('map-filter.js 在第一个（isolated、document_idle）内容脚本列表末尾',
  M.content_scripts[0].js[M.content_scripts[0].js.length - 1] === 'content/map-filter.js' &&
  M.content_scripts[0].run_at === 'document_idle');
check('降级用 web_accessible_resources 暴露 map-bridge.js',
  (M.web_accessible_resources || []).some(w => w.resources.indexOf('content/map-bridge.js') >= 0));
check('未新增权限：permissions 仍只有 storage',
  JSON.stringify(M.permissions) === JSON.stringify(['storage']), JSON.stringify(M.permissions));
check('未新增 host_permissions（地图过滤不加站点权限）',
  M.host_permissions.indexOf('*://stele.geogv.org/*') < 0 && M.host_permissions.length === 4,
  JSON.stringify(M.host_permissions));

// 负例：桥不 fetch、不过滤非文保层、不写 storage
check('桥不发网络请求（负例）', !/fetch\s*\(/.test(bridgeSrc) && !/XMLHttpRequest/.test(bridgeSrc));
check('map-filter 不改收藏 schema（不写 storage）', !/storage\.local\.set/.test(filterSrc) && !/\.replace\s*\(/.test(filterSrc));

finish();
