// favorites-store.js
// 0.5.0 收藏夹 · 数据层（不依赖 DOM，popup 与 content 两条链路共用）
//
// 单键 `hmp:favorites:v1`（键名不变，schema 2）：
//   { schema:2,
//     groups:[{id,name,system,createdAt,updatedAt}],
//     items:[{steleId,name,tier,address,admin,
//             match:{matchedName,matchDist,matchType,provider},
//             info:{opentime,cost,address},
//             savedAt,updatedAt,groupId}],
//     tombstones:[{kind:'item'|'group', key, groupId?, deletedAt}] }
//   schema 1 仍可读，读/写前一次性迁移到 2（item.updatedAt=savedAt、group.updatedAt=createdAt、补 tombstones）。
//
// 设计要点：
//   · 每次写入都「整键回读-改-写」，卡片（content）与弹窗（popup）可能并发写；
//   · 读缺失/损坏一律按空库返回，不抛；但 schema 缺失或 >1 时拒绝写入，绝不覆盖用户数据；
//   · 上限硬拒（条目 500 / 组 30 / 组名 ≤24 字 / 序列化 >1MB），返回 reason，不静默丢；
//   · 快照字段白名单：不落任何 Key/AK，导出即天然脱敏。
(function () {
  'use strict';
  window.HMP = window.HMP || {};
  if (window.HMP.favoritesStore) return;   // 两处都加载时保持幂等

  const KEY = 'hmp:favorites:v1';
  const SCHEMA = 2;
  const SCHEMA_LEGACY = 1;
  // #52：墓碑剪枝（WebDAV 同步要让删除生效，但不能无限膨胀）
  const TOMBSTONE_LIMIT = 1000;
  const TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
  // legacy「未分组」：仅供迁移识别（可能出现在已装的 0.5.0 测试包里）
  const DEFAULT_GROUP_ID = 'g-default';
  const DEFAULT_WANT_ID = 'g-want';
  const DEFAULT_GROUPS = [
    { id: 'g-been', name: '已去', system: true, createdAt: 0 },
    { id: 'g-want', name: '想去', system: true, createdAt: 1 },
  ];
  const LIMITS = { items: 500, groups: 30, groupName: 24, bytes: 1024 * 1024 };

  // #36 P2-2(a)：写串行队列。所有变更都是「整键回读-改-写」，
  // 同一上下文里并发写（撤销连点、卡片快速点收藏 + 弹窗同时改）会 last-writer-wins 丢写。
  // 这里把变更按调用顺序排成一条 promise 链；前一个写失败不阻断后一个。
  let writeChain = Promise.resolve();
  function enqueueWrite(run) {
    const queued = writeChain.then(run);
    writeChain = queued.then(() => undefined, () => undefined);
    return queued;
  }

  // #74：writeChain 只是本上下文内的队列。弹窗、详情卡片、多个标签页各自持有一份
  // store，同时「回读-改-写」时后写者的快照可能更早，整条 items 会被覆盖（丢一条）。
  // 解法：写入优先交给 service worker（唯一写者，队列里按 op+args 对最新库重放）；
  // 发送失败 / 无 runtime / 800ms 超时 → 退回本地直写（保留原有语义）。
  // 返回值额外带 via（'sw' | 'local'），其余字段与原来一致。
  const SW_TYPE = 'hmp:fav';
  const SW_TIMEOUT_MS = 800;
  let swSeq = 0;

  /** SW 自己加载本文件时置位：它就是写者，不能再往自己发消息 */
  function isSwHost() {
    return !!window.__HMP_FAV_SW_HOST__;
  }

  function canUseSw() {
    if (isSwHost()) return false;
    const c = window.chrome;
    return !!(c && c.runtime && c.runtime.id && typeof c.runtime.sendMessage === 'function');
  }

  /** 发一条写消息；SW 不可用/超时/异常一律 resolve(null) 交给本地兜底 */
  function swCall(op, args) {
    return new Promise(resolve => {
      let settled = false;
      const timer = setTimeout(() => finish(null), SW_TIMEOUT_MS);
      function finish(v) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      }
      const reqId = 'r' + (++swSeq).toString(36);
      try {
        window.chrome.runtime.sendMessage({ type: SW_TYPE, op, args, reqId }, res => {
          const rt = window.chrome.runtime;
          const err = rt && rt.lastError;
          if (rt) rt.lastError = null;
          if (err || !res || res.reqId !== reqId) return finish(null);
          // 协议层 ok=false 表示 SW 没处理成（store 未加载等）→ 本地兜底；
          // result.ok=false 是业务失败（重复/上限等），必须原样返回，不能再本地重做一遍。
          if (!res.ok) return finish(null);
          finish(res.result || { ok: false, reason: 'sw' });
        });
      } catch (e) { finish(null); }
    });
  }

  function withVia(res, via) {
    return Object.assign({}, res || { ok: false, reason: 'storage' }, { via });
  }

  /** 写后回读校验（双保险）：确认本次变更真的落盘，不一致时调用方会重试一次 */
  async function verifyWrite(op, args, res) {
    const lib = await readLibrary();
    switch (op) {
      case 'add':
        return !!res.item && lib.items.some(i => i.steleId === res.item.steleId && i.updatedAt === res.item.updatedAt);
      case 'remove':
        if (!res.removed) return true;
        return !lib.items.some(i => i.steleId === args[0] && (!args[1] || i.groupId === args[1])) &&
          lib.tombstones.some(t => t.kind === 'item' && t.key === args[0]);
      case 'move':
        return lib.items.some(i => i.steleId === args[0] && i.groupId === args[1]);
      case 'createGroup':
        return !!res.group && lib.groups.some(g => g.id === res.group.id);
      case 'renameGroup':
        return !!res.group && lib.groups.some(g => g.id === args[0] && g.name === res.group.name);
      case 'deleteGroup':
        return !lib.groups.some(g => g.id === args[0]);
      case 'replace':
        return !!res.library &&
          lib.items.length === res.library.items.length &&
          lib.groups.length === res.library.groups.length;
      default:
        return true;
    }
  }

  /** 本地直写：排队 → 写 → 回读校验；不一致重试一次（最多 2 次） */
  async function localWrite(op, args) {
    let res = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await enqueueWrite(() => WRITE_IMPL[op].apply(null, args));
      if (!res || !res.ok) return withVia(res, 'local');
      if (await verifyWrite(op, args, res)) return withVia(res, 'local');
    }
    return withVia(res, 'local');
  }

  /** 对外写入口：优先 SW，失败/超时才本地 */
  function writeOp(op, args) {
    if (!canUseSw()) return localWrite(op, args);
    return swCall(op, args).then(res => (res ? withVia(res, 'sw') : localWrite(op, args)));
  }

  function hasStorage() {
    return !!(window.chrome && window.chrome.storage && window.chrome.storage.local);
  }

  function getRaw() {
    return new Promise(resolve => {
      if (!hasStorage()) return resolve({});
      try {
        window.chrome.storage.local.get([KEY], items => resolve(items || {}));
      } catch (e) { resolve({}); }
    });
  }

  function setRaw(value) {
    return new Promise(resolve => {
      if (!hasStorage()) return resolve({ ok: false, reason: 'storage' });
      try {
        window.chrome.storage.local.set({ [KEY]: value }, () => {
          const err = window.chrome.runtime && window.chrome.runtime.lastError;
          resolve({ ok: !err, reason: err ? 'storage' : null });
        });
      } catch (e) { resolve({ ok: false, reason: 'storage' }); }
    });
  }

  function defaultLibrary() {
    return {
      schema: SCHEMA,
      groups: DEFAULT_GROUPS.map(g => ({ ...g, updatedAt: g.createdAt })),
      items: [],
      tombstones: [],
    };
  }

  function clip(v, n) {
    const s = String(v == null ? '' : v);
    return s.length > n ? s.slice(0, n) : s;
  }

  function cleanItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const steleId = clip(raw.steleId, 64).trim();
    if (!steleId) return null;
    const m = (raw.match && typeof raw.match === 'object') ? raw.match : {};
    const info = (raw.info && typeof raw.info === 'object') ? raw.info : {};
    return {
      steleId,
      name: clip(raw.name, 120).trim(),
      tier: raw.tier == null || raw.tier === '' ? null : clip(raw.tier, 60).trim(),
      address: clip(raw.address, 300).trim(),
      admin: Array.isArray(raw.admin) ? raw.admin.map(x => clip(x, 40).trim()).filter(Boolean).slice(0, 6) : [],
      match: {
        matchedName: m.matchedName == null ? null : clip(m.matchedName, 120).trim() || null,
        matchDist: Number.isFinite(m.matchDist) ? m.matchDist : null,
        matchType: m.matchType == null ? null : clip(m.matchType, 20) || null,
        provider: m.provider == null ? null : clip(m.provider, 20) || null,
      },
      info: {
        opentime: info.opentime == null || info.opentime === '' ? null : clip(info.opentime, 200) || null,
        cost: info.cost == null || info.cost === '' ? null : clip(info.cost, 60) || null,
        address: info.address == null || info.address === '' ? null : clip(info.address, 300) || null,
      },
      savedAt: Number.isFinite(raw.savedAt) ? raw.savedAt : Date.now(),
      // #52：同步用更新时间；旧数据迁移时补 savedAt
      updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt
        : (Number.isFinite(raw.savedAt) ? raw.savedAt : Date.now()),
      // 缺分组不在清洗层兜底：由 add() 判 need-group / 迁移把旧数据归到「想去」
      groupId: raw.groupId ? clip(raw.groupId, 40) : '',
    };
  }

  /**
   * 库级清洗：只认 schema===1 的结构；组/条目做字段白名单。
   * 任何不认识的结构返回 null（由调用方决定按空库读 / 拒绝写）。
   */
  function sanitizeLibrary(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw.schema !== SCHEMA && raw.schema !== SCHEMA_LEGACY) return null;
    const groups = [];
    if (Array.isArray(raw.groups)) {
      for (const g of raw.groups) {
        if (!g || typeof g !== 'object' || !g.id) continue;
        groups.push({
          id: clip(g.id, 40),
          name: clip(g.name, 40).trim() || '未命名分组',
          system: g.id === 'g-been' || g.id === 'g-want' || g.id === DEFAULT_GROUP_ID ? true : g.system === true,
          createdAt: Number.isFinite(g.createdAt) ? g.createdAt : 0,
          updatedAt: Number.isFinite(g.updatedAt) ? g.updatedAt
            : (Number.isFinite(g.createdAt) ? g.createdAt : 0),
        });
      }
    }
    const items = [];
    if (Array.isArray(raw.items)) {
      for (const it of raw.items) {
        const c = cleanItem(it);
        if (c) items.push(c);
      }
    }
    items.sort((a, b) => b.savedAt - a.savedAt);
    const tombstones = [];
    if (Array.isArray(raw.tombstones)) {
      for (const t of raw.tombstones) {
        if (!t || typeof t !== 'object') continue;
        if (t.kind !== 'item' && t.kind !== 'group') continue;
        const key = clip(t.key, 64).trim();
        if (!key) continue;
        const tomb = { kind: t.kind, key, deletedAt: Number.isFinite(t.deletedAt) ? t.deletedAt : 0 };
        if (t.kind === 'item' && t.groupId) tomb.groupId = clip(t.groupId, 40);
        tombstones.push(tomb);
      }
    }
    return { schema: raw.schema, groups, items, tombstones };
  }

  /**
   * 0.5.0 追加：默认两组「已去 / 想去」+ legacy 迁移。
   * · 缺 g-been / g-want → 补到最前（system）；
   * · legacy g-default（未分组）条目 → g-want，组删除；
   * · 其它找不到组的条目 → g-want；
   * 不改 schema、不动 savedAt、不重排 items；返回是否有变化（由读路径决定是否落盘）。
   */
  function migrateLibrary(lib) {
    let changed = false;
    // #52：schema 1 → 2（键名不变，只补字段；只在真有变化时由读路径落盘一次）
    if (lib.schema !== SCHEMA) { lib.schema = SCHEMA; changed = true; }
    if (!Array.isArray(lib.tombstones)) { lib.tombstones = []; changed = true; }
    lib.items.forEach(it => {
      if (!Number.isFinite(it.updatedAt)) { it.updatedAt = Number.isFinite(it.savedAt) ? it.savedAt : 0; changed = true; }
    });
    lib.groups.forEach(g => {
      if (!Number.isFinite(g.updatedAt)) { g.updatedAt = Number.isFinite(g.createdAt) ? g.createdAt : 0; changed = true; }
    });
    const byId = new Map(lib.groups.map(g => [g.id, g]));
    DEFAULT_GROUPS.forEach((dg, i) => {
      const g = byId.get(dg.id);
      if (!g) {
        lib.groups.splice(i, 0, { ...dg, updatedAt: dg.createdAt });
        changed = true;
      } else {
        if (g.system !== true) { g.system = true; changed = true; }
        if (g.name !== dg.name) { g.name = dg.name; changed = true; }
      }
    });
    if (lib.groups.some(g => g.id === DEFAULT_GROUP_ID)) {
      lib.items.forEach(it => { if (it.groupId === DEFAULT_GROUP_ID) it.groupId = DEFAULT_WANT_ID; });
      lib.groups = lib.groups.filter(g => g.id !== DEFAULT_GROUP_ID);
      changed = true;
    }
    const valid = new Set(lib.groups.map(g => g.id));
    lib.items.forEach(it => { if (!valid.has(it.groupId)) { it.groupId = DEFAULT_WANT_ID; changed = true; } });
    return changed;
  }

  /** #52：墓碑按 deletedAt 剪枝——保留 180 天内、最多 1000 条（写入前调用） */
  function pruneTombstones(lib, now) {
    const t = Number.isFinite(now) ? now : Date.now();
    if (!Array.isArray(lib.tombstones)) { lib.tombstones = []; return; }
    const before = lib.tombstones.length;
    const cutoff = t - TOMBSTONE_TTL_MS;
    lib.tombstones = lib.tombstones
      .filter(x => Number.isFinite(x.deletedAt) && x.deletedAt >= cutoff)
      .sort((a, b) => b.deletedAt - a.deletedAt)
      .slice(0, TOMBSTONE_LIMIT)
      .sort((a, b) => a.deletedAt - b.deletedAt);
    if (lib.tombstones.length !== before) return true;
    return false;
  }

  function byteLength(s) {
    try { return new TextEncoder().encode(s).length; } catch (e) { return s.length * 2; }
  }

  function groupNameOf(lib, id) {
    const g = lib.groups.find(x => x.id === id);
    return g ? g.name : '收藏';
  }

  /** 写前回读：不存在 → 空库（可写）；存在但不合法 → 拒绝，避免覆盖用户数据 */
  async function loadForWrite() {
    const raw = (await getRaw())[KEY];
    if (raw == null) return { ok: true, library: defaultLibrary() };
    const lib = sanitizeLibrary(raw);
    if (!lib) return { ok: false, reason: 'schema' };
    migrateLibrary(lib);   // 迁移随本次写操作一起落盘（失败也不会把旧结构写回）
    return { ok: true, library: lib };
  }

  async function writeLibrary(lib) {
    pruneTombstones(lib);   // #52：写入时剪枝，避免墓碑无限膨胀
    const body = JSON.stringify(lib);
    if (byteLength(body) > LIMITS.bytes) return { ok: false, reason: 'size' };
    const w = await setRaw(lib);
    if (!w.ok) return { ok: false, reason: w.reason || 'storage' };
    return { ok: true, library: lib };
  }

  async function read() {
    const raw = (await getRaw())[KEY];
    if (raw == null) return { empty: true, schema: SCHEMA, groups: defaultLibrary().groups, items: [], tombstones: [] };
    const lib = sanitizeLibrary(raw);
    if (!lib) return { empty: true, corrupt: true };
    const migrated = migrateLibrary(lib);
    if (migrated) await writeLibrary(lib);   // 只在真有变化时落盘一次
    return { schema: lib.schema, groups: lib.groups, items: lib.items, tombstones: lib.tombstones, migrated };
  }

  /** listGroups 也能拿到空库的默认组 */
  async function readLibrary() {
    const raw = (await getRaw())[KEY];
    if (raw == null) return defaultLibrary();
    const lib = sanitizeLibrary(raw);
    if (!lib) return defaultLibrary();
    if (migrateLibrary(lib)) await writeLibrary(lib);
    return lib;
  }

  async function addNow(item, opts) {
    const cleaned = cleanItem(item);
    if (!cleaned) return { ok: false, reason: 'invalid' };
    const loaded = await loadForWrite();
    if (!loaded.ok) return loaded;
    const lib = loaded.library;
    const existing = lib.items.find(x => x.steleId === cleaned.steleId);
    if (existing) {
      return { ok: false, reason: 'duplicate', groupName: groupNameOf(lib, existing.groupId) };
    }
    if (lib.items.length >= LIMITS.items) return { ok: false, reason: 'limit' };
    const groupId = (opts && opts.groupId) || cleaned.groupId;
    if (!groupId || !lib.groups.some(g => g.id === groupId)) return { ok: false, reason: 'need-group' };
    cleaned.groupId = groupId;
    if (!(opts && opts.keepSavedAt) || !Number.isFinite(cleaned.savedAt)) cleaned.savedAt = Date.now();
    cleaned.updatedAt = Date.now();
    // #52：同一 key 重新收藏 → 清掉旧的删除墓碑，否则同步会把新收藏又删掉
    lib.tombstones = lib.tombstones.filter(t => !(t.kind === 'item' && t.key === cleaned.steleId));
    lib.items.push(cleaned);
    lib.items.sort((a, b) => b.savedAt - a.savedAt);
    const w = await writeLibrary(lib);
    if (!w.ok) return w;
    return { ok: true, item: cleaned };
  }

  async function removeNow(steleId, groupId) {
    const loaded = await loadForWrite();
    if (!loaded.ok) return loaded;
    const lib = loaded.library;
    const idx = lib.items.findIndex(x => x.steleId === steleId && (!groupId || x.groupId === groupId));
    if (idx < 0) return { ok: true, removed: false };
    const [item] = lib.items.splice(idx, 1);
    // #52：删除留墓碑（WebDAV 合并据此删除另一端）
    const tomb = { kind: 'item', key: item.steleId, deletedAt: Date.now() };
    if (item.groupId) tomb.groupId = item.groupId;
    lib.tombstones.push(tomb);
    const w = await writeLibrary(lib);
    if (!w.ok) return w;
    return { ok: true, removed: true, item };
  }

  async function moveNow(steleId, groupId) {
    const loaded = await loadForWrite();
    if (!loaded.ok) return loaded;
    const lib = loaded.library;
    const gid = groupId;
    if (!gid) return { ok: false, reason: 'need-group' };
    if (!lib.groups.some(g => g.id === gid)) return { ok: false, reason: 'unknown-group' };
    const item = lib.items.find(x => x.steleId === steleId);
    if (!item) return { ok: false, reason: 'not-found' };
    item.groupId = gid;
    item.updatedAt = Date.now();   // #52：同步用
    const w = await writeLibrary(lib);
    if (!w.ok) return w;
    return { ok: true, item };
  }

  async function isSaved(steleId) {
    if (!steleId) return false;
    const lib = await readLibrary();
    return lib.items.some(x => x.steleId === steleId);
  }

  async function listGroups() {
    const lib = await readLibrary();
    return lib.groups;
  }

  function validGroupName(name) {
    const n = clip(name, 200).trim();
    if (!n) return null;
    if (n.length > LIMITS.groupName) return null;
    return n;
  }

  async function createGroupNow(name) {
    const n = validGroupName(name);
    if (!n) return { ok: false, reason: 'invalid-name' };
    const loaded = await loadForWrite();
    if (!loaded.ok) return loaded;
    const lib = loaded.library;
    if (lib.groups.length >= LIMITS.groups) return { ok: false, reason: 'limit-groups' };
    if (lib.groups.some(g => g.name === n)) return { ok: false, reason: 'duplicate-name' };
    const id = 'g-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const group = { id, name: n, system: false, createdAt: Date.now(), updatedAt: Date.now() };
    lib.groups.push(group);
    const w = await writeLibrary(lib);
    if (!w.ok) return w;
    return { ok: true, group };
  }

  async function renameGroupNow(id, name) {
    const n = validGroupName(name);
    if (!n) return { ok: false, reason: 'invalid-name' };
    const loaded = await loadForWrite();
    if (!loaded.ok) return loaded;
    const lib = loaded.library;
    const g = lib.groups.find(x => x.id === id);
    if (!g) return { ok: false, reason: 'not-found' };
    if (g.system) return { ok: false, reason: 'system' };
    if (lib.groups.some(x => x.id !== id && x.name === n)) return { ok: false, reason: 'duplicate-name' };
    g.name = n;
    g.updatedAt = Date.now();   // #52：同步用
    const w = await writeLibrary(lib);
    if (!w.ok) return w;
    return { ok: true, group: g };
  }

  async function deleteGroupNow(id) {
    const loaded = await loadForWrite();
    if (!loaded.ok) return loaded;
    const lib = loaded.library;
    const idx = lib.groups.findIndex(x => x.id === id);
    if (idx < 0) return { ok: false, reason: 'not-found' };
    if (lib.groups[idx].system) return { ok: false, reason: 'system' };
    lib.groups.splice(idx, 1);
    lib.tombstones.push({ kind: 'group', key: id, deletedAt: Date.now() });   // #52
    let moved = 0;
    const now = Date.now();
    for (const it of lib.items) {
      if (it.groupId === id) { it.groupId = DEFAULT_WANT_ID; it.updatedAt = now; moved++; }
    }
    const w = await writeLibrary(lib);
    if (!w.ok) return w;
    return { ok: true, moved };
  }

  /** #53：整库替换（WebDAV 合并结果写回）；同样排队，schema/大小/结构校验不过则拒绝 */
  async function replaceNow(lib) {
    if (!lib || typeof lib !== 'object' || !Array.isArray(lib.groups) || !Array.isArray(lib.items)) {
      return { ok: false, reason: 'schema' };
    }
    const san = sanitizeLibrary(lib);
    if (!san) return { ok: false, reason: 'schema' };
    migrateLibrary(san);
    const w = await writeLibrary(san);
    if (!w.ok) return w;
    return { ok: true, library: san };
  }

  // #74：本地实现表（SW 内与兜底路径共用）与对外入口。
  // 对外接口语义不变（成功/失败 reason 原样），只多一个 via 字段。
  const WRITE_IMPL = {
    add: addNow,
    remove: removeNow,
    move: moveNow,
    createGroup: createGroupNow,
    renameGroup: renameGroupNow,
    deleteGroup: deleteGroupNow,
    replace: replaceNow,
  };

  function add(item, opts) { return writeOp('add', [item, opts]); }
  function remove(steleId, groupId) { return writeOp('remove', [steleId, groupId]); }
  function move(steleId, groupId) { return writeOp('move', [steleId, groupId]); }
  function createGroup(name) { return writeOp('createGroup', [name]); }
  function renameGroup(id, name) { return writeOp('renameGroup', [id, name]); }
  function deleteGroup(id) { return writeOp('deleteGroup', [id]); }
  function replace(lib) { return writeOp('replace', [lib]); }

  async function search(query, scope, groupId) {
    const q = String(query == null ? '' : query).trim().toLowerCase();
    const lib = await readLibrary();
    let items = lib.items;
    if (scope === 'group') {
      const gid = groupId || DEFAULT_WANT_ID;
      items = items.filter(x => x.groupId === gid);
    }
    if (!q) return items.slice();
    // 名称 + 地址子串，大小写不敏感；级别（tier）不参与；不做分词/拼音。
    return items.filter(x => {
      const hay = [x.name, x.address].filter(Boolean).join('\n').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  async function exportJSON() {
    const lib = await readLibrary();
    // #52 / 用户追加：v2 载荷保留分组信息；groupName 是导出时的只读快照，合并以 groupId 为准。
    return JSON.stringify({
      schema: SCHEMA,
      exportedAt: Date.now(),
      groups: lib.groups.map(g => ({ ...g })),
      items: lib.items.map(it => ({ ...it, groupName: groupNameOf(lib, it.groupId) })),
      tombstones: lib.tombstones.map(t => ({ ...t })),
    });
  }

  window.HMP.favoritesStore = {
    KEY, SCHEMA, SCHEMA_LEGACY, LIMITS, TOMBSTONE_LIMIT, TOMBSTONE_TTL_MS,
    DEFAULT_GROUP_ID, DEFAULT_GROUPS, DEFAULT_WANT_ID,
    read, replace, add, remove, move, isSaved,
    listGroups, createGroup, renameGroup, deleteGroup,
    search, exportJSON,
  };
})();
