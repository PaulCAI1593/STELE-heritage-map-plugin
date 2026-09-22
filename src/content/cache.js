// cache.js
// 基于 chrome.storage.local 的 LRU-ish 缓存（按 TTL 过期）
// 键格式：hmp:cache:v<版本>:<provider>:<nameHash>:<adminHash>
// 值：{ ok, data, expireAt }
//
// ⚠️ 键里带 DATA_VERSION：**匹配/过滤逻辑一变就要把它 +1**。
// 否则老结果会在 7 天 TTL 内继续命中——表现为"代码明明修好了，界面上还是旧行为"
// （曾经踩过：把公交站/打卡点过滤掉之后，已看过的那几个点位依旧显示旧的错误匹配）。

(function () {
  'use strict';
  window.HMP = window.HMP || {};

  // 匹配/过滤逻辑的版本。改了 matcher / card 的取舍规则就 +1。
  //   1 → 初版
  //   2 → 排除设施类（公交站/地铁站/停车场/打卡点）、可参观类型优先、子单元降权
  //   3 → 名称/地址/坐标三路组合 + 交叉印证；排除大门与无关商户
  //   4 → 不再按商业类型排除（酒店/银行/商场可能就是文保现状）；
  //       子单元双重降权（名称「本体-子单元」+ 地址含楼层）
  const DATA_VERSION = 35;

  const BASE_PREFIX = 'hmp:cache:';                       // 用于清空/统计（跨版本）
  const PREFIX = BASE_PREFIX + 'v' + DATA_VERSION + ':';  // 用于读写（带版本）
  const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
  const MAX_ENTRIES = 2000; // 防止 storage 膨胀

  // 简易字符串哈希（djb2）
  function djb2(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
  }

  async function getAll() {
    return new Promise(resolve => {
      chrome.storage.local.get(null, items => resolve(items || {}));
    });
  }

  async function setMany(entries) {
    return new Promise(resolve => {
      chrome.storage.local.set(entries, () => resolve());
    });
  }

  async function removeMany(keys) {
    return new Promise(resolve => {
      chrome.storage.local.remove(keys, () => resolve());
    });
  }

  window.HMP.cache = {
    PREFIX,
    BASE_PREFIX,
    DATA_VERSION,
    TTL_MS,
    MAX_ENTRIES,

    keyOf(provider, name, admin) {
      return PREFIX + provider + ':' + djb2(name + '|' + (admin || ''));
    },

    async get(provider, name, admin) {
      const k = this.keyOf(provider, name, admin);
      const all = await getAll();
      const entry = all[k];
      if (!entry) return null;
      if (entry.expireAt && entry.expireAt < Date.now()) {
        await removeMany([k]);
        return null;
      }
      return entry;
    },

    /**
     * 写入缓存；如超过 MAX_ENTRIES 则清理最旧的
     * @param {string} provider
     * @param {string} name
     * @param {string} admin
     * @param {object} data 任意可 JSON 序列化的对象
     */
    async set(provider, name, admin, data) {
      const k = this.keyOf(provider, name, admin);
      const entry = {
        provider,
        name,
        admin: admin || '',
        data,
        expireAt: Date.now() + TTL_MS,
        savedAt: Date.now()
      };
      const all = await getAll();
      const cacheEntries = Object.entries(all).filter(([kk]) => kk.startsWith(BASE_PREFIX));
      if (cacheEntries.length >= MAX_ENTRIES) {
        // 删掉最旧的 200 条
        cacheEntries.sort((a, b) => (a[1].savedAt || 0) - (b[1].savedAt || 0));
        const toRemove = cacheEntries.slice(0, 200).map(([kk]) => kk);
        await removeMany(toRemove);
      }
      await setMany({ [k]: entry });
    },

    /** 调试用：清空所有缓存 */
    async clear() {
      const all = await getAll();
      // 注意跨版本清理：旧版本键也要一起清掉
      const keys = Object.keys(all).filter(k => k.startsWith(BASE_PREFIX));
      if (keys.length) await removeMany(keys);
    },

    /** 调试用：列出缓存大小 */
    async stats() {
      const all = await getAll();
      const keys = Object.keys(all).filter(k => k.startsWith(BASE_PREFIX));
      const current = keys.filter(k => k.startsWith(PREFIX));
      return { count: keys.length, currentVersion: current.length, dataVersion: DATA_VERSION };
    },

    /**
     * 清掉非当前版本的缓存键。
     * 带版本的键本来就"读不到"，但残留在 storage 里会白占配额，
     * 这里在脚本加载时顺手清一次。
     * @returns {Promise<number>} 清理条数
     */
    async purgeOldVersions() {
      const all = await getAll();
      const stale = Object.keys(all).filter(k =>
        k.startsWith(BASE_PREFIX) && !k.startsWith(PREFIX));
      if (stale.length) await removeMany(stale);
      return stale.length;
    }
  };

  // 脚本加载时清理旧版本残留
  window.HMP.cache.purgeOldVersions().then(n => {
    if (n > 0) {
      console.log('[HMP] 已清理 ' + n + ' 条旧版本缓存（当前数据版本 v' + DATA_VERSION + '）');
    }
  }).catch(() => { /* 忽略 */ });
})();