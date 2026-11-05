// decision-log.js
// 「最近 20 条匹配决策」环形日志：给用户/支持排障用。
//
// 只存**决策所需的最小信息**：时间、点位、哪家地图、三路各自的候选数与最高相似度、
// 选了哪一路、最终采用的 POI 及其 sim/score/dist。
//
// ⚠️ 绝不把 API Key 写进日志，也绝不把带 `key=` / `ak=` 的 URL 原样导出：
// 日志可能被用户贴到公开的 issue 里，Key 泄露会直接被刷额度。
// 写入与导出两处都过 sanitize（双保险）。

(function () {
  'use strict';
  window.HMP = window.HMP || {};

  const STORAGE_KEY = 'hmp:decisionLog';
  const MAX_ENTRIES = 20;

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

  window.HMP.decisionLog = {
    STORAGE_KEY,
    MAX_ENTRIES,
    sanitize,
    maskString,

    /**
     * 追加一条决策；只保留最近 MAX_ENTRIES 条（环形）。
     * @param {object} entry
     */
    async append(entry) {
      if (!entry || typeof entry !== 'object') return null;
      const clean = sanitize(entry);
      const all = await readAll();
      all.push(clean);
      const kept = all.slice(-MAX_ENTRIES);
      await writeAll(kept);
      return clean;
    },

    /** 读全部（已存的是 sanitize 后的数据，这里再洗一遍防旧数据） */
    async all() {
      const all = await readAll();
      return sanitize(all);
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
