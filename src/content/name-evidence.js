// name-evidence.js
// #14-S · 核心提取（名称证据）
//
// 目的：回答「这个候选名里，哪一个**具体片段**证明它和文保点是同一个地方」。
// 朴素的「最长公共子序列」会把「南阳」「南阳市」「卧龙区」这类行政区/通用词挑成
// 证据，于是「南阳市卧龙区文化馆」看起来与「南阳武侯祠」高度相关。
//
// 这里改为「最长公共**子串** + 三关」：
//   ① coreLen ≥ 2；
//   ② 核心整段不得等于通用词表里的词（只判整段相等，不判包含：
//      「武侯祠」「文化馆」这类真名字不受影响）；
//   ③ coreLen / len(文保点名) ≥ 0.6，否则名称路弃权
//      （3/5 = 0.60 过线；2/5 = 0.40 弃权）。
//
// 返回值：
//   { core, prefixLen, suffixLen, coverRatio, abstain, reason }
//   prefixLen/suffixLen = 候选名里核心**前后多出来的字数**，
//   供 matcher 计算「缺席惩罚」（候选比文保名多出的字越多，越可能只是同名异地）。
(function () {
  'use strict';
  window.HMP = window.HMP || {};

  // 通用词表（方案-v2 修正 1）：只用于防「核心挑错」。
  // 判定方式＝核心整段 == 表中词；不做「包含」判断。
  const GENERIC_WORDS = [
    // 行政通用
    '省', '市', '区', '县', '镇', '乡', '村', '街道', '社区', '路', '街', '巷', '号',
    '大道', '广场',
    // 机构通用
    '政府', '人民政府', '公安局', '公安分局', '分局', '派出所', '警务',
    '管委会', '管理委员会', '管理处', '委员会', '局', '厅', '委', '办', '中心',
    '站', '所', '大队', '支队',
  ];
  const GENERIC_SET = new Set(GENERIC_WORDS);

  // 覆盖率下限：核心字数 / 文保点名长度。
  // 3/5 = 0.60 过线（P13「南阳武侯祠」→ 核心「武侯祠」），2/5 = 0.40 弃权。
  const MIN_COVER = 0.6;
  const MIN_CORE_LEN = 2;

  /** 两串的所有公共子串（长度 ≥ MIN_CORE_LEN），按长度降序、同长按在 a 中位置升序 */
  function commonSubstrings(a, b) {
    const A = String(a == null ? '' : a);
    const B = String(b == null ? '' : b);
    const out = [];
    if (!A || !B) return out;
    // 以 a 的每个起点、每个长度构造子串，看 b 是否包含。
    // 名字很短（≤ 40 字），O(n²·m) 足够；这里再加一步去重，避免同一段重复出现。
    const seen = new Set();
    for (let i = 0; i < A.length; i++) {
      for (let len = A.length - i; len >= MIN_CORE_LEN; len--) {
        const sub = A.slice(i, i + len);
        if (seen.has(sub)) continue;
        if (!B.includes(sub)) continue;
        seen.add(sub);
        out.push({ sub, index: i, len });
      }
    }
    out.sort((x, y) => (y.len - x.len) || (x.index - y.index));
    return out;
  }

  /**
   * 核心提取。
   * @param {string} steleName 文保点名称（原始全名）
   * @param {string} candidateName 地图候选名
   * @returns {{core:(string|null), prefixLen:number, suffixLen:number,
   *            coverRatio:number, abstain:boolean, reason:string}}
   */
  function coreEvidence(steleName, candidateName) {
    const stele = String(steleName == null ? '' : steleName).trim();
    const cand = String(candidateName == null ? '' : candidateName).trim();
    const abstain = (reason) => ({
      core: null, prefixLen: 0, suffixLen: 0, coverRatio: 0, abstain: true, reason,
    });
    if (!stele || !cand) return abstain('empty-name');

    let best = null;
    for (const item of commonSubstrings(stele, cand)) {
      if (GENERIC_SET.has(item.sub)) continue; // ② 整段等于通用词 → 丢弃，取次长
      best = item;
      break;
    }
    if (!best) return abstain('no-core'); // ① + ②

    const coverRatio = best.len / stele.length;
    if (coverRatio < MIN_COVER) return abstain('low-cover'); // ③

    // 候选里核心第一次出现的位置即可（候选名很短，重复出现无实际意义）
    const idx = cand.indexOf(best.sub);
    const prefixLen = idx < 0 ? 0 : idx;
    const suffixLen = idx < 0 ? 0 : (cand.length - idx - best.len);
    return {
      core: best.sub,
      prefixLen,
      suffixLen,
      coverRatio: Math.round(coverRatio * 1000) / 1000,
      abstain: false,
      reason: '',
    };
  }

  const api = { coreEvidence, commonSubstrings, GENERIC_WORDS, MIN_COVER, MIN_CORE_LEN };
  window.HMP.nameEvidence = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
