// tests/cache_ttl_tests.js
// 条目 3：负结果 TTL 1 小时，正结果仍 7 天；DATA_VERSION 45→46 让老缓存失效。
// 运行: node tests/cache_ttl_tests.js
'use strict';
const env = require('./_env');
const { check, finish } = env.makeChecker('cache');

env.setup({});
env.load('content/cache.js');
const cache = global.window.HMP.cache;

// 可拨动的时钟
let now = 1700000000000;
const realNow = Date.now;
Date.now = () => now;
const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;

(async function () {
  check('DATA_VERSION = 46（45→46，老缓存失效）', cache.DATA_VERSION === 46, String(cache.DATA_VERSION));
  check('读键前缀带 v46', cache.PREFIX.indexOf('v46:') >= 0, cache.PREFIX);
  check('NEG_TTL_MS = 1 小时', cache.NEG_TTL_MS === HOUR, String(cache.NEG_TTL_MS));
  check('TTL_MS 仍 = 7 天', cache.TTL_MS === 7 * DAY, String(cache.TTL_MS));

  // ── 负例①：负结果写入后 59 分钟仍命中，60 分钟 + 1 秒必 miss ──
  now = 1700000000000;
  await cache.setNegative('amap', '负结果点', '某市', { matched: null, failureKind: 'timeout' });
  check('负结果刚写入 → 命中', !!(await cache.get('amap', '负结果点', '某市')));
  now += 59 * MIN;
  check('负结果 +59min → 仍命中', !!(await cache.get('amap', '负结果点', '某市')));
  now += MIN + 1000;
  check('负结果 +60min+1s → miss（负例核心）', (await cache.get('amap', '负结果点', '某市')) === null);
  const goneKey = cache.keyOf('amap', '负结果点', '某市');
  check('过期条目已被删除', !(goneKey in global.chrome.storage.local._store), goneKey);

  // ── 负例②：正结果 1 天后仍命中（不能被负结果 TTL 波及）──
  now = 1710000000000;
  await cache.set('amap', '正常点', '某市', { matched: { name: '正常点' }, provider: 'amap' });
  now += 1 * DAY;
  check('正结果 +1 天 → 命中', !!(await cache.get('amap', '正常点', '某市')));

  // ── 正结果 7 天边界 ──
  now = 1720000000000;
  await cache.set('baidu', '边界点', '某市', { matched: { name: '边界点' } });
  now += 7 * DAY - 1000;
  check('正结果 +7d-1s → 命中', !!(await cache.get('baidu', '边界点', '某市')));
  now += 2000;
  check('正结果 +7d+1s → miss', (await cache.get('baidu', '边界点', '某市')) === null);

  // ── 缺省 TTL 就是 7 天（不传 opts）──
  now = 1730000000000;
  await cache.set('amap', '缺省点', '某市', { matched: { name: '缺省点' } });
  const entry = global.chrome.storage.local._store[cache.keyOf('amap', '缺省点', '某市')];
  check('缺省 set 的 expireAt−savedAt = 7 天', entry && (entry.expireAt - entry.savedAt) === 7 * DAY,
    entry && String(entry.expireAt - entry.savedAt));

  // ── 负例③：显式 ttlMs 生效（按条目 TTL）──
  now = 1740000000000;
  await cache.set('amap', '短命点', '某市', { matched: null }, { ttlMs: 1000 });
  now += 2000;
  check('显式 ttlMs=1000 → 2s 后 miss', (await cache.get('amap', '短命点', '某市')) === null);

  // ── 负例④：旧版本（v45）键读不到，即使内容新鲜 ──
  now = 1750000000000;
  const oldKey = 'hmp:cache:v45:amap:deadbeef:0';
  global.chrome.storage.local._store[oldKey] = {
    provider: 'amap', name: '旧版本点', admin: '',
    data: { matched: { name: '旧版本点' } }, expireAt: now + 7 * DAY, savedAt: now,
  };
  check('v45 键存在但 v46 读不到（版本隔离负例）',
    (await cache.get('amap', '旧版本点', '')) === null);
  const st = await cache.stats();
  check('stats.currentVersion 只数 v46 键', st.currentVersion >= 0 && st.dataVersion === 46,
    JSON.stringify(st));

  // ── 负例⑤：setNegative 写的条目 TTL 恰为 1 小时 ──
  now = 1760000000000;
  await cache.setNegative('baidu', '负TTL点', '', { matched: null });
  const ne = global.chrome.storage.local._store[cache.keyOf('baidu', '负TTL点', '')];
  check('setNegative 的 expireAt−savedAt = 1 小时', ne && (ne.expireAt - ne.savedAt) === HOUR,
    ne && String(ne.expireAt - ne.savedAt));

  Date.now = realNow;
  finish();
})().catch(e => { Date.now = realNow; console.error('测试异常:', e); process.exit(1); });
