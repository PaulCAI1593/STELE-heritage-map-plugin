// favorites-store.js
// 0.5.0 收藏夹 · 数据层（不依赖 DOM，popup 与 content 两条链路共用）
//
// 单键 `hmp:favorites:v1`，schema 1：
//   { schema:1,
//     groups:[{id,name,system,createdAt}],
//     items:[{steleId,name,tier,address,admin,
//             match:{matchedName,matchDist,matchType,provider},
//             info:{opentime,cost,address},
//             savedAt,groupId}] }
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
  const SCHEMA = 1;
  const DEFAULT_GROUP_ID = 'g-default';
  const LIMITS = { items: 500, groups: 30, groupName: 24, bytes: 1024 * 1024 };

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
      groups: [{ id: DEFAULT_GROUP_ID, name: '未分组', system: true, createdAt: 0 }],
      items: [],
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
      groupId: raw.groupId ? clip(raw.groupId, 40) : DEFAULT_GROUP_ID,
    };
  }

  /**
   * 库级清洗：只认 schema===1 的结构；组/条目做字段白名单。
   * 任何不认识的结构返回 null（由调用方决定按空库读 / 拒绝写）。
   */
  function sanitizeLibrary(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw.schema !== SCHEMA) return null;
    const groups = [];
    if (Array.isArray(raw.groups)) {
      for (const g of raw.groups) {
        if (!g || typeof g !== 'object' || !g.id) continue;
        groups.push({
          id: clip(g.id, 40),
          name: clip(g.name, 40).trim() || '未命名分组',
          system: g.id === DEFAULT_GROUP_ID ? true : g.system === true,
          createdAt: Number.isFinite(g.createdAt) ? g.createdAt : 0,
        });
      }
    }
    if (!groups.some(g => g.id === DEFAULT_GROUP_ID)) {
      groups.unshift({ id: DEFAULT_GROUP_ID, name: '未分组', system: true, createdAt: 0 });
    }
    const items = [];
    if (Array.isArray(raw.items)) {
      for (const it of raw.items) {
        const c = cleanItem(it);
        if (c) items.push(c);
      }
    }
    items.sort((a, b) => b.savedAt - a.savedAt);
    return { schema: SCHEMA, groups, items };
  }

  function byteLength(s) {
    try { return new TextEncoder().encode(s).length; } catch (e) { return s.length * 2; }
  }

  function groupNameOf(lib, id) {
    const g = lib.groups.find(x => x.id === id);
    return g ? g.name : '未分组';
  }

  /** 写前回读：不存在 → 空库（可写）；存在但不合法 → 拒绝，避免覆盖用户数据 */
  async function loadForWrite() {
    const raw = (await getRaw())[KEY];
    if (raw == null) return { ok: true, library: defaultLibrary() };
    const lib = sanitizeLibrary(raw);
    if (!lib) return { ok: false, reason: 'schema' };
    return { ok: true, library: lib };
  }

  async function writeLibrary(lib) {
    const body = JSON.stringify(lib);
    if (byteLength(body) > LIMITS.bytes) return { ok: false, reason: 'size' };
    const w = await setRaw(lib);
    if (!w.ok) return { ok: false, reason: w.reason || 'storage' };
    return { ok: true, library: lib };
  }

  async function read() {
    const raw = (await getRaw())[KEY];
    if (raw == null) return { empty: true };
    const lib = sanitizeLibrary(raw);
    if (!lib) return { empty: true, corrupt: true };
    return { schema: lib.schema, groups: lib.groups, items: lib.items };
  }

  /** listGroups 也能拿到空库的默认组 */
  async function readLibrary() {
    const raw = (await getRaw())[KEY];
    if (raw == null) return defaultLibrary();
    const lib = sanitizeLibrary(raw);
    return lib || defaultLibrary();
  }

  async function add(item, opts) {
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
    if (!lib.groups.some(g => g.id === cleaned.groupId)) cleaned.groupId = DEFAULT_GROUP_ID;
    if (!(opts && opts.keepSavedAt) || !Number.isFinite(cleaned.savedAt)) cleaned.savedAt = Date.now();
    lib.items.push(cleaned);
    lib.items.sort((a, b) => b.savedAt - a.savedAt);
    const w = await writeLibrary(lib);
    if (!w.ok) return w;
    return { ok: true, item: cleaned };
  }

  async function remove(steleId, groupId) {
    const loaded = await loadForWrite();
    if (!loaded.ok) return loaded;
    const lib = loaded.library;
    const idx = lib.items.findIndex(x => x.steleId === steleId && (!groupId || x.groupId === groupId));
    if (idx < 0) return { ok: true, removed: false };
    const [item] = lib.items.splice(idx, 1);
    const w = await writeLibrary(lib);
    if (!w.ok) return w;
    return { ok: true, removed: true, item };
  }

  async function move(steleId, groupId) {
    const loaded = await loadForWrite();
    if (!loaded.ok) return loaded;
    const lib = loaded.library;
    const gid = groupId || DEFAULT_GROUP_ID;
    if (!lib.groups.some(g => g.id === gid)) return { ok: false, reason: 'unknown-group' };
    const item = lib.items.find(x => x.steleId === steleId);
    if (!item) return { ok: false, reason: 'not-found' };
    item.groupId = gid;
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

  async function createGroup(name) {
    const n = validGroupName(name);
    if (!n) return { ok: false, reason: 'invalid-name' };
    const loaded = await loadForWrite();
    if (!loaded.ok) return loaded;
    const lib = loaded.library;
    if (lib.groups.length >= LIMITS.groups) return { ok: false, reason: 'limit' };
    if (lib.groups.some(g => g.name === n)) return { ok: false, reason: 'duplicate-name' };
    const id = 'g-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const group = { id, name: n, system: false, createdAt: Date.now() };
    lib.groups.push(group);
    const w = await writeLibrary(lib);
    if (!w.ok) return w;
    return { ok: true, group };
  }

  async function renameGroup(id, name) {
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
    const w = await writeLibrary(lib);
    if (!w.ok) return w;
    return { ok: true, group: g };
  }

  async function deleteGroup(id) {
    const loaded = await loadForWrite();
    if (!loaded.ok) return loaded;
    const lib = loaded.library;
    if (id === DEFAULT_GROUP_ID) return { ok: false, reason: 'system' };
    const idx = lib.groups.findIndex(x => x.id === id);
    if (idx < 0) return { ok: false, reason: 'not-found' };
    lib.groups.splice(idx, 1);
    let moved = 0;
    for (const it of lib.items) {
      if (it.groupId === id) { it.groupId = DEFAULT_GROUP_ID; moved++; }
    }
    const w = await writeLibrary(lib);
    if (!w.ok) return w;
    return { ok: true, moved };
  }

  async function search(query, scope, groupId) {
    const q = String(query == null ? '' : query).trim().toLowerCase();
    const lib = await readLibrary();
    let items = lib.items;
    if (scope === 'group') {
      const gid = groupId || DEFAULT_GROUP_ID;
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
    return JSON.stringify({ schema: SCHEMA, groups: lib.groups, items: lib.items });
  }

  window.HMP.favoritesStore = {
    KEY, SCHEMA, LIMITS, DEFAULT_GROUP_ID,
    read, add, remove, move, isSaved,
    listGroups, createGroup, renameGroup, deleteGroup,
    search, exportJSON,
  };
})();
