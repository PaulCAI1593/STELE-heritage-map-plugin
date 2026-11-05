// tests/decision_log_tests.js
// 条目 5：导出最近 20 条匹配决策（hmp:decisionLog 环形 20），且导出内容不含 API Key。
// 运行: node tests/decision_log_tests.js
'use strict';
const env = require('./_env');
const { check, finish } = env.makeChecker('decision-log');

env.setup({});
env.load('content/decision-log.js');
const log = global.window.HMP.decisionLog;

(async function () {
  check('存储键 = hmp:decisionLog', log.STORAGE_KEY === 'hmp:decisionLog', log.STORAGE_KEY);
  check('环形上限 = 20', log.MAX_ENTRIES === 20, String(log.MAX_ENTRIES));

  // ── 负例①：URL 里的 key= / ak= 参数被打码 ──
  const masked = log.sanitize({
    url: 'https://restapi.amap.com/v3/place/text?keywords=x&key=SECRET_AMAP&foo=1',
    url2: 'https://api.map.baidu.com/place/v2/search?ak=SECRET_BAIDU&output=json',
    plain: 'key=SECRET_PLAIN',
  });
  check('URL 中 key= 被打码', masked.url.indexOf('key=***') >= 0 && masked.url.indexOf('SECRET_AMAP') < 0, masked.url);
  check('URL 中 ak= 被打码', masked.url2.indexOf('ak=***') >= 0 && masked.url2.indexOf('SECRET_BAIDU') < 0, masked.url2);
  check('裸串 key= 被打码', masked.plain.indexOf('SECRET_PLAIN') < 0 && masked.plain.indexOf('key=***') >= 0, masked.plain);

  // ── 负例②：密钥字段整个丢弃（不是打码）──
  const dropped = log.sanitize({
    amapKey: 'K1', baiduAk: 'K2', apiKey: 'K3', key: 'K4', ak: 'K5', token: 'K6',
    password: 'K7', provider: 'amap', site: '某点位',
  });
  const leaked = ['K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7'].filter(k => JSON.stringify(dropped).indexOf(k) >= 0);
  check('密钥字段全部丢弃', leaked.length === 0, JSON.stringify(dropped));
  check('非密钥字段保留', dropped.provider === 'amap' && dropped.site === '某点位', JSON.stringify(dropped));

  // ── 负例③：空日志导出必须是 [] ──
  await log.clear();
  check('空日志导出 = []', (await log.exportJSON()).trim() === '[]', await log.exportJSON());

  // ── 环形 20：追加 25 条，只留最近 20 条 ──
  await log.clear();
  for (let i = 1; i <= 25; i++) await log.append({ site: 'p' + i, provider: 'amap' });
  const all = await log.all();
  check('追加 25 条后只保留 20 条', all.length === 20, 'len=' + all.length);
  check('最旧的 5 条被淘汰（首条是 p6）', all[0] && all[0].site === 'p6', all[0] && all[0].site);
  check('最后一条是 p25', all[19] && all[19].site === 'p25', all[19] && all[19].site);

  // ── 负例④：带 Key 的条目导出后不含 Key ──
  await log.clear();
  await log.append({
    site: '带密钥点位', provider: 'amap',
    amapKey: 'SECRET_IN_ENTRY',
    url: 'https://restapi.amap.com/v3/place/text?key=SECRET_IN_URL&q=1',
    final: {
      pickedName: '带密钥点位', sim: 1, score: 1, dist: 10, source: 'name',
      // v2 白名单只收契约字段；why 是唯一允许带自由文本的入口 → 必须打码
      why: ['https://restapi.amap.com/v3/place/text?key=SECRET_IN_URL&q=1'],
    },
  });
  const json = await log.exportJSON();
  check('导出 JSON 不含字段里的 Key', json.indexOf('SECRET_IN_ENTRY') < 0, json.slice(0, 200));
  check('导出 JSON 不含 URL 里的 Key', json.indexOf('SECRET_IN_URL') < 0, json.slice(0, 300));
  check('导出 JSON 里 key= 已打码', json.indexOf('key=***') >= 0, json.slice(0, 300));

  // ── 负例⑤：非对象入参不写日志 ──
  await log.clear();
  const r1 = await log.append(null);
  const r2 = await log.append('字符串');
  const after = await log.all();
  check('null / 字符串 不写入（负例）', r1 === null && r2 === null && after.length === 0,
    'len=' + after.length);

  // ── 卡片记录：字段齐全（时间/点位/provider/三路/最终）──
  env.setup({});
  env.loadContentScripts();
  const C = global.window.HMP.card;
  await global.window.HMP.decisionLog.clear();
  await C.recordDecision({ name: '测试点位' }, 'amap',
    { evidence: { amap: {
      name: { candCount: 3, bestSim: 0.91 },
      address: { candCount: 1, bestSim: 0.55 },
      nearby: { candCount: 0, bestSim: 0 },
    } } },
    { matchType: 'name', info: { name: '测试点位' },
      matched: { poi: { name: '测试点位' }, sim: 1, score: 0.93, dist: 12.6 } });
  const one = (await global.window.HMP.decisionLog.all())[0];
  check('记录 schema=2', one && one.schema === 2, one && one.schema);
  check('记录含时间 ts', !!one && !!one.ts && !isNaN(Date.parse(one.ts)), one && one.ts);
  check('记录含 stele 名称', one && one.stele && one.stele.name === '测试点位', JSON.stringify(one && one.stele));
  check('记录含三路候选数与最高相似度',
    one && one.routes.name.candCount === 3 && one.routes.name.bestSim === 0.91 &&
    one.routes.address.candCount === 1 && one.routes.nearby.candCount === 0,
    JSON.stringify(one && one.routes));
  check('记录含最终来源与分项',
    one && one.final && one.final.pickedName === '测试点位' && one.final.sim === 1 &&
    one.final.simAdj === 1 && one.final.score === 0.93 && one.final.dist === 13 &&
    one.final.source === 'name' && one.final.distScore === 1,
    JSON.stringify(one && one.final));
  check('记录 why 数组（本阶段只有 providerNotes）',
    one && Array.isArray(one.final.why), JSON.stringify(one && one.final && one.final.why));

  // 未命中：final=null，仍留一条
  await C.recordDecision({ name: '未命中点' }, 'baidu', { evidence: { baidu: { name: { candCount: 0, bestSim: 0 } } } }, null);
  const miss = (await global.window.HMP.decisionLog.all())[1];
  check('未命中记录 final=null、chosen=null（负例）',
    miss && miss.final === null && miss.chosen === null && miss.schema === 2, JSON.stringify(miss));

  // ── #14-L schema v2：三路 top5、字段集、排序、限长、旧 v1 兼容 ──
  const cand = (name, score, dist) => ({
    name, sim: score, simAdj: score, dist, distScore: 0.9,
    typeRank: 2, subPen: 1, pen: 1, source: 'name', score,
  });
  await log.clear();
  await log.append({
    site: 'v2点位', provider: 'amap',
    stele: { id: 's1', name: 'v2点位', tier: '全国重点' },
    routes: {
      name: { candCount: 9, bestSim: 0.93, candidates: [
        cand('c1', 0.93, 10), cand('c2', 0.88, 20), cand('c3', 0.81, 30),
        cand('c4', 0.72, 40), cand('c5', 0.65, 50), cand('c6', 0.60, 60),
        cand('c7', 0.55, 70),
      ] },
      address: { candCount: 0, bestSim: 0, candidates: [] },
      nearby: { candCount: 0, bestSim: 0 },
    },
    final: {
      pickedName: 'c1', sim: 0.93, simAdj: 0.93, dist: 10, distScore: 1,
      score: 0.95, source: 'name', why: new Array(15).fill('r'),
    },
  });
  const v2 = (await log.all())[0];
  check('v2：三路都在', v2 && v2.routes && !!v2.routes.name && !!v2.routes.address && !!v2.routes.nearby,
    JSON.stringify(v2 && Object.keys(v2.routes || {})));
  check('v2：候选最多 5 条', v2.routes.name.candidates.length === 5,
    'len=' + v2.routes.name.candidates.length);
  check('v2：candCount 保留总数 9（不是 5）', v2.routes.name.candCount === 9, String(v2.routes.name.candCount));
  check('v2：按 score 降序、同分按 dist',
    v2.routes.name.candidates.map(c => c.score).join() === '0.93,0.88,0.81,0.72,0.65',
    v2.routes.name.candidates.map(c => c.score).join());
  // #24：契约加 exactName（schema 仍为 2）；coordinateDriftKm 仅在 3–10 km 同名命中时出现，属可选字段
  // #27：契约再加 shortForm/shortFormCore；旧日志没有这两个字段，读取侧按 false/null 处理
  const KEYS = ['name', 'sim', 'simAdj', 'dist', 'distScore', 'typeRank', 'subPen', 'pen', 'source', 'score', 'exactName', 'shortForm', 'shortFormCore'];
  check('v2：候选必备字段集为契约 13 项（+ #24 exactName、#27 shortForm/shortFormCore，可选 coordinateDriftKm）',
    v2.routes.name.candidates.every(c => KEYS.every(k => k in c)) &&
    v2.routes.name.candidates.every(c => Object.keys(c).length >= KEYS.length && Object.keys(c).length <= KEYS.length + 1),
    JSON.stringify(Object.keys(v2.routes.name.candidates[0])));
  check('v2：commit L 的 simAdj 恒等 sim',
    v2.routes.name.candidates.every(c => c.simAdj === c.sim) && v2.final.simAdj === v2.final.sim,
    JSON.stringify(v2.final));
  check('v2：why 最多 10 条', v2.final.why.length === 10, 'len=' + v2.final.why.length);
  check('v2：长名称截到 120 字以内（负例）', (() => {
    // 直接测归一化函数，避免再造一条日志
    const n = log.__test.normalizeV2({ stele: { name: 'x'.repeat(300) } });
    return n.stele.name.length <= 121 && /…$/.test(n.stele.name);
  })(), '');

  // 旧 v1 记录：不经 append，直接塞进 storage，仍能读且标 schema:1
  await log.clear();
  const rawV1 = [{
    time: '2026-11-01T00:00:00.000Z', site: '旧点位', provider: 'baidu',
    evidence: { name: { candCount: 2, bestSim: 0.7 } },
    chosen: 'name',
    final: { poi: '旧点位', sim: 0.7, score: 0.8, dist: 5 },
  }];
  await new Promise(r => chrome.storage.local.set({ [log.STORAGE_KEY]: rawV1 }, r));
  const readBack = await log.all();
  check('旧 v1 仍能读', readBack.length === 1 && readBack[0].site === '旧点位', JSON.stringify(readBack));
  check('旧 v1 标 schema:1 · 无候选明细',
    readBack[0].schema === 1 && readBack[0].note === '无候选明细', JSON.stringify(readBack[0].schema));
  check('旧 v1 导出含 schema:1（可读）',
    (await log.exportJSON()).indexOf('"schema": 1') >= 0, '');

  // 环形：v1 与 v2 混存也不丢
  await log.append({ site: '新点位', provider: 'amap' });
  const mixed = await log.all();
  check('v1+v2 混存：都能读且条数正确', mixed.length === 2 &&
    mixed[0].schema === 1 && mixed[1].schema === 2, mixed.map(x => x.schema).join());

  // ── #26：远距离提示的日志字段 ──
  await log.clear();
  await log.append({
    site: '远距离点位', provider: 'amap',
    final: { pickedName: '远距离点位', sim: 0.9, dist: 3400, source: 'name', coordinateDistanceKm: 3.4 },
  });
  const farEntry = (await log.all())[0];
  check('#26 final.coordinateDistanceKm 保留（3.4）',
    farEntry.final.coordinateDistanceKm === 3.4, JSON.stringify(farEntry.final));
  await log.append({
    site: '同名远点', provider: 'amap',
    final: {
      pickedName: '同名远点', sim: 1, dist: 6672, source: 'name',
      exactName: true, coordinateDriftKm: 6.7, coordinateDistanceKm: 6.7,
    },
  });
  const exactEntry = (await log.all())[1];
  check('#26 exact 时 coordinateDriftKm 与 coordinateDistanceKm 并存',
    exactEntry.final.coordinateDriftKm === 6.7 && exactEntry.final.coordinateDistanceKm === 6.7,
    JSON.stringify(exactEntry.final));
  await log.append({ site: '旧记录', provider: 'amap', final: { pickedName: '旧记录', sim: 1, dist: 10, source: 'name' } });
  const compatEntry = (await log.all())[2];
  check('#26 旧记录没有该字段也照常读（不补空字段）',
    compatEntry.final && !('coordinateDistanceKm' in compatEntry.final),
    JSON.stringify(compatEntry.final));
  await log.append({ site: '越界', provider: 'amap', final: { pickedName: '越界', sim: 1, dist: 10, source: 'name', coordinateDistanceKm: 5000 } });
  const outEntry = (await log.all())[3];
  check('#26 越界的 coordinateDistanceKm 不写（负例）',
    outEntry.final && !('coordinateDistanceKm' in outEntry.final), JSON.stringify(outEntry.final));

  // #27：短名后缀字段（候选 + final），旧记录没有时按 false/null 读
  await log.append({
    site: '靳岗天主教堂', provider: 'amap',
    routes: { name: { candidates: [{ name: '天主堂', sim: 0.5, simAdj: 0.86, dist: 200, score: 0.8, shortForm: true, shortFormCore: '天主' }] } },
    final: { pickedName: '天主堂', sim: 0.5, simAdj: 0.86, dist: 200, source: 'name', shortForm: true, shortFormCore: '天主' },
  });
  const sfEntry = (await log.all()).find(e => e.site === '靳岗天主教堂');
  check('#27 候选带 shortForm/shortFormCore',
    !!sfEntry && sfEntry.routes.name.candidates.length === 1 &&
    sfEntry.routes.name.candidates[0].shortForm === true && sfEntry.routes.name.candidates[0].shortFormCore === '天主',
    sfEntry && JSON.stringify(sfEntry.routes.name.candidates));
  check('#27 final 带 shortForm/shortFormCore（sim 保留原值 0.5、simAdj 0.86）',
    !!sfEntry && sfEntry.final.shortForm === true && sfEntry.final.shortFormCore === '天主' &&
    sfEntry.final.sim === 0.5 && sfEntry.final.simAdj === 0.86, sfEntry && JSON.stringify(sfEntry.final));
  await log.append({ site: '短名旧记录', provider: 'amap', final: { pickedName: '短名旧记录', sim: 1, dist: 10, source: 'name' } });
  const sfCompat = (await log.all()).find(e => e.site === '短名旧记录');
  check('#27 旧记录读成 shortForm=false / shortFormCore=null',
    !!sfCompat && sfCompat.final.shortForm === false && sfCompat.final.shortFormCore === null, sfCompat && JSON.stringify(sfCompat.final));

  finish();
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
