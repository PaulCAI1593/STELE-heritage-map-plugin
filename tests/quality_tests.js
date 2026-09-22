// tests/quality_tests.js
// 三个实测反馈的回归测试：
//
//   ① 可参观类型优先
//      三山会馆 应匹配「上海三山会馆」（博物馆），而不是「上海三山会馆管理委」（办事机构）
//
//   ② 切换点位必须刷新
//      快速连续点两个点位时，先发出的请求若后返回，不得盖住当前点位
//      （原实现没有过期校验，表现为"有时候开放信息不刷新"）
//
//   ③ 可能不开放的提醒
//      董家渡天主堂 匹配到「董家渡天主堂（暂停开放）」时，要给出提醒
//
// 运行: node tests/quality_tests.js
'use strict';
const fs = require('fs');
const path = require('path');

// ---------------- 迷你 DOM ----------------
class El {
  constructor(t) {
    this.tagName = String(t).toUpperCase(); this.children = []; this.parentNode = null;
    this.attrs = {}; this.className = ''; this.id = ''; this.style = {};
    this.nodeType = 1; this._text = ''; this._html = '';
  }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; } return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); if (k === 'class') this.className = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  get classList() {
    const s = this, l = () => s.className.split(/\s+/).filter(Boolean);
    return { add(c) { if (!l().includes(c)) s.className = (s.className + ' ' + c).trim(); },
      remove(c) { s.className = l().filter(x => x !== c).join(' '); },
      contains(c) { return l().includes(c); } };
  }
  get textContent() { return this._text; } set textContent(v) { this._text = String(v); }
  get innerHTML() { return this._html; } set innerHTML(v) { this._html = String(v); }
  addEventListener() {}
  matches(sel) { return matchSimple(this, sel); }
  querySelector(sel) { const r = this.querySelectorAll(sel); return r.length ? r[0] : null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = n => { for (const c of (n.children || [])) { if (c.nodeType !== 1) continue; if (matchSimple(c, sel)) out.push(c); walk(c); } };
    walk(this); return out;
  }
}
function matchSimple(el, part) {
  if (!el || el.nodeType !== 1) return false;
  const idm = part.match(/#([A-Za-z0-9_-]+)/);
  if (idm && el.id !== idm[1]) return false;
  const cls = [...part.matchAll(/\.([A-Za-z0-9_-]+)/g)].map(m => m[1]);
  const own = String(el.className || '').split(/\s+/).filter(Boolean);
  for (const c of cls) if (!own.includes(c)) return false;
  const tag = part.match(/^([a-zA-Z]+)/);
  if (tag && el.tagName.toLowerCase() !== tag[1].toLowerCase()) return false;
  return true;
}

global.window = global;
global.location = { href: 'http://stele.geogv.org/zhcn/geo/x', pathname: '/zhcn/geo/x', hash: '', origin: 'http://stele.geogv.org' };
const docBody = new El('body');
const modalBody = new El('div'); modalBody.className = 'modal-body';
const basicEl = new El('div'); basicEl.className = 'poi-section-content-padding'; basicEl.id = 'poi-basic-info-section';
modalBody.appendChild(basicEl); docBody.appendChild(modalBody);
global.document = {
  body: docBody,
  createElement: t => new El(t),
  createTextNode: t => ({ nodeType: 3, textContent: t }),
  getElementById: id => (id === 'poi-basic-info-section' ? basicEl : (function w(n) {
    for (const c of (n.children || [])) { if (c.nodeType !== 1) continue; if (c.id === id) return c; const r = w(c); if (r) return r; }
    return null;
  })(docBody)),
  querySelector: s => (s === '.modal-body' ? modalBody : docBody.querySelector(s)),
  querySelectorAll: s => docBody.querySelectorAll(s),
};
const evListeners = {};
global.window.addEventListener = (t, fn) => { (evListeners[t] = evListeners[t] || []).push(fn); };
const emit = (t, d) => { for (const fn of (evListeners[t] || [])) fn({ type: t, detail: d }); };
global.MutationObserver = class { observe() {} disconnect() {} };
global.chrome = {
  storage: { local: {
    _store: { amapKey: 'K', baiduAk: '', defaultProvider: 'amap', enabled: true },
    get(k, cb) { const store = this._store || {}; const o = (k == null) ? Object.assign({}, store) : (() => { const r = {}; for (const x of (Array.isArray(k) ? k : [k])) if (x in store) r[x] = store[x]; return r; })(); if (cb) cb(o); return Promise.resolve(o); },
    set(i, cb) { Object.assign(this._store, i); if (cb) cb(); return Promise.resolve(); },
    remove(k, cb) { const store = this._store || {}; for (const x of (Array.isArray(k) ? k : [k])) delete store[x]; if (cb) cb(); return Promise.resolve(); },
  } },
};

// ---------------- fetch mock ----------------
// 每个关键字可配置「返回什么」与「多久返回」，用于制造乱序
let responsePlan = {};   // keyword -> { pois, delay }
const calls = [];
global.fetch = async (url) => {
  const u = String(url);
  calls.push(u);
  if (u.includes('/place/around')) {
    return { ok: true, status: 200, json: async () => ({ status: '1', pois: [] }) };
  }
  const kw = new URL(u).searchParams.get('keywords') || '';
  const plan = responsePlan[kw] || { pois: [], delay: 0 };
  if (plan.delay) await new Promise(r => setTimeout(r, plan.delay));
  return { ok: true, status: 200, json: async () => ({ status: '1', pois: plan.pois || [] }) };
};

const SRC = path.join(__dirname, '..', 'src', 'content');
['decoder', 'naming', 'geo', 'cache', 'http'].forEach(f => eval(fs.readFileSync(path.join(SRC, f + '.js'), 'utf8')));
eval(fs.readFileSync(path.join(SRC, 'apis', 'amap.js'), 'utf8'));
eval(fs.readFileSync(path.join(SRC, 'apis', 'baidu.js'), 'utf8'));
eval(fs.readFileSync(path.join(SRC, 'matcher.js'), 'utf8'));
eval(fs.readFileSync(path.join(SRC, 'card.js'), 'utf8'));

const HMP = window.HMP;
const CARD = HMP.card;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (detail ? '  → ' + detail : '')); }
}
const cardText = () => {
  const card = document.getElementById(CARD.CARD_ID);
  if (!card) return '';
  const collect = n => {
    if (n.nodeType === 3) return String(n.textContent || '');
    let s = String(n._text || '');
    for (const c of (n.children || [])) s += collect(c);
    return s;
  };
  return collect(card);
};

(async () => {
  // ============ ① 可参观类型优先 ============
  console.log('\n=== ① 可参观类型优先（三山会馆）===');
  {
    // 真实数据：站点名「三山会馆」，上海黄浦区
    const poi = {
      name: '三山会馆', nameVariants: ['三山会馆'], city: '上海市',
      gcj: [121.4940, 31.2075], bd09: [121.5002, 31.2137],
    };
    // 两个候选：办事机构 vs 博物馆
    responsePlan = {
      '上海市 三山会馆': { delay: 0, pois: [
        { id: 'a1', name: '上海三山会馆管理委', type: '政府机构;社会团体',
          location: '121.4940,31.2075' },
        { id: 'a2', name: '上海三山会馆', type: '科教文化服务;博物馆',
          location: '121.4942,31.2077', business: { opentime_today: '09:00-16:30' } },
      ] },
    };
    const r = await CARD.searchByName({ amapKey: 'K' }, 'amap', poi);
    console.log('  选中：' + (r ? r.matched.poi.name : 'null'));
    check('匹配到「上海三山会馆」而非「…管理委」',
      !!r && r.matched.poi.name === '上海三山会馆', r ? r.matched.poi.name : 'null');

    // 类型打分本身的语义
    check('博物馆判为可参观(2)', CARD.heritageRank({ type: '科教文化服务;博物馆' }) === 2);
    check('政府机构判为未知(1)', CARD.heritageRank({ name: 'X', type: '政府机构;社会团体' }) === 1);

    // 仅差一点相似度时，类型仍应能扭转结果
    responsePlan = {
      '上海市 乙会馆': { delay: 0, pois: [
        { id: 'b1', name: '乙会馆管理委', type: '政府机构;社会团体', location: '121.49,31.20' },
        { id: 'b2', name: '乙会馆旧址', type: '风景名胜;文物古迹', location: '121.49,31.20' },
      ] },
    };
    const r2 = await CARD.searchByName({ amapKey: 'K' }, 'amap',
      { name: '乙会馆', nameVariants: ['乙会馆'], city: '上海市', gcj: [121.49, 31.20] });
    check('遗址/景点类胜过管理委', !!r2 && r2.matched.poi.name === '乙会馆旧址',
      r2 ? r2.matched.poi.name : 'null');
  }

  // ============ ② 切换点位必须刷新（乱序响应） ============
  console.log('\n=== ② 快速切换点位时的乱序响应 ===');
  {
    const geo = HMP.geo;
    const stele = (lo, la) => [(lo - geo.AFFINE.lonB) / geo.AFFINE.lonA,
      (la - geo.AFFINE.latB) / geo.AFFINE.latA];

    // 甲：慢（300ms）；乙：快（20ms）→ 甲的响应会后到
    responsePlan = {
      '上海市 甲会馆': { delay: 300, pois: [
        { id: 'j1', name: '甲会馆', type: '风景名胜;文物古迹',
          location: '121.4800,31.2200', business: { opentime_today: '09:00-17:00' } } ] },
      '上海市 乙会馆': { delay: 20, pois: [
        { id: 'y1', name: '乙会馆', type: '风景名胜;文物古迹',
          location: '121.4900,31.2100', business: { opentime_today: '10:00-18:00' } } ] },
    };
    const featA = { name: '甲会馆', feature_type: '文物古迹', admin: ['上海市 黄浦区'],
      geom: { type: 'Point', coordinates: stele(121.48, 31.22) } };
    const featB = { name: '乙会馆', feature_type: '文物古迹', admin: ['上海市 黄浦区'],
      geom: { type: 'Point', coordinates: stele(121.49, 31.21) } };

    // 清掉缓存，确保真的走网络
    await HMP.cache.clear();

    emit('hmp:poi-loaded', featA);          // 先点甲（慢）
    await sleep(30);
    emit('hmp:poi-loaded', featB);          // 立刻切到乙（快）

    await sleep(600);                        // 等两个响应都回来
    const text = cardText();
    console.log('  最终卡片文本：' + JSON.stringify(text));
    // 注意：命中时若地图 POI 名与文保名一致，卡片不会重复显示名称，
    // 所以这里用"开放时间"来判断到底是哪个点位的数据。
    check('最终卡片反映的是乙（乙的开放时间在场）', text.includes('10:00-18:00'));
    check('甲（较晚返回）没有覆盖乙', !text.includes('09:00-17:00'));
  }

  // ============ ③ 可能不开放的提醒 ============
  console.log('\n=== ③ 「暂停开放」等状态提醒 ===');
  {
    // 高德把状态写进名称的情形
    CARD.renderState({
      card: 'single', kind: 'found', provider: 'amap', providerLabel: '高德地图',
      matchType: 'name', siteName: '董家渡天主堂',
      info: { name: '董家渡天主堂（暂停开放）', address: '董家渡路175号' },
      amapSearchUrl: '#', baiduSearchUrl: '#',
    });
    await sleep(80);
    let text = cardText();
    console.log('  卡片文本：' + JSON.stringify(text));
    check('出现「可能不开放」提醒', text.includes('可能不开放'));
    check('提醒里带出命中词「暂停」', text.includes('暂停'));
    check('提示了先电话确认', text.includes('电话确认'));

    // 百度用 status 字段的情形
    CARD.renderState({
      card: 'single', kind: 'found', provider: 'baidu', providerLabel: '百度地图',
      matchType: 'name', siteName: '某故居',
      info: { name: '某故居', status: '已关闭', address: '某路1号' },
      amapSearchUrl: '#', baiduSearchUrl: '#',
    });
    await sleep(80);
    text = cardText();
    check('status=已关闭 也会提醒', text.includes('可能不开放') && text.includes('关闭'));

    // 正常点位不应误报
    CARD.renderState({
      card: 'single', kind: 'found', provider: 'amap', providerLabel: '高德地图',
      matchType: 'name', siteName: '故宫',
      info: { name: '故宫博物院', opentimeWeek: '周二至周日 08:30-17:00', address: '景山前街4号' },
      amapSearchUrl: '#', baiduSearchUrl: '#',
    });
    await sleep(80);
    text = cardText();
    check('正常点位不误报', !text.includes('可能不开放'));
  }

  // ============ ④ 设施类地点必须被排除 ============
  console.log('\n=== ④ 公交站/打卡点等设施类不得被匹配 ===');
  {
    const R = CARD.heritageRank;

    console.log('  --- 类型判断 ---');
    check('公交车站 → 排除', R({ name: 'X', type: '交通设施服务;公交车站' }) === 0);
    check('地铁站 → 排除', R({ name: 'X', type: '交通设施服务;地铁站' }) === 0);
    check('停车场 → 排除', R({ name: 'X', type: '交通设施服务;停车场' }) === 0);
    check('出入口 → 排除', R({ name: 'X', type: '交通设施服务;出入口' }) === 0);
    check('公共厕所 → 排除', R({ name: 'X', type: '公共设施;公共厕所' }) === 0);
    check('博物馆 → 可参观(2)', R({ name: 'X', type: '科教文化服务;博物馆' }) === 2);
    check('大学校区 → 可参观(2)（圣约翰那类需要）',
      R({ name: 'X', type: '科教文化服务;学校' }) === 2);

    console.log('  --- 曾经的漏洞：名称命中文保名不能救回设施类 ---');
    check('「故宫」公交站（类型是公交车站）仍判排除',
      R({ name: '故宫', type: '交通设施服务;公交车站' }) === 0,
      String(R({ name: '故宫', type: '交通设施服务;公交车站' })));
    check('「外滩打卡点」判排除',
      R({ name: '外滩打卡点', type: '风景名胜;风景名胜' }) === 0);
    check('「豫园地铁站」判排除',
      R({ name: '豫园地铁站', type: '交通设施服务;地铁站' }) === 0);

    console.log('  --- 类型缺失时按名称兜底（百度常返回英文分类）---');
    check('类型缺失 + 名称含"公交站" → 排除', R({ name: 'XX路公交站', type: '' }) === 0);
    check('类型缺失 + 名称含"打卡点" → 排除', R({ name: '武康路打卡点', type: '' }) === 0);
    check('类型缺失 + 名称含"停车场" → 排除', R({ name: '景区停车场', type: '' }) === 0);

    console.log('  --- 不能误伤文保名称 ---');
    check('「老火车站旧址」（类型=文物古迹）保留',
      R({ name: '老火车站旧址', type: '风景名胜;文物古迹' }) === 2);
    check('「车站路故居」（类型=故居）保留',
      R({ name: '车站路故居', type: '科教文化服务;故居' }) === 2);
    check('「天桥剧场」（类型=文化）不被"天桥"误伤',
      R({ name: '天桥剧场', type: '科教文化服务;文化' }) === 2);

    console.log('  --- 端到端：只有公交站候选时应判为未匹配 ---');
    responsePlan = {
      '上海市 某会馆': { delay: 0, pois: [
        { id: 'bus1', name: '某会馆', type: '交通设施服务;公交车站', location: '121.49,31.23' },
        { id: 'pk1', name: '某会馆打卡点', type: '风景名胜;风景名胜', location: '121.49,31.23' },
      ] },
    };
    const r = await CARD.searchByName({ amapKey: 'K' }, 'amap',
      { name: '某会馆', nameVariants: ['某会馆'], city: '上海市', gcj: [121.49, 31.23] });
    check('只有设施类候选 → 不采用（返回 null）', r === null, r ? r.matched.poi.name : 'null');

    console.log('  --- 端到端：设施类被排除后仍能选中真正的点位 ---');
    responsePlan = {
      '上海市 某会馆': { delay: 0, pois: [
        { id: 'bus1', name: '某会馆', type: '交通设施服务;公交车站', location: '121.49,31.23' },
        { id: 'ok1', name: '某会馆旧址', type: '风景名胜;文物古迹',
          location: '121.4905,31.2305', business: { opentime_today: '09:00-17:00' } },
      ] },
    };
    const r2 = await CARD.searchByName({ amapKey: 'K' }, 'amap',
      { name: '某会馆', nameVariants: ['某会馆'], city: '上海市', gcj: [121.49, 31.23] });
    check('越过公交站选中「某会馆旧址」',
      !!r2 && r2.matched.poi.name === '某会馆旧址', r2 ? r2.matched.poi.name : 'null');

    console.log('  --- 用户实测的确切名称 ---');
    check('「上海孙中山故居纪念馆-草坪与建筑(打卡点)」排除',
      R({ name: '上海孙中山故居纪念馆-草坪与建筑(打卡点)', type: '风景名胜;风景名胜' }) === 0,
      String(R({ name: '上海孙中山故居纪念馆-草坪与建筑(打卡点)', type: '风景名胜;风景名胜' })));
    check('同上（类型字段为空时）',
      R({ name: '上海孙中山故居纪念馆-草坪与建筑(打卡点)', type: '' }) === 0);
    check('本体「上海孙中山故居纪念馆」仍保留',
      R({ name: '上海孙中山故居纪念馆', type: '科教文化服务;博物馆' }) === 2);

    console.log('  --- "打卡"的各种写法都要覆盖 ---');
    check('「XX打卡点」排除', R({ name: '武康大楼打卡点', type: '' }) === 0);
    check('「XX打卡地」排除', R({ name: '武康大楼打卡地', type: '' }) === 0);
    check('「XX网红打卡」排除', R({ name: '武康大楼网红打卡', type: '' }) === 0);
    check('「XX拍照打卡」排除', R({ name: '武康大楼拍照打卡', type: '' }) === 0);
    check('类型含"打卡"也排除',
      R({ name: '武康大楼', type: '风景名胜;网红打卡地' }) === 0);
  }

  // ============ ⑤ 缓存必须带数据版本 ============
  console.log('\n=== ⑤ 逻辑更新后不得命中旧缓存 ===');
  {
    check('缓存键含数据版本号',
      HMP.cache.PREFIX.includes('v' + HMP.cache.DATA_VERSION), HMP.cache.PREFIX);
    check('DATA_VERSION 已导出（便于诊断）', typeof HMP.cache.DATA_VERSION === 'number');

    // 塞一条"旧版本"键，确认读不到
    const oldKey = 'hmp:cache:v1:amap:oldkey';
    await new Promise(res => chrome.storage.local.set({
      [oldKey]: { data: { matched: { name: '旧版错误结果' } }, expireAt: Date.now() + 1e7 },
    }, res));
    const got = await HMP.cache.get('amap', '任意', '任意');
    check('旧版本缓存不会被读到', got === null, JSON.stringify(got));

    // 旧版本键应交由 purgeOldVersions 清掉，且不影响当前版本
    const n1 = await HMP.cache.purgeOldVersions();
    check('purgeOldVersions 清掉旧版本键', n1 >= 1, '清理 ' + n1 + ' 条');

    await HMP.cache.set('amap', '甲', '乙', { matched: null });
    const n2 = await HMP.cache.purgeOldVersions();
    check('当前版本键不会被误删', n2 === 0, '清理 ' + n2 + ' 条');
    const still = await HMP.cache.get('amap', '甲', '乙');
    check('当前版本缓存仍可正常读取', still !== null);

    // clear 必须跨版本清理
    await HMP.cache.clear();
    const all = await new Promise(res => chrome.storage.local.get(null, res));
    const left = Object.keys(all).filter(k => k.startsWith('hmp:cache:'));
    check('清除缓存会清掉所有版本（含旧版残留）', left.length === 0, left.join(','));
  }

  console.log('\n结果: 通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
