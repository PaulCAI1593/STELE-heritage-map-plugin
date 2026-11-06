// tests/favorites_store_tests.js
// #32a · 收藏夹数据层（hmp:favorites:v1）：CRUD、组、上限、schema 保护、搜索、脱敏
// #39 · 默认两组「已去 / 想去」、legacy g-default 迁移、add 必须选组（need-group）
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
const BEEN = 'g-been', WANT = 'g-want';
const defaultGroups = () => ([
  { id: BEEN, name: '已去', system: true, createdAt: 0 },
  { id: WANT, name: '想去', system: true, createdAt: 1 },
]);

(async () => {
  check('导出数据层（键名/schema/上限常量）',
    !!S && S.KEY === 'hmp:favorites:v1' && S.SCHEMA === 1 &&
    S.LIMITS.items === 500 && S.LIMITS.groups === 30 && S.LIMITS.bytes === 1024 * 1024);
  check('导出默认两组常量（已去 g-been / 想去 g-want）',
    Array.isArray(S.DEFAULT_GROUPS) && S.DEFAULT_GROUPS.length === 2 &&
    S.DEFAULT_GROUPS[0].id === BEEN && S.DEFAULT_GROUPS[0].name === '已去' &&
    S.DEFAULT_GROUPS[1].id === WANT && S.DEFAULT_GROUPS[1].name === '想去' &&
    S.DEFAULT_GROUPS.every(g => g.system === true));

  reset();
  const r0 = await S.read();
  check('read 缺失 → {empty:true} 且不抛', r0.empty === true);
  const gs0 = await S.listGroups();
  check('空库默认就是「已去 / 想去」两组（没有未分组）',
    gs0.length === 2 && gs0[0].id === BEEN && gs0[0].name === '已去' &&
    gs0[1].id === WANT && gs0[1].name === '想去' &&
    gs0.every(g => g.system === true) && !gs0.some(g => g.id === 'g-default'));

  const ng = await S.add({ steleId: 'ng', name: '没选组' });
  check('add 缺 groupId → need-group（不再兜底未分组）',
    ng.ok === false && ng.reason === 'need-group' && (lib().items || []).length === 0);
  check('add 未知 groupId → need-group',
    (await S.add({ steleId: 'ng2', name: '坏组' }, { groupId: 'g-nope' })).reason === 'need-group');

  const a1 = await S.add({
    steleId: 'a1', name: '故宫', tier: '全国重点文物保护单位',
    address: '景山前街4号', admin: ['北京市 东城区'],
    match: { matchedName: '故宫', matchDist: 100, matchType: 'name', provider: 'amap' },
    info: { opentime: '08:00-17:00', cost: '60', address: '景山前街4号' },
    amapKey: 'SHOULD_DROP',
  }, { groupId: BEEN });
  check('add 成功、落到指定组「已去」、丢弃未知字段',
    a1.ok === true && a1.item.groupId === BEEN && !('amapKey' in a1.item));
  check('写入单键 hmp:favorites:v1', Array.isArray(lib().items) && lib().items.length === 1);

  const aItem = await S.add({ steleId: 'a-item', name: 'item 自带组', groupId: WANT });
  check('add 也接受 item.groupId', aItem.ok === true && aItem.item.groupId === WANT);

  const dup = await S.add({ steleId: 'a1', name: '重复' }, { groupId: WANT });
  check('重复收藏 → duplicate + 组名「已去」，不覆盖原条目',
    dup.ok === false && dup.reason === 'duplicate' && dup.groupName === '已去' &&
    lib().items.filter(x => x.steleId === 'a1').length === 1 && lib().items.find(x => x.steleId === 'a1').name === '故宫');

  // #32c：同毫秒 savedAt 会让「最新在前」偶发失败（相等键排序保留插入序），先跨出毫秒边界
  const t0 = Date.now();
  while (Date.now() === t0) { /* 等到下一个毫秒 */ }
  await S.add({ steleId: 'a2', name: '颐和园' }, { groupId: WANT });
  const r2 = await S.read();
  check('items 按 savedAt 倒序（最新在前）', r2.items[0].steleId === 'a2');
  check('倒序：较新的 a2 排在 a1 前', r2.items.findIndex(x => x.steleId === 'a2') < r2.items.findIndex(x => x.steleId === 'a1'));

  const rm = await S.remove('a2');
  check('remove 删除成功', rm.ok === true && rm.removed === true && (await S.isSaved('a2')) === false);
  check('remove 不存在 → removed:false（不抛）', (await S.remove('nope')).removed === false);

  const cg = await S.createGroup('  出片组  ');
  check('createGroup：名称 trim', cg.ok === true && cg.group.name === '出片组');
  check('createGroup：重名拒绝（系统组名也占用）', (await S.createGroup('出片组')).reason === 'duplicate-name');
  check('createGroup：与系统组同名拒绝', (await S.createGroup('想去')).reason === 'duplicate-name');
  check('createGroup：超 24 字拒绝',
    (await S.createGroup('一二三四五六七八九十一二三四五六七八九十一二三四五')).reason === 'invalid-name');
  check('renameGroup 成功', (await S.renameGroup(cg.group.id, '出片')).ok === true);
  check('renameGroup：系统组「已去」拒绝', (await S.renameGroup(BEEN, 'x')).reason === 'system');
  check('renameGroup：系统组「想去」拒绝', (await S.renameGroup(WANT, 'x')).reason === 'system');
  check('move 到组成功', (await S.move('a1', cg.group.id)).ok === true);
  check('move：未知组拒绝', (await S.move('a1', 'nope')).reason === 'unknown-group');
  check('move：缺 groupId → need-group', (await S.move('a1')).reason === 'need-group');
  const dg = await S.deleteGroup(cg.group.id);
  const afterDel = await S.read();
  check('删组不删条目：条目回到「想去」',
    dg.ok === true && dg.moved === 1 &&
    afterDel.items.length === 2 && afterDel.items.find(x => x.steleId === 'a1').groupId === WANT);
  check('删组：系统组「已去」不可删', (await S.deleteGroup(BEEN)).reason === 'system');
  check('删组：系统组「想去」不可删', (await S.deleteGroup(WANT)).reason === 'system');

  // #39 补充口径：非系统组删除后，组内条目一律落到「想去」，总数与 savedAt 不变
  reset();
  const two = await S.createGroup('两条组');
  await S.add({ steleId: 'd1', name: '甲', savedAt: 111 }, { groupId: two.group.id, keepSavedAt: true });
  await S.add({ steleId: 'd2', name: '乙', savedAt: 222 }, { groupId: two.group.id, keepSavedAt: true });
  const beforeTwo = await S.read();
  const delTwo = await S.deleteGroup(two.group.id);
  const afterTwo = await S.read();
  check('删含 2 条的组：两条都落到「想去」',
    delTwo.ok === true && delTwo.moved === 2 &&
    afterTwo.items.filter(x => x.groupId === WANT).length === 2 &&
    afterTwo.items.every(x => x.steleId !== 'd1' && x.steleId !== 'd2' ? true : x.groupId === WANT),
    JSON.stringify(afterTwo.items.map(x => [x.steleId, x.groupId])));
  check('删组后总数与 savedAt 不变、无「未分组」组',
    afterTwo.items.length === beforeTwo.items.length &&
    afterTwo.items.find(x => x.steleId === 'd1').savedAt === 111 &&
    afterTwo.items.find(x => x.steleId === 'd2').savedAt === 222 &&
    afterTwo.groups.every(g => g.id !== 'g-default' && g.name !== '未分组') &&
    afterTwo.groups.map(g => g.id).join(',') === 'g-been,g-want');

  // #39 迁移：legacy g-default（已装的 0.5.0 测试包）→ 已去/想去两组，条目进「想去」
  reset();
  chrome.storage.local.set({
    [KEY]: {
      schema: 1,
      groups: [
        { id: 'g-default', name: '未分组', system: true, createdAt: 0 },
        { id: 'g-x', name: '出片', system: false, createdAt: 5 },
      ],
      items: [
        { steleId: 'm1', name: '故宫', address: '', tier: '', savedAt: 300, groupId: 'g-default' },
        { steleId: 'm2', name: '颐和园', address: '', tier: '', savedAt: 200, groupId: 'g-x' },
        { steleId: 'm3', name: '断组', address: '', tier: '', savedAt: 100, groupId: 'g-gone' },
      ],
    },
  });
  const mr = await S.read();
  check('迁移：补出「已去 / 想去」在最前、删掉 g-default、保留用户组',
    mr.groups.length === 3 && mr.groups[0].id === BEEN && mr.groups[1].id === WANT &&
    mr.groups[2].id === 'g-x' && !mr.groups.some(g => g.id === 'g-default') &&
    !mr.groups.some(g => g.name === '未分组'));
  check('迁移：g-default 条目 → 想去；用户组保留；断组 → 想去',
    mr.items.find(x => x.steleId === 'm1').groupId === WANT &&
    mr.items.find(x => x.steleId === 'm2').groupId === 'g-x' &&
    mr.items.find(x => x.steleId === 'm3').groupId === WANT);
  check('迁移：不动 schema / savedAt', mr.schema === 1 && mr.items.find(x => x.steleId === 'm1').savedAt === 300);
  check('迁移：read 即落盘（再读库已是新结构）',
    Array.isArray(lib().groups) && lib().groups[0].id === BEEN && !lib().groups.some(g => g.id === 'g-default'));
  const mr2 = await S.read();
  check('迁移幂等：第二次 read 结构不变', mr2.groups.length === 3 && mr2.groups[0].id === BEEN && mr2.groups[1].id === WANT);

  // 迁移：只缺「想去」时补在最前第二位
  reset();
  chrome.storage.local.set({
    [KEY]: { schema: 1, groups: [{ id: BEEN, name: '已去', system: true, createdAt: 0 }], items: [] },
  });
  const partial = await S.read();
  check('迁移：只缺一组时补齐且顺序为 已去/想去',
    partial.groups[0].id === BEEN && partial.groups[1].id === WANT && partial.groups.length === 2);

  // 搜索：名称 + 地址子串、大小写不敏感、trim、级别不参与
  reset();
  chrome.storage.local.set({
    [KEY]: {
      schema: 1,
      groups: defaultGroups().concat([{ id: 'g-x', name: '出片', system: false, createdAt: 2 }]),
      items: [
        { steleId: 's1', name: '故宫', address: '北京市东城区景山前街', tier: '全国重点', savedAt: 3, groupId: BEEN },
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
    (await S.search('', 'group', 'g-x')).length === 2 && (await S.search('', 'group', BEEN)).length === 1);
  check('search：空关键字返回全部（倒序）', (await S.search('')).length === 3);

  // 导出：脱敏、结构完整
  reset();
  await S.add({
    steleId: 'e1', name: '测试', match: { provider: 'amap' },
    amapKey: 'AK_SHOULD_NOT_LEAK', baiduAk: 'BAIDU_SHOULD_NOT_LEAK',
  }, { groupId: WANT });
  const exp = await S.exportJSON();
  const parsed = JSON.parse(exp);
  check('exportJSON：schema/groups/items 齐全', parsed.schema === 1 && Array.isArray(parsed.groups) && parsed.items.length === 1);
  check('exportJSON：不含 Key/AK', !exp.includes('amapKey') && !exp.includes('baiduAk') && !exp.includes('SHOULD_NOT_LEAK'));

  // schema 保护：>1 拒绝写入且不覆盖
  reset();
  chrome.storage.local.set({ [KEY]: { schema: 2, items: [{ steleId: 'old' }] } });
  const bad = await S.add({ steleId: 'new' }, { groupId: WANT });
  check('schema>1：拒写并返回 schema', bad.ok === false && bad.reason === 'schema');
  check('schema>1：原数据未被覆盖', lib().schema === 2 && lib().items[0].steleId === 'old');
  const rb = await S.read();
  check('read：不合法 schema → empty+corrupt、不抛', rb.empty === true && rb.corrupt === true);

  // 上限：条目 500
  reset();
  const many = [];
  for (let i = 0; i < 500; i++) many.push({ steleId: 'x' + i, name: '点' + i, savedAt: 1000 + i, groupId: WANT });
  chrome.storage.local.set({ [KEY]: { schema: 1, groups: defaultGroups(), items: many } });
  const over = await S.add({ steleId: 'x-new' }, { groupId: WANT });
  check('满 500 条 → limit（不静默丢弃）', over.ok === false && over.reason === 'limit' && lib().items.length === 500);

  // 上限：组 30（含两个系统组）
  reset();
  const gs = defaultGroups();
  for (let i = 0; i < 28; i++) gs.push({ id: 'g' + i, name: '组' + i, system: false, createdAt: i });
  chrome.storage.local.set({ [KEY]: { schema: 1, groups: gs, items: [] } });
  check('满 30 组 → limit-groups（与条目 500 上限区分）', (await S.createGroup('再来一组')).reason === 'limit-groups');

  // 并发回读-改-写：连续两次 add 都保留
  reset();
  await S.add({ steleId: 'c1', name: '并发一' }, { groupId: WANT });
  await S.add({ steleId: 'c2', name: '并发二' }, { groupId: WANT });
  const rc = await S.read();
  check('连续两次 add 都保留（整键回读-改-写）',
    rc.items.length === 2 && rc.items.some(x => x.steleId === 'c1') && rc.items.some(x => x.steleId === 'c2'));

  // #36 P2-2(a)：真正并发（Promise.all）两次 add 也必须都保留。
  reset();
  const pc = await Promise.all([
    S.add({ steleId: 'p1', name: '并行一' }, { groupId: BEEN }),
    S.add({ steleId: 'p2', name: '并行二' }, { groupId: WANT }),
  ]);
  const rp = await S.read();
  check('并发两次 add 都成功、两条都在（写串行队列）',
    pc.length === 2 && pc.every(r => r && r.ok) && rp.items.length === 2 &&
    rp.items.some(x => x.steleId === 'p1') && rp.items.some(x => x.steleId === 'p2'));

  // 队列不因一次失败卡死：schema 拒写之后，清掉数据再写应恢复正常。
  reset();
  chrome.storage.local.set({ [KEY]: { schema: 2, groups: [], items: [] } });
  const rejected = await S.add({ steleId: 'q1', name: '拒写' }, { groupId: WANT });
  chrome.storage.local.remove(KEY);
  const recovered = await S.add({ steleId: 'q2', name: '恢复后写' }, { groupId: WANT });
  check('写失败不阻断后续写（队列不吞死）', rejected.reason === 'schema' && recovered.ok === true);

  // 撤销恢复：keepSavedAt + groupId 同时生效
  reset();
  await S.add({ steleId: 'k1', name: '撤销', savedAt: 111 }, { groupId: BEEN, keepSavedAt: true });
  check('keepSavedAt + groupId 写回原组与原收藏时间',
    lib().items[0].groupId === BEEN && lib().items[0].savedAt === 111);

  // 1MB 上限：常量 + 分支存在（正常字段长度下到不了 1MB，防止静默截断）
  const src = fs.readFileSync(path.join(env.SRC, 'shared/favorites-store.js'), 'utf8');
  check('1MB 大小上限有显式 size 拒绝分支',
    S.LIMITS.bytes === 1024 * 1024 && /reason:\s*'size'/.test(src));

  finish();
})();
