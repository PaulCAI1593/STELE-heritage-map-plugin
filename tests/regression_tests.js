// tests/regression_tests.js
// 回归测试：锁定本次修复的具体误匹配，防止复发；并跑一次端到端集成。
//
// 运行: node tests/regression_tests.js
'use strict';
const fs = require('fs');
const path = require('path');

global.window = global;

const SRC = path.join(__dirname, '..', 'src', 'content');
const FIX = path.join(__dirname, 'fixtures');

// ---- 环境 mock ----
const captured = [];
let canned = { status: '1', pois: [] };
global.fetch = async (url) => {
  captured.push(String(url));
  return { ok: true, status: 200, json: async () => canned };
};
// 最小可用 DOM：card.js 会先 buildSingleCard(...) 再 renderIntoModal(...)，
// 即使最终不插入，卡片元素也要能被构造出来。
function makeEl(tag) {
  return {
    tagName: tag, children: [], style: {}, attributes: {},
    className: '', id: '', _text: '', _html: '',
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k]; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {},
    remove() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    classList: { add() {}, remove() {} },
    set textContent(v) { this._text = v; },
    get textContent() { return this._text; },
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
  };
}
global.document = {
  body: makeEl('body'),
  getElementById: () => null,
  querySelector: () => null,          // → renderIntoModal 提前返回，不真正插入
  querySelectorAll: () => [],
  createElement: makeEl,
  createTextNode: (t) => ({ nodeType: 3, textContent: t }),
};
global.window.addEventListener = () => {};
global.MutationObserver = class { observe() {} disconnect() {} };
global.chrome = {
  storage: { local: {
    _store: { amapKey: 'K', baiduAk: '', defaultProvider: 'amap', enabled: true },
    get(k, cb) { const store = this._store || {}; const o = (k == null) ? Object.assign({}, store) : (() => { const r = {}; for (const x of (Array.isArray(k) ? k : [k])) if (x in store) r[x] = store[x]; return r; })(); if (cb) cb(o); return Promise.resolve(o); },
    set(i, cb) { Object.assign(this._store, i); if (cb) cb(); return Promise.resolve(); },
    remove(k, cb) { (Array.isArray(k) ? k : [k]).forEach(x => delete this._store[x]); if (cb) cb(); return Promise.resolve(); }
  } }
};

['decoder', 'naming', 'cache', 'http'].forEach(f => eval(fs.readFileSync(path.join(SRC, f + '.js'), 'utf8')));
eval(fs.readFileSync(path.join(SRC, 'apis', 'amap.js'), 'utf8'));
eval(fs.readFileSync(path.join(SRC, 'apis', 'baidu.js'), 'utf8'));
eval(fs.readFileSync(path.join(SRC, 'matcher.js'), 'utf8'));
eval(fs.readFileSync(path.join(SRC, 'card.js'), 'utf8'));

const HMP = window.HMP;
const M = HMP.matcher;
const N = HMP.naming;

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (detail ? '  → ' + detail : '')); }
}
function targetOf(name) {
  return { name, nameVariants: N.searchNames(name), city: '', lon: null, lat: null };
}
function pickName(name, candNames) {
  const r = M.pick(targetOf(name), candNames.map((n, i) => ({ name: n, id: 'c' + i })));
  return r ? r.poi.name : null;
}

// ============ 回归 1：过度去后缀导致的"撞车" ============
console.log('\n=== 回归1：规范化截断成短桩（"良渚遗址" vs "良渚博物院"）===');
check('不得把 良渚遗址-莫角山遗址 匹配到 良渚博物院',
  pickName('良渚遗址-莫角山遗址', ['良渚博物院', '良渚古城遗址公园']) === null);
check('但完全相同的名字仍应命中',
  pickName('良渚遗址', ['良渚遗址']) === '良渚遗址');
check('短名"故宫"规范化后仍可信（不该被守卫误伤）',
  pickName('故宫', ['故宫博物院']) === '故宫博物院');

// ============ 回归 2：衍生设施不得盖过本体 ============
console.log('\n=== 回归2：衍生设施 vs 本体 ===');
check('承德避暑山庄 应选 避暑山庄 而非 承德避暑山庄博物馆',
  pickName('承德避暑山庄及其周围寺庙', ['承德避暑山庄博物馆', '避暑山庄', '普宁寺']) === '避暑山庄');
check('故宫 应选 故宫博物院 而非 沈阳故宫博物院/明故宫',
  pickName('故宫', ['沈阳故宫博物院', '明故宫遗址公园', '故宫博物院']) === '故宫博物院');
check('秦始皇陵 应选本体而非 秦始皇陵博物院',
  pickName('秦始皇陵', ['秦始皇陵博物院', '秦始皇陵兵马俑', '秦始皇陵']) === '秦始皇陵');

// ============ 回归 3：不相关名称必须拒绝 ============
console.log('\n=== 回归3：负样本（必须不匹配）===');
check('布达拉宫 ✗ 天安门', pickName('布达拉宫', ['天安门', '黄山风景区']) === null);
check('莫高窟 ✗ 敦煌博物馆', pickName('莫高窟', ['敦煌博物馆', '鸣沙山月牙泉']) === null);
check('殷墟 ✗ 安阳博物馆', pickName('殷墟', ['安阳博物馆', '中国文字博物馆']) === null);

// ============ 回归 4：跨城同名靠「市级」区分（查询层）============
console.log('\n=== 回归4：跨城同名的查询词构造 ===');
const s1 = N.extractCity(['晋中市 平遥县']);
const s2 = N.extractCity(['丽江市 古城区']);
check('平遥古城 → 晋中市', s1 === '晋中市', s1);
check('丽江古城 → 丽江市', s2 === '丽江市', s2);
check('两者查询词不同（可区分同名古城）', ('晋中市 平遥古城') !== ('丽江市 丽江古城'));

// ============ 端到端：card.processSingle 多轮变体检索 ============
(async () => {
  console.log('\n=== 端到端：processSingle 对"承德避暑山庄"多变体检索 ===');
  const feat = HMP.decoder.normalize(
    JSON.parse(fs.readFileSync(path.join(FIX, 'feature_承德避暑山庄.json'), 'utf8'))
  );
  // 第 1 轮（全名）无结果；第 2 轮（"承德避暑山庄"）返回 避暑山庄
  canned = { status: '1', pois: [] };
  const round1 = { status: '1', pois: [] };
  const round2 = { status: '1', pois: [{ id: 'x1', name: '避暑山庄', location: '117.94,40.99', business: { opentimeToday: '08:00-17:30', tel: '0314-2029771' } }] };
  let call = 0;
  global.fetch = async (url) => { captured.push(String(url)); call++; return { ok: true, status: 200, json: async () => (call === 1 ? round1 : round2) }; };

  captured.length = 0;
  await HMP.card.processSingle(feat);
  await new Promise(r => setTimeout(r, 50));

  check('发起了多次检索（多变体）', captured.length >= 2, '实际 ' + captured.length + ' 次');
  const all = captured.map(u => new URL(u).searchParams.get('keywords'));
  check('第1次用全名', all[0] === '承德市 承德避暑山庄及其周围寺庙', all[0]);
  check('第2次用截断变体', all[1] === '承德市 承德避暑山庄', all[1]);
  check('所有请求都不含 location/radius',
    captured.every(u => !new URL(u).searchParams.has('location') && !new URL(u).searchParams.has('radius')));
  check('缓存已写入', Object.keys(chrome.storage.local._store).some(k => k.startsWith('hmp:cache:')),
    Object.keys(chrome.storage.local._store).join(','));

  console.log('\n结果: 通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
