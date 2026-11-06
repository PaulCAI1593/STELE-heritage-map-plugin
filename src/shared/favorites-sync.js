// shared/favorites-sync.js
// #53 · WebDAV 双向同步：库合并纯函数 + 最小 WebDAV 客户端（GET/PUT/HEAD）。
// 依赖：favorites-store.js（写回走 store.replace，进写队列）。
// 安全：凭据只在调用参数里流转，本模块不写日志、不进导出 JSON。
(function () {
  'use strict';
  window.HMP = window.HMP || {};
  if (window.HMP.favoritesSync) return;

  const SCHEMA = 2;
  const SYNC_KEY = 'hmp:webdav';
  const DEFAULT_PATH = 'heritage-map/favorites.json';
  const TIMEOUT_MS = 8000;
  const TOMBSTONE_LIMIT = 1000;
  const TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
  const WANT = 'g-want';

  function str(v) { return v == null ? '' : String(v); }
  function num(v, d) { return Number.isFinite(v) ? v : d; }

  /** 条目同步键：steleId；缺失退 name+address（#53 任务书） */
  function itemKey(it) {
    if (!it || typeof it !== 'object') return '';
    const id = str(it.steleId).trim();
    if (id) return id;
    const n = str(it.name).trim();
    const a = str(it.address).trim();
    return n || a ? 'n:' + n + '\u0000' + a : '';
  }

  /** 校验并归一化远端/本机库（接受 schema 1/2）；结构非法返回 null。 */
  function normalizeLibrary(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw.schema !== 1 && raw.schema !== SCHEMA) return null;
    if (!Array.isArray(raw.groups) || !Array.isArray(raw.items)) return null;
    const groups = [];
    const gids = new Set();
    raw.groups.forEach(g => {
      if (!g || typeof g !== 'object' || !g.id) return;
      const id = str(g.id);
      if (gids.has(id)) return;
      gids.add(id);
      groups.push({
        id,
        name: str(g.name).trim() || '未命名分组',
        system: g.id === 'g-been' || g.id === 'g-want' ? true : g.system === true,
        createdAt: num(g.createdAt, 0),
        updatedAt: num(g.updatedAt, num(g.createdAt, 0)),
      });
    });
    const items = [];
    const keys = new Set();
    raw.items.forEach(it => {
      if (!it || typeof it !== 'object') return;
      const key = itemKey(it);
      if (!key || keys.has(key)) return;
      keys.add(key);
      const savedAt = num(it.savedAt, num(it.updatedAt, Date.now()));
      items.push(Object.assign({}, it, {
        steleId: str(it.steleId).trim() || key,
        name: str(it.name),
        savedAt,
        updatedAt: num(it.updatedAt, savedAt),
        groupId: str(it.groupId),
      }));
    });
    const tombstones = [];
    if (Array.isArray(raw.tombstones)) {
      raw.tombstones.forEach(t => {
        if (!t || (t.kind !== 'item' && t.kind !== 'group')) return;
        const key = str(t.key).trim();
        if (!key) return;
        const tomb = { kind: t.kind, key, deletedAt: num(t.deletedAt, 0) };
        if (t.kind === 'item' && t.groupId) tomb.groupId = str(t.groupId);
        tombstones.push(tomb);
      });
    }
    return { schema: SCHEMA, groups, items, tombstones };
  }

  function newestTombstones(list) {
    const map = new Map();
    list.forEach(t => {
      const k = t.kind + ':' + t.key;
      const old = map.get(k);
      if (!old || t.deletedAt > old.deletedAt) map.set(k, t);
    });
    return map;
  }

  function pruneTombs(list, now) {
    const cutoff = now - TOMBSTONE_TTL_MS;
    return list
      .filter(t => Number.isFinite(t.deletedAt) && t.deletedAt >= cutoff)
      .sort((a, b) => b.deletedAt - a.deletedAt)
      .slice(0, TOMBSTONE_LIMIT)
      .sort((a, b) => a.deletedAt - b.deletedAt);
  }

  /**
   * 合并本机与远端库（#52 schema 2）。返回 {library, stats:{added,updated,removed,kept}}。
   * 规则：同 key 比 updatedAt，较新者胜，时间相同取本机；item 墓碑 deletedAt 更新 ⇒ 删除并保留墓碑
   * （让删除继续传播），较旧 ⇒ 条目复活并清墓碑；组同理；组 id 失效按 groupName 兜底再落 g-want。
   */
  function mergeLibraries(localRaw, remoteRaw, nowOpt) {
    const now = num(nowOpt, Date.now());
    const local = normalizeLibrary(localRaw);
    const remote = normalizeLibrary(remoteRaw);
    if (!local && !remote) throw new Error('mergeLibraries: invalid library');
    const L = local || { schema: SCHEMA, groups: [], items: [], tombstones: [] };
    const R = remote || { schema: SCHEMA, groups: [], items: [], tombstones: [] };
    const localOnly = !remote;

    const gTomb = newestTombstones(L.tombstones.concat(R.tombstones).filter(t => t.kind === 'group'));
    const iTomb = newestTombstones(L.tombstones.concat(R.tombstones).filter(t => t.kind === 'item'));

    // 组：同 id 比 updatedAt（相同取本机）
    const groupMap = new Map();
    const putGroup = g => {
      const old = groupMap.get(g.id);
      if (!old || g.updatedAt > old.updatedAt) groupMap.set(g.id, g);
    };
    L.groups.forEach(putGroup);
    R.groups.forEach(putGroup);
    // 组墓碑：比组新的删除生效，否则组存活并清墓碑
    const groups = [];
    const keptGroupKeys = new Set();
    groupMap.forEach((g, id) => {
      const t = gTomb.get('group:' + id);
      if (t && t.deletedAt > g.updatedAt) {
        keptGroupKeys.add('group:' + id);   // 墓碑继续保留，向其它端传播
        return;
      }
      groups.push(g);
    });
    const validGroup = new Set(groups.map(g => g.id));
    // 组名 → 非系统组 id（兜底用）
    const byName = new Map();
    groups.forEach(g => { if (!g.system && !byName.has(g.name)) byName.set(g.name, g.id); });

    // 条目：同 key 比 updatedAt（相同取本机）
    const itemMap = new Map();
    const putItem = it => {
      const k = itemKey(it);
      const old = itemMap.get(k);
      if (!old || it.updatedAt > old.updatedAt) itemMap.set(k, it);
    };
    L.items.forEach(putItem);
    R.items.forEach(putItem);

    const localByKey = new Map(L.items.map(it => [itemKey(it), it]));
    const remoteByKey = new Map(R.items.map(it => [itemKey(it), it]));
    const localKeys = new Set(localByKey.keys());
    const remoteKeys = new Set(remoteByKey.keys());

    const items = [];
    const keptItemTombKeys = new Set();
    let added = 0, updated = 0, removed = 0;
    itemMap.forEach((it, key) => {
      const t = iTomb.get('item:' + key);
      if (t && t.deletedAt > it.updatedAt) {
        keptItemTombKeys.add('item:' + key);  // 删除生效：条目消失、墓碑保留
        if (localKeys.has(key) || remoteKeys.has(key)) removed++;
        return;
      }
      // 归属：groupId 有效则用；失效按 groupName 找同名非系统组；再落「想去」
      let gid = it.groupId;
      if (!gid || !validGroup.has(gid)) {
        const name = str(it.groupName).trim();
        gid = (name && byName.get(name)) || WANT;
      }
      const out = Object.assign({}, it, { groupId: gid });
      if (!localKeys.has(key) && remoteKeys.has(key)) added++;
      else if (localKeys.has(key) && remoteKeys.has(key)) {
        const l = localByKey.get(key);
        const newByTime = remoteByKey.get(key) && remoteByKey.get(key).updatedAt > l.updatedAt;
        const movedByGroup = l.groupId !== gid;
        if (newByTime || movedByGroup) updated++;
      }
      items.push(out);
    });
    items.sort((a, b) => b.savedAt - a.savedAt);

    // 墓碑：删除生效的保留；被较新条目/组复活的清掉；无对应实体的也保留（继续传播）
    const tombstones = [];
    iTomb.forEach((t, k) => {
      if (keptItemTombKeys.has(k)) tombstones.push(t);
      else if (!itemMap.has(t.key)) tombstones.push(t);
    });
    gTomb.forEach((t, k) => {
      if (keptGroupKeys.has(k) || !groupMap.has(t.key)) tombstones.push(t);
    });
    const library = {
      schema: SCHEMA,
      groups,
      items,
      tombstones: pruneTombs(tombstones, now),
    };
    const kept = Math.max(0, items.length - added - updated);
    return { library, stats: { added, updated, removed, kept }, localOnly };
  }

  // ---------------- WebDAV 客户端（最小 GET / PUT / HEAD） ----------------
  function buildUrl(base, path) {
    const b = str(base).trim().replace(/\/+$/, '');
    const p = str(path || DEFAULT_PATH).trim().replace(/^\/+/, '');
    if (!b) return '';
    const enc = p.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    return b + '/' + enc;
  }

  function authHeader(cfg) {
    if (!cfg || !cfg.user) return {};
    let raw = cfg.user + ':' + (cfg.pass || '');
    let token;
    try { token = btoa(unescape(encodeURIComponent(raw))); }
    catch (e) {
      token = btoa(raw.replace(/[^\x00-\x7F]/g, ''));
    }
    return { Authorization: 'Basic ' + token };
  }

  async function fetchWithTimeout(f, url, opts, ms) {
    const ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), ms || TIMEOUT_MS) : null;
    try {
      return await f(url, Object.assign({}, opts, { signal: ctrl ? ctrl.signal : undefined }));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function httpError(res, text) {
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth', status: res.status };
    return { ok: false, reason: 'http', status: res.status, text: text || '' };
  }

  async function getRemote(cfg, url, f) {
    url = url || buildUrl(cfg && cfg.url, cfg && cfg.path);
    try {
      const res = await fetchWithTimeout(f, url, { method: 'GET', headers: Object.assign({}, authHeader(cfg)) });
      if (res.status === 404) return { ok: true, missing: true };
      if (!res.ok) return httpError(res, await res.text().catch(() => ''));
      return { ok: true, missing: false, text: await res.text() };
    } catch (e) {
      return { ok: false, reason: 'network' };
    }
  }

  async function putRemote(cfg, url, body, f) {
    try {
      const res = await fetchWithTimeout(f, url, {
        method: 'PUT',
        headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, authHeader(cfg)),
        body,
      });
      if (!res.ok) return httpError(res, await res.text().catch(() => ''));
      return { ok: true, status: res.status };
    } catch (e) {
      return { ok: false, reason: 'network' };
    }
  }

  async function headExists(cfg, url, f) {
    try {
      const res = await fetchWithTimeout(f, url, { method: 'HEAD', headers: Object.assign({}, authHeader(cfg)) });
      return { ok: res.ok, exists: res.status === 200 || res.status === 204 };
    } catch (e) {
      return { ok: false, exists: false };
    }
  }

  /** 远端已有主文件：先备份到 <path>.bak（旧备份已存在则加时间戳），失败不写主文件。 */
  async function backupRemote(cfg, url, body, f, nowOpt) {
    const bk = await headExists(cfg, url + '.bak', f);
    const stamp = new Date(num(nowOpt, Date.now())).toISOString().replace(/[:.]/g, '-');
    const target = (bk.ok && bk.exists) ? url + '.bak-' + stamp : url + '.bak';
    const r = await putRemote(cfg, target, body, f);
    return r.ok ? { ok: true, url: target } : { ok: false, reason: r.reason === 'auth' ? 'backup-auth' : 'backup' };
  }

  /** 一键双向同步：GET → 合并 → 备份 → PUT → 写本机（store.replace）。 */
  async function syncLibrary(cfg, store, f, nowOpt) {
    const fetchImpl = f || (typeof fetch === 'function' ? fetch : null);
    if (!fetchImpl) return { ok: false, reason: 'network' };
    if (!cfg || !cfg.url) return { ok: false, reason: 'unconfigured' };
    const url = buildUrl(cfg.url, cfg.path);
    if (!url) return { ok: false, reason: 'unconfigured' };

    const got = await getRemote(cfg, url, fetchImpl);
    if (!got.ok) return got;

    const localRes = await store.read();
    if (localRes && localRes.corrupt) return { ok: false, reason: 'local-corrupt' };
    const localLib = normalizeLibrary({
      schema: SCHEMA,
      groups: (localRes && localRes.groups) || [],
      items: (localRes && localRes.items) || [],
      tombstones: (localRes && localRes.tombstones) || [],
    });

    let remoteLib = null;
    if (!got.missing) {
      let parsed = null;
      try { parsed = JSON.parse(got.text); } catch (e) { parsed = null; }
      remoteLib = normalizeLibrary(parsed);
      if (!remoteLib) return { ok: false, reason: 'invalid-remote' };
    }

    const merged = remoteLib ? mergeLibraries(localLib, remoteLib, nowOpt) : { library: localLib, stats: { added: 0, updated: 0, removed: 0, kept: localLib.items.length } };

    if (!got.missing) {
      const b = await backupRemote(cfg, url, got.text, fetchImpl, nowOpt);
      if (!b.ok) return b;
    }
    const put = await putRemote(cfg, url, JSON.stringify(merged.library), fetchImpl);
    if (!put.ok) return put;
    const replaced = await store.replace(merged.library);
    if (!replaced || !replaced.ok) return { ok: false, reason: (replaced && replaced.reason) || 'storage' };
    return { ok: true, stats: merged.stats, remoteExisted: !got.missing };
  }

  function syncErrorText(reason, status) {
    if (reason === 'auth' || reason === 'backup-auth') return '账号或密码不对。';
    if (reason === 'network') return '连不上服务器，请检查地址与网络。';
    if (reason === 'invalid-remote') return '远端文件不是有效收藏数据，已中止（本机未改）。';
    if (reason === 'backup') return '备份远端文件失败，已中止（本机未改）。';
    if (reason === 'unconfigured') return '请先配置 WebDAV 地址与账号。';
    if (reason === 'local-corrupt') return '本机收藏数据异常，已中止。';
    if (reason === 'storage') return '写入本机失败，请重试。';
    if (reason === 'http') return '服务器返回 ' + (status || '错误') + '。';
    return '同步未完成，请重试。';
  }

  window.HMP.favoritesSync = {
    SCHEMA, SYNC_KEY, DEFAULT_PATH, TIMEOUT_MS, WANT,
    itemKey, normalizeLibrary, mergeLibraries,
    buildUrl, authHeader, getRemote, putRemote, headExists, backupRemote, syncLibrary, syncErrorText,
  };
})();
