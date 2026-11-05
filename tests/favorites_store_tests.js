// tests/favorites_store_tests.js
// #32a · 收藏夹数据层（hmp:favorites:v1）：CRUD、组、上限、schema 保护、搜索、脱敏
'use strict';
const fs = require('fs');
const path = require('path');
const env = require('./_env');
const { check, finish } = env.makeChecker('favorites');

env.setup({});
env.load('shared/favorites-store.js');

const S = global.window.HMP.favoritesStore;
const KEY = S.KEY;
const reset = () => { chrome.storage.local._store = {}; };
const lib = () => chrome.storage.local._store[KEY] || {};

(async () => {
  check('导出数据层（键名/schema/上限常量）',
    !!S && S.KEY === 'hmp:favorites:v1' && S.SCHEMA === 1 &&
    S.LIMITS.items === 500 && S.LIMITS.groups === 30 && S.LIMITS.bytes === 1024 * 1024);

  reset();
  const r0 = await S.read();
  check('read 缺失 → {empty:true} 且不抛', r0.empty === true);
  const gs0 = await S.listGroups();
  check('空库仍有默认系统组「未分组」',
    gs0.length === 1 && gs0[0].id === 'g-default' && gs0[0].system === true && gs0[0].name === '未分组');

  const a1 = await S.add({
    steleId: 'a1', name: '故宫', tier: '全国重点文物保护单位',
    address: '景山前街4号', admin: ['北京市 东城区'],
    match: { matchedName: '故宫', matchDist: 100, matchType: 'name', provider: 'amap' },
    info: { opentime: '08:00-17:00', cost: '60', address: '景山前街4号' },
    amapKey: 'SHOULD_DROP',
  });
  check('add 成功、默认组、丢弃未知字段', a1.ok === true && a1.item.groupId === 'g-default' && !('amapKey' in a1.item));
  check('写入单键 hmp:favorites:v1', Array.isArray(lib().items) && lib().items.length === 1);

  const dup = await S.add({ steleId: 'a1', name: '重复' });
  check('重复收藏 → duplicate + 组名，不覆盖原条目',
    dup.ok === false && dup.reason === 'duplicate' && dup.groupName === '未分组' &&
    lib().items.length === 1 && lib().items[0].name === '故宫');

  // #32c：同毫秒 savedAt 会让「最新在前」偶发失败（相等键排序保留插入序），先跨出毫秒边界
  const t0 = Date.now();
  while (Date.now() === t0) { /* 等到下一个毫秒 */ }
  await S.add({ steleId: 'a2', name: '颐和园' });
  const r2 = await S.read();
  check('items 按 savedAt 倒序（最新在前）', r2.items[0].steleId === 'a2' && r2.items[1].steleId === 'a1');

  const rm = await S.remove('a2');
  check('remove 删除成功', rm.ok === true && rm.removed === true && (await S.isSaved('a2')) === false);
  check('remove 不存在 → removed:false（不抛）', (await S.remove('nope')).removed === false);

  const cg = await S.createGroup('  出片组  ');
  check('createGroup：名称 trim', cg.ok === true && cg.group.name === '出片组');
  check('createGroup：重名拒绝', (await S.createGroup('出片组')).reason === 'duplicate-name');
  check('createGroup：超 24 字拒绝',
    (await S.createGroup('一二三四五六七八九十一二三四五六七八九十一二三四五')).reason === 'invalid-name');
  check('renameGroup 成功', (await S.renameGroup(cg.group.id, '出片')).ok === true);
  check('renameGroup：系统组拒绝', (await S.renameGroup('g-default', 'x')).reason === 'system');
  check('move 到组成功', (await S.move('a1', cg.group.id)).ok === true);
  check('move：未知组拒绝', (await S.move('a1', 'nope')).reason === 'unknown-group');
  const dg = await S.deleteGroup(cg.group.id);
  const afterDel = await S.read();
  check('删组不删条目：条目回到 g-default',
    dg.ok === true && dg.moved === 1 &&
    afterDel.items.length === 1 && afterDel.items[0].groupId === 'g-default');
  check('删组：默认组不可删', (await S.deleteGroup('g-default')).reason === 'system');

  // 搜索：名称 + 地址子串、大小写不敏感、trim、级别不参与
  reset();
  chrome.storage.local.set({
    [KEY]: {
      schema: 1,
      groups: [{ id: 'g-default', name: '未分组', system: true, createdAt: 0 },
        { id: 'g-x', name: '出片', system: false, createdAt: 1 }],
      items: [
        { steleId: 's1', name: '故宫', address: '北京市东城区景山前街', tier: '全国重点', savedAt: 3, groupId: 'g-default' },
        { steleId: 's2', name: '颐和园', address: '北京市海淀区', tier: '世界遗产', savedAt: 2, groupId: 'g-x' },
        { steleId: 's3', name: 'Forbidden City', address: '', tier: '全国重点', savedAt: 1, groupId: 'g-x' },
      ],
    },
  });
  check('search：名称子串 + trim', (await S.search('  故宫 ')).length === 1);
  check('search：地址子串', (await S.search('海淀')).length === 1 && (await S.search('海淀'))[0].steleId === 's2');
  check('search：大小写不敏感', (await S.search('forbidden')).length === 1);
  check('search：tier 不参与', (await S.search('全国重点')).length === 0);
  check('search：scope=group 只查该组',
    (await S.search('', 'group', 'g-x')).length === 2 && (await S.search('', 'group', 'g-default')).length === 1);
  check('search：空关键字返回全部（倒序）', (await S.search('')).length === 3);

  // 导出：脱敏、结构完整
  reset();
  await S.add({
    steleId: 'e1', name: '测试', match: { provider: 'amap' },
    amapKey: 'AK_SHOULD_NOT_LEAK', baiduAk: 'BAIDU_SHOULD_NOT_LEAK',
  });
  const exp = await S.exportJSON();
  const parsed = JSON.parse(exp);
  check('exportJSON：schema/groups/items 齐全', parsed.schema === 1 && Array.isArray(parsed.groups) && parsed.items.length === 1);
  check('exportJSON：不含 Key/AK', !exp.includes('amapKey') && !exp.includes('baiduAk') && !exp.includes('SHOULD_NOT_LEAK'));

  // schema 保护：>1 拒绝写入且不覆盖
  reset();
  chrome.storage.local.set({ [KEY]: { schema: 2, items: [{ steleId: 'old' }] } });
  const bad = await S.add({ steleId: 'new' });
  check('schema>1：拒写并返回 schema', bad.ok === false && bad.reason === 'schema');
  check('schema>1：原数据未被覆盖', lib().schema === 2 && lib().items[0].steleId === 'old');
  const rb = await S.read();
  check('read：不合法 schema → empty+corrupt、不抛', rb.empty === true && rb.corrupt === true);

  // 上限：条目 500
  reset();
  const many = [];
  for (let i = 0; i < 500; i++) many.push({ steleId: 'x' + i, name: '点' + i, savedAt: 1000 + i, groupId: 'g-default' });
  chrome.storage.local.set({ [KEY]: { schema: 1, groups: [{ id: 'g-default', name: '未分组', system: true, createdAt: 0 }], items: many } });
  const over = await S.add({ steleId: 'x-new' });
  check('满 500 条 → limit（不静默丢弃）', over.ok === false && over.reason === 'limit' && lib().items.length === 500);

  // 上限：组 30
  reset();
  const gs = [{ id: 'g-default', name: '未分组', system: true, createdAt: 0 }];
  for (let i = 0; i < 29; i++) gs.push({ id: 'g' + i, name: '组' + i, system: false, createdAt: i });
  chrome.storage.local.set({ [KEY]: { schema: 1, groups: gs, items: [] } });
  check('满 30 组 → limit', (await S.createGroup('再来一组')).reason === 'limit');

  // 并发回读-改-写：两次 add 都保留（顺序 await 模拟同页连续点击）
  reset();
  await S.add({ steleId: 'c1', name: '并发一' });
  await S.add({ steleId: 'c2', name: '并发二' });
  const rc = await S.read();
  check('连续两次 add 都保留（整键回读-改-写）',
    rc.items.length === 2 && rc.items.some(x => x.steleId === 'c1') && rc.items.some(x => x.steleId === 'c2'));

  // 1MB 上限：常量 + 分支存在（正常字段长度下到不了 1MB，防止静默截断）
  const src = fs.readFileSync(path.join(env.SRC, 'shared/favorites-store.js'), 'utf8');
  check('1MB 大小上限有显式 size 拒绝分支',
    S.LIMITS.bytes === 1024 * 1024 && /reason:\s*'size'/.test(src));

  finish();
})();
