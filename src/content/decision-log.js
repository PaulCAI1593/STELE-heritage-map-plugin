// decision-log.js
// 「最近 20 条匹配决策」环形日志：给用户/支持/评审排障用。
//
// schema 2（#14-L）：每条决策存**三路各自的 top5 候选与分项**，用来回答
// 「为什么最后选的是它、为什么没选坐标路最近那个」。字段见 README / 方案 v2 修正 3：
//   {schema:2, ts, version, stele:{id,name,tier},
//    routes:{name:{candCount,bestSim,candidates:[…]}, address:{…}, nearby:{…}},
//    final:{pickedName,sim,simAdj,dist,distScore,score,source,why[]}|null}
// 候选字段：{name,sim,simAdj,dist,distScore,typeRank,subPen,pen,source,score}
//
// ⚠️ 本阶段（commit L）**不改评分行为**：simAdj 恒等于 sim，惩罚字段只做记录。
// ⚠️ 绝不把 API Key 写进日志，也绝不把带 `key=` / `ak=` 的 URL 原样导出：
// 日志可能被用户贴到公开的 issue 里，Key 泄露会直接被刷额度。
// 写入与导出两处都过 sanitize（双保险）。
//
// 旧 v1 记录（schema 缺失）仍能读：导出时补 `schema:1` 与 `note:'无候选明细'`，
// 不做迁移、不丢条数。

(function () {
  'use strict';
  window.HMP = window.HMP || {};

  const STORAGE_KEY = 'hmp:decisionLog';
  const MAX_ENTRIES = 20;
  const SCHEMA = 2;
  const TOP_N = 5;
  const MAX_NAME_LEN = 120;
  const MAX_WHY = 10;

  // 字段名命中这些的整个字段丢掉（不是打码，是不导出）
  const SECRET_FIELD_RE = /^(?:api_?key|key|ak|amap_?key|baidu_?ak|token|secret|password|pwd)$/i;

  // 字符串里的密钥参数：?key=xxx / &ak=xxx / key=xxx
  function maskString(s) {
    return String(s).replace(/([?&]|^)((?:key|ak|token|secret|pwd)=)[^&#\s]*/gi, '$1$2***');
  }

  /**
   * 深拷贝 + 去密钥。
   * @param {*} v
   * @param {number} depth 防御性深度上限（日志是我们自己写的，正常不会很深）
   */
  function sanitize(v, depth) {
    depth = depth || 0;
    if (depth > 6) return null;
    if (typeof v === 'string') return maskString(v);
    if (Array.isArray(v)) return v.map(x => sanitize(x, depth + 1));
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) {
        if (SECRET_FIELD_RE.test(k)) continue;   // 密钥字段整条丢弃
        out[k] = sanitize(v[k], depth + 1);
      }
      return out;
    }
    return v;
  }

  function clipName(s) {
    const t = String(s == null ? '' : s);
    return t.length > MAX_NAME_LEN ? t.slice(0, MAX_NAME_LEN) + '…' : t;
  }

  function num(v) {
    return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
  }

  function roundDist(v) {
    return Number.isFinite(v) ? Math.round(v) : null;
  }

  // 与 matcher.js / card.js 同一公式（只用于记录，不参与决策）
  function distScoreOf(dist) {
    if (!Number.isFinite(dist)) return null;
    if (dist < 30) return 1;
    return Math.max(0, 1 - (dist - 30) / 1500);
  }

  /** #24：同名判定用的规范化（去括号补充、去空白；与 matcher 同一口径的近似）。 */
  function normName(s) {
    return String(s == null ? '' : s)
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/\s+/g, '')
      .trim();
  }

  /** 候选统一成 v2 字段；score 缺失时按 0 排（不猜分数） */
  function normalizeCandidate(raw, source, fallbackSource, steleName) {
    const c = raw || {};
    const poi = c.poi || {};
    const name = clipName(c.name != null ? c.name : (poi.name != null ? poi.name : ''));
    const sim = Number.isFinite(c.sim) ? c.sim
      : (Number.isFinite(c.nameSim) ? c.nameSim : null);
    const dist = roundDist(c.dist);
    const isSub = c.isSub === true || (Number.isFinite(c.subPen) && c.subPen < 1);
    // 借用名（excludeKind 非空：商户/行政/设施）不算同名本体。
    const excluded = !!c.excludeKind;
    const exact = !excluded && (c.exactName === true
      || (!!normName(steleName) && normName(name) === normName(steleName))
      || (Number.isFinite(sim) && sim >= 0.98 && !isSub));
    return {
      name,
      sim: num(sim),
      // commit L：惩罚尚未引入，simAdj 暂等值 sim
      simAdj: num(sim),
      dist,
      distScore: num(Number.isFinite(c.distScore) ? c.distScore : distScoreOf(c.dist)),
      typeRank: Number.isFinite(c.typeRank) ? c.typeRank
        : (Number.isFinite(c.rank) ? c.rank : null),
      subPen: num(c.subPen),
      pen: num(c.pen),
      source: source || fallbackSource || c.source || null,
      score: num(c.score),
      // #24：同名优先的数据基础（不改变评分，只记录）
      exactName: !!exact,
      ...(c.coordinateDriftKm == null ? {} : { coordinateDriftKm: num(c.coordinateDriftKm) }),
    };
  }

  function sortCandidates(list) {
    return (Array.isArray(list) ? list : []).slice().sort((a, b) => {
      const sa = Number.isFinite(a.score) ? a.score : -Infinity;
      const sb = Number.isFinite(b.score) ? b.score : -Infinity;
      if (sb !== sa) return sb - sa;
      const da = Number.isFinite(a.dist) ? a.dist : Infinity;
      const db = Number.isFinite(b.dist) ? b.dist : Infinity;
      return da - db;
    });
  }

  /** 一路的统计 → {candCount,bestSim,candidates[top5]} */
  function normalizeRoute(route, source, steleName) {
    const r = route || {};
    const all = (Array.isArray(r.candidates) ? r.candidates : [])
      .map(c => normalizeCandidate(c, source, undefined, steleName));
    const sorted = sortCandidates(all);
    const best = sorted.length ? sorted[0].sim : null;
    return {
      candCount: Number.isFinite(r.candCount) ? r.candCount
        : (Array.isArray(r.candidates) ? r.candidates.length : 0),
      bestSim: Number.isFinite(r.bestSim) ? r.bestSim
        : (Number.isFinite(best) ? best : 0),
      candidates: sorted.slice(0, TOP_N),
    };
  }

  function normalizeWhy(list) {
    const arr = Array.isArray(list) ? list : (list ? [list] : []);
    return arr.slice(0, MAX_WHY).map(x => clipName(x));
  }

  /** 组装 schema 2（采集侧已按契约给好，这里再按契约剪裁一次） */
  function normalizeV2(entry) {
    const e = entry || {};
    const stele = e.stele || {};
    const fin = e.final || null;
    return {
      schema: SCHEMA,
      ts: e.ts || new Date().toISOString(),
      version: e.version == null ? null : String(e.version),
      stele: {
        id: stele.id == null ? null : String(stele.id),
        name: clipName(stele.name),
        tier: stele.tier == null ? null : clipName(stele.tier),
      },
      routes: {
        name: normalizeRoute((e.routes || {}).name, 'name', stele.name),
        address: normalizeRoute((e.routes || {}).address, 'address', stele.name),
        nearby: normalizeRoute((e.routes || {}).nearby, 'nearby', stele.name),
      },
      // 兼容字段（v1 阅读习惯；不影响 v2 语义）
      ...(e.time == null ? {} : { time: e.time }),
      ...(e.site == null ? {} : { site: e.site }),
      ...(e.provider == null ? {} : { provider: e.provider }),
      ...(e.chosen === undefined ? {} : { chosen: e.chosen }),
      final: fin ? {
        pickedName: clipName(fin.pickedName),
        sim: num(fin.sim),
        simAdj: num(Number.isFinite(fin.simAdj) ? fin.simAdj : fin.sim),
        dist: roundDist(fin.dist),
        distScore: num(Number.isFinite(fin.distScore) ? fin.distScore : distScoreOf(fin.dist)),
        score: num(fin.score),
        source: fin.source == null ? null : String(fin.source),
        // #24：同名优先 + 3–10 km 坐标偏差（1 位小数，越界不记）
        exactName: fin.exactName === true,
        ...(Number.isFinite(fin.coordinateDriftKm) && fin.coordinateDriftKm > 0 && fin.coordinateDriftKm <= 10
          ? { coordinateDriftKm: Math.round(fin.coordinateDriftKm * 10) / 10 } : {}),
        why: normalizeWhy(fin.why),
      } : null,
    };
  }

  /** 旧 v1 记录：保留原字段，标 schema:1，明示无候选明细 */
  function normalizeLegacy(entry) {
    const legacy = sanitize(entry) || {};
    const out = { schema: 1, note: '无候选明细' };
    // 常见 v1 字段平铺出来（time/site/provider/chosen/final/evidence），其余也带上
    for (const k of Object.keys(legacy)) {
      if (k === 'schema' || k === 'note') continue;
      out[k] = legacy[k];
    }
    if (out.ts == null && typeof legacy.time === 'string') out.ts = legacy.time;
    return out;
  }

  function readAll() {
    return new Promise(resolve => {
      try {
        if (!window.chrome || !chrome.storage || !chrome.storage.local) return resolve([]);
        chrome.storage.local.get(STORAGE_KEY, items => {
          const v = items && items[STORAGE_KEY];
          resolve(Array.isArray(v) ? v : []);
        });
      } catch (e) { resolve([]); }
    });
  }

  function writeAll(list) {
    return new Promise(resolve => {
      try {
        if (!window.chrome || !chrome.storage || !chrome.storage.local) return resolve(false);
        chrome.storage.local.set({ [STORAGE_KEY]: list }, () => resolve(true));
      } catch (e) { resolve(false); }
    });
  }

  function versionOf() {
    try {
      if (window.chrome && chrome.runtime && typeof chrome.runtime.getManifest === 'function') {
        return chrome.runtime.getManifest().version || null;
      }
    } catch (e) { /* 非扩展环境 */ }
    return null;
  }

  window.HMP.decisionLog = {
    STORAGE_KEY,
    MAX_ENTRIES,
    SCHEMA,
    TOP_N,
    __test: { normalizeV2, normalizeLegacy, normalizeRoute, normalizeCandidate, distScoreOf },
    sanitize,
    maskString,

    /**
     * 追加一条决策（schema 2）；只保留最近 MAX_ENTRIES 条（环形）。
     * @param {object} entry
     */
    async append(entry) {
      if (!entry || typeof entry !== 'object') return null;
      const v2 = normalizeV2({ ...entry, version: entry.version || versionOf() });
      const clean = sanitize(v2);
      const all = await readAll();
      all.push(clean);
      const kept = all.slice(-MAX_ENTRIES);
      await writeAll(kept);
      return clean;
    },

    /** 读全部：v2 原样、v1 标 schema:1（已存数据本身已是 sanitize 后的） */
    async all() {
      const all = await readAll();
      return all.map(e => {
        if (e && typeof e === 'object' && e.schema === SCHEMA) return sanitize(e);
        return normalizeLegacy(e);
      });
    },

    async clear() {
      return writeAll([]);
    },

    /** 导出用 JSON 文本：空日志必须是 `[]`（不是空串/null） */
    async exportJSON() {
      const all = await this.all();
      return JSON.stringify(all, null, 2);
    }
  };
})();
