// tests/evidence_tests.js
// 条目 4：卡片显示「三路证据」——名称/地址/坐标各自候选数与最高相似度。
// 数据只来自 matcher.pick 的 opts.dump 与各路打分结果；不改 pick 算法/阈值。
// 运行: node tests/evidence_tests.js
'use strict';
const env = require('./_env');
const { check, finish } = env.makeChecker('evidence');

env.setup({});
env.loadContentScripts();
const C = global.window.HMP.card;
const M = global.window.HMP.matcher;

// ── 纯函数：formatEvidence ──
check('无统计 → 空串（不渲染空行）', C.formatEvidence(null) === '' && C.formatEvidence({}) === '',
  JSON.stringify([C.formatEvidence(null), C.formatEvidence({})]));

const ev = {
  name: { candCount: 3, bestSim: 0.821 },
  address: { candCount: 1, bestSim: 0.61 },
  nearby: { candCount: 5, bestSim: 0.744 },
};
const text = C.formatEvidence(ev);
check('含名称路候选数与最高相似度', text.indexOf('名称 3 候选（最高 0.82') >= 0, text);
check('含地址路候选数与最高相似度', text.indexOf('地址 1 候选（最高 0.61') >= 0, text);
check('含坐标路候选数与最高相似度', text.indexOf('坐标 5 候选（最高 0.74') >= 0, text);
check('整行以「三路证据：」开头', text.indexOf('三路证据：') === 0, text);
check('长度受控（≤150）', text.length <= 150, 'len=' + text.length);

// 阈值只读取现有常量：0.86 达强证据线，0.84 不达（边界负例）
const hi = C.formatEvidence({ name: { candCount: 2, bestSim: 0.86 } });
const lo = C.formatEvidence({ name: { candCount: 2, bestSim: 0.84 } });
check('强证据阈值来自 NAME_STRONG_SIM（0.85）', M && typeof M.pick === 'function' &&
  hi.indexOf('达强证据线 0.85') >= 0, hi);
check('0.84 不标强证据（负例）', lo.indexOf('达强证据线') < 0, lo);
check('缺失的路不显示（负例：只有名称）',
  lo.indexOf('地址') < 0 && lo.indexOf('坐标') < 0, lo);

// ── 路由函数带收集器：不改匹配结果，只多记两数 ──
(async function () {
  const cands = [
    { id: 'a1', name: '测试点位', type: '风景名胜', lon: 121.47, lat: 31.23, address: '某路1号' },
    { id: 'a2', name: '测试点位旧址', type: '风景名胜', lon: 121.48, lat: 31.24, address: '某路2号' },
  ];
  global.window.HMP.apis.amap = { search: async () => cands.slice(), extract: c => c };
  const poi = { name: '测试点位', city: '上海市', gcj: [121.47, 31.23], nameVariants: ['测试点位'] };

  const evName = {};
  const hit = await C.searchByName({ amapKey: 'k' }, 'amap', poi, evName);
  check('searchByName 传 ev → 记录候选数', evName.candCount === 2, JSON.stringify(evName));
  check('searchByName 传 ev → 记录最高相似度', evName.bestSim >= 0.99, String(evName.bestSim));
  check('searchByName 匹配结果未变（sim 仍 ≥0.99）', !!hit && hit.matched.sim >= 0.99,
    hit && String(hit.matched.sim));

  // 负例：不传 ev 时不抛错（向后兼容）
  let threw = null;
  try { await C.searchByName({ amapKey: 'k' }, 'amap', poi); } catch (e) { threw = e; }
  check('不传 ev 仍可正常调用（负例）', threw === null, threw && threw.message);

  // ── 卡片渲染：命中态小字、未命中态必显 ──
  const evTxt = C.formatEvidence(ev);
  C.renderState({ card: 'single', kind: 'not-found', provider: 'amap', providerLabel: '高德地图',
    failureKind: 'no-candidates', evidenceText: evTxt,
    amapSearchUrl: 'https://x', baiduSearchUrl: 'https://y' });
  await new Promise(r => setTimeout(r, 10));
  const nf = env.textOf(global.__hmpBasicEl.parentNode);
  check('未命中卡片显示证据行', nf.indexOf('三路证据') >= 0, nf.slice(0, 160));
  check('未命中卡片仍显示原因文案', nf.indexOf('三路检索均未搜到候选') >= 0, nf.slice(0, 160));

  C.renderState({ card: 'single', kind: 'found', provider: 'amap', providerLabel: '高德地图',
    info: { name: '测试点位', address: '某路1号' }, siteName: '测试点位',
    matchType: 'name', evidenceText: evTxt,
    amapSearchUrl: 'https://x', baiduSearchUrl: 'https://y' });
  await new Promise(r => setTimeout(r, 10));
  const fd = env.textOf(global.__hmpBasicEl.parentNode);
  check('命中卡片显示证据行', fd.indexOf('三路证据') >= 0, fd.slice(0, 160));

  // 负例：没有统计时不渲染空证据行
  C.renderState({ card: 'single', kind: 'found', info: { name: '测试点位' }, siteName: '测试点位',
    matchType: 'name', evidenceText: '',
    amapSearchUrl: 'https://x', baiduSearchUrl: 'https://y' });
  await new Promise(r => setTimeout(r, 10));
  const none = env.textOf(global.__hmpBasicEl.parentNode);
  check('无统计时不出现「三路证据」空行（负例）', none.indexOf('三路证据') < 0, none.slice(0, 120));

  finish();
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
