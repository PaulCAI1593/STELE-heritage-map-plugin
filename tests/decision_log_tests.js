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
  });
  const json = await log.exportJSON();
  check('导出 JSON 不含字段里的 Key', json.indexOf('SECRET_IN_ENTRY') < 0, json.slice(0, 200));
  check('导出 JSON 不含 URL 里的 Key', json.indexOf('SECRET_IN_URL') < 0, json.slice(0, 200));
  check('导出 JSON 里 key= 已打码', json.indexOf('key=***') >= 0, json.slice(0, 200));

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
  check('记录含时间', !!one && !!one.time && !isNaN(Date.parse(one.time)), one && one.time);
  check('记录含点位与 provider', one && one.site === '测试点位' && one.provider === 'amap', JSON.stringify(one && one.site));
  check('记录含三路候选数与最高相似度',
    one && one.evidence.name.candCount === 3 && one.evidence.name.bestSim === 0.91 &&
    one.evidence.address.candCount === 1 && one.evidence.nearby.candCount === 0,
    JSON.stringify(one && one.evidence));
  check('记录含选中路径', one && one.chosen === 'name', one && one.chosen);
  check('记录含最终 poi/sim/score/dist',
    one && one.final.poi === '测试点位' && one.final.sim === 1 &&
    one.final.score === 0.93 && one.final.dist === 13,
    JSON.stringify(one && one.final));

  // 未命中：final=null，仍留一条
  await C.recordDecision({ name: '未命中点' }, 'baidu', { evidence: { baidu: { name: { candCount: 0, bestSim: 0 } } } }, null);
  const miss = (await global.window.HMP.decisionLog.all())[1];
  check('未命中记录 final=null、chosen=null（负例）',
    miss && miss.final === null && miss.chosen === null, JSON.stringify(miss));

  finish();
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
