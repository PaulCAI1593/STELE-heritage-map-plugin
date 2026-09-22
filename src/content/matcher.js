// matcher.js
// 给定一个 STELE POI 和一组候选（来自高德/百度），挑出最匹配的一个。
// 评分：name 相似度 × 0.6 + 距离得分 × 0.4
// 通过阈值：sim >= 0.6 && dist <= 500m  OR  sim >= 0.85（距离可放宽）

(function () {
  'use strict';
  window.HMP = window.HMP || {};

  // Levenshtein 距离（O(mn) 空间复杂度对短字符串够用）
  function levenshtein(a, b) {
    if (a === b) return 0;
    const al = a.length, bl = b.length;
    if (!al) return bl;
    if (!bl) return al;
    const prev = new Array(bl + 1);
    const curr = new Array(bl + 1);
    for (let j = 0; j <= bl; j++) prev[j] = j;
    for (let i = 1; i <= al; i++) {
      curr[0] = i;
      const ac = a.charCodeAt(i - 1);
      for (let j = 1; j <= bl; j++) {
        const cost = ac === b.charCodeAt(j - 1) ? 0 : 1;
        curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      }
      for (let j = 0; j <= bl; j++) prev[j] = curr[j];
    }
    return prev[bl];
  }

  function levenshteinSimilarity(a, b) {
    if (!a || !b) return 0;
    const max = Math.max(a.length, b.length);
    if (!max) return 1;
    return 1 - levenshtein(a, b) / max;
  }

  // 同时考虑子串包含（"莫高窟" ⊂ "敦煌莫高窟景区"）
  function containsScore(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;
    if (longer.includes(shorter)) {
      return 0.5 + 0.5 * (shorter.length / longer.length);
    }
    return 0;
  }

  // 名称规范化策略：
  //   - 去除括号注释（高德/百度经常在名称后用括号注行政区）
  //   - 去除末尾噪声词（"景区"/"博物院"/"博物馆"/"公园"/...）
  //   - **不主动剥开头行政区前缀**（因为难以稳定判断"莫高窟景区"中的"区"是行政还是噪声）；
  //     这种情况交给 containsScore 处理（"莫高窟" ⊂ "敦煌市莫高窟"）

  const NOISE_SUFFIX_WORDS = [
    '游客中心', '博物院', '博物馆', '售票处', '管理局', '度假村',
    '大教堂', '研究院', '展览馆', '纪念馆', '文化馆', '图书馆',
    '清真寺', '山庄', '古寺', '禅寺', '道观',
    '遗址', '公园', '景区'
  ];

  function stripSuffix(s, words) {
    for (const w of words) {
      if (s.endsWith(w) && s.length > w.length) {
        return s.slice(0, -w.length);
      }
    }
    return s;
  }

  function stripParen(s) {
    return s.replace(/[\(（][^\)）]+[\)）]/g, '').trim();
  }

  function normalizeName(s) {
    if (!s) return '';
    let x = String(s).trim();
    x = stripParen(x);
    for (let i = 0; i < 2; i++) {
      const before = x;
      x = stripSuffix(x, NOISE_SUFFIX_WORDS);
      if (x === before) break;
    }
    return x.trim();
  }

  // 名称变体：优先用 naming 模块（处理"及/－/、"等官方长名），无则退化为单元素
  function variantsOf(s) {
    const naming = window.HMP && window.HMP.naming;
    if (naming && typeof naming.searchNames === 'function') {
      const v = naming.searchNames(s);
      if (v && v.length) return v;
    }
    return [String(s == null ? '' : s).trim()];
  }

  // 候选名 = 目标名 + 这类"设施后缀"，说明它是目标景区内的衍生点
  // （博物馆/游客中心…），不应盖过目标本体。
  const FACILITY_SUFFIX = /^(?:博物馆|博物院|纪念馆|展览馆|陈列馆|游客中心|服务中心|售票处|管理处|研究院|研究所|停车场|商店|餐厅|广场|入口|出口|大门|遗址公园)/;
  const FACILITY_PENALTY = 0.85; // 衍生点降权
  const CONTAIN_BONUS = 0.06;    // 候选是目标的"简短常用名"时加权

  // 候选名 = 目标名 + 连接号 + 后缀，形如
  //   "上海国际饭店-会议中心"、"上海孙中山故居纪念馆-草坪与建筑"
  // 这是地图上的**子单元**，不该盖过本体（本体名往往还是精确匹配）。
  // 放在匹配器里，三条检索路径（名称/地址/坐标）就都能受益。
  const SUBUNIT_SEP = /^[-－—–·•]/;
  const SUBUNIT_PENALTY = 0.6;

  // 无连接号的「本体名 + 附属设施后缀」，如「上海音乐厅」→「上海音乐厅咖啡厅」。
  // 这些后缀指的是楼里的咖啡厅/商店/售票处，不是点位本身。
  // ⚠️ 只收**附属设施**，不能对所有后缀一刀切：
  //    "故宫" → "故宫博物院"、"良渚遗址" → "良渚遗址公园" 都是正确匹配，不在表内。
  const SUBUNIT_TAIL = new RegExp('^(?:' + [
    '咖啡厅', '咖啡馆', '咖啡店', '咖啡', '茶室', '茶馆', '茶楼',
    '餐厅', '食堂', '酒吧',
    '商店', '便利店', '礼品店', '纪念品店', '文创店',
    '售票处', '检票口', '服务中心', '游客中心',
    '管理处', '管理委员会', '办公区', '办公点', '停车场', '洗手间', '卫生间',
  ].join('|') + ')');

  /**
   * 候选级「子单元」判定：候选名 = 目标名变体 + 连接号 + 后缀。
   *   目标「上海国际饭店」  候选「上海国际饭店-会议中心」   → 罚
   *   目标「上海孙中山故居」候选「上海孙中山故居纪念馆-草坪」→ 罚
   *
   * 必须放在候选级别而不是名称对级别：naming.searchNames 会把
   * 「上海国际饭店-会议中心」拆出变体「上海国际饭店」，名称相似度又变成 1.0，
   * 名称对级别根本罚不到。
   *
   * @returns {number} 惩罚系数（1 = 不罚）
   */
  function subUnitPenalty(targetVariants, candName, fullName) {
    const name = String(candName == null ? '' : candName).trim();
    if (!name) return 1;
    const variants = targetVariants || [];
    // 目标**原始全名**：形态一必须拿它比，不能用 searchNames 拆出来的短变体。
    //   "马当路45-47号住宅" 会被拆出变体 "马当路45"，
    //   若拿变体去比，精确同名的候选会被误判成"本体马当路45 + -47号住宅"而降权。
    const full = String(
      (fullName != null && fullName !== '') ? fullName
        : (variants.length ? variants.reduce((a, b) =>
            String(a).length >= String(b).length ? a : b) : '')
    ).trim();

    // 连接号位置（形态二用它取头段）
    const sepMatch = name.match(/[-－—–·•]/);
    const sepIdx = sepMatch ? sepMatch.index : -1;
    const head = sepIdx > 0 ? name.slice(0, sepIdx) : '';

    // 形态一：**原始全名** + 连接号 + 后缀（"上海国际饭店-会议中心"；
    //         也包括"马当路45-47号住宅-东楼"这种真子单元）
    if (full && name.length > full.length && name.startsWith(full) &&
        SUBUNIT_SEP.test(name.slice(full.length))) {
      return SUBUNIT_PENALTY;
    }

    // 形态二：连接号**前半段**比命中的变体更长（即头段是在本体基础上继续加字），
    //         如 "上海孙中山故居纪念馆-草坪与建筑"（头段 = 本体 + "纪念馆"）。
    //         反过来 "马当路45-47号住宅" 的头段是 "马当路"，比变体"马当路45"更短，
    //         属于名称自带连接号，不罚。
    for (const t of variants) {
      const v = String(t == null ? '' : t).trim();
      if (!v) continue;
      if (head && head.length > v.length && head !== name && pairScore(v, head) >= 0.8) {
        return SUBUNIT_PENALTY;
      }
    }

    // 形态三：**没有连接号**，直接是「本体名 + 附属设施后缀」。
    //   上海音乐厅 → 上海音乐厅咖啡厅（实测：咖啡厅盖过了音乐厅本体）
    // 形态一、二都靠连接号定位，碰不到这种写法，只能按后缀词判。
    // 因为只在本体名是前缀、且后缀是明确的附属设施词时才罚，
    // "故宫"→"故宫博物院" 这类"本体 + 正式后缀"不受影响。
    for (const t of variants.concat([full])) {
      const v = String(t == null ? '' : t).trim();
      if (v.length < 2) continue;
      if (name.length > v.length && name.startsWith(v) &&
          SUBUNIT_TAIL.test(name.slice(v.length))) {
        return SUBUNIT_PENALTY;
      }
    }
    return 1;
  }

  /**
   * 一对名称的得分。
   *
   * 相比单纯取 max(raw, normalized)，这里额外处理两类真实误匹配：
   *   A. 过度去后缀导致"撞车"：normalizeName("良渚遗址")="良渚"、
   *      normalizeName("良渚博物院")="良渚"，两者会双双变成 1.0。
   *      → 规范化名少于 3 字时不参与打分。
   *   B. 衍生点盖过本体：目标"承德避暑山庄"，候选"承德避暑山庄博物馆"
   *      规范化后与目标完全相同（1.0），会压过真正的"避暑山庄"。
   *      → 命中设施后缀时降权；候选是目标的简短常用名时加权。
   */
  /**
   * 规范化结果是否可信。
   * 只有"被截断成短桩"时才不可信——判据是它既不等于自己、也不等于对方的原名。
   *   ("故宫",      "故宫博物院")  → aN="故宫" 恰是 a 本身 → 可信（故宫本就是 2 字全名）
   *   ("良渚遗址",  "良渚博物院")  → aN="良渚" 既非 a 也非 b → 不可信（被截成短桩）
   */
  function normTrustworthy(orig, normed, other) {
    if (normed.length >= 3) return true;
    const o = String(orig == null ? '' : orig).trim();
    const t = String(other == null ? '' : other).trim();
    return normed === o || normed === t;
  }

  function pairScore(a, b) {
    const aN = normalizeName(a);
    const bN = normalizeName(b);
    const raw = Math.max(levenshteinSimilarity(a, b), containsScore(a, b));
    // A. 规范化把名字截成短桩时不可信（否则"良渚遗址"和"良渚博物院"会双双变成"良渚"而撞车）
    const normOk = normTrustworthy(a, aN, b) && normTrustworthy(b, bN, a);
    const norm = normOk
      ? Math.max(levenshteinSimilarity(aN, bN), containsScore(aN, bN))
      : 0;
    const fromNorm = norm > raw;
    let s = Math.max(raw, norm);

    if (a !== b && a.includes(b)) {
      // 候选是目标的简短常用名（"承德避暑山庄" ⊃ "避暑山庄"）
      s = Math.min(1, s + CONTAIN_BONUS);
    } else if (false) {
      // （连接号子单元改由候选级别的 subUnitPenalty 统一处理，见下）
    } else if (fromNorm && b.length > a.length && b.startsWith(a) &&
               FACILITY_SUFFIX.test(b.slice(a.length))) {
      // 候选是目标的衍生设施（"承德避暑山庄" + "博物馆"）。
      // 仅在分数"靠规范化撑起来"时降权；若原始名本身就不错（如"故宫"→"故宫博物院"）
      // 说明该候选就是本体，不降权。
      s *= FACILITY_PENALTY;
    }
    return s;
  }

  /**
   * 名称相似度：对「目标名变体 × 候选名变体」的笛卡尔积取最高分。
   * 这样 "承德避暑山庄及其周围寺庙" 能通过变体 "承德避暑山庄" 命中候选。
   */
  function nameScore(a, b) {
    const aVars = variantsOf(a);
    const bVars = variantsOf(b);
    let best = 0;
    for (const x of aVars) {
      for (const y of bVars) {
        const s = pairScore(x, y);
        if (s > best) best = s;
        if (best >= 1) return 1;
      }
    }
    return best;
  }

  function haversine(lon1, lat1, lon2, lat2) {
    if (![lon1, lat1, lon2, lat2].every(Number.isFinite)) return Infinity;
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  // 阈值策略：以名称为主。
  //
  // 为什么不靠距离：STELE 站点坐标实测相对真实位置系统性偏移约
  // (-3.32°, +1.52°)（≈340 km，16 个多点位实测，见 DESIGN.md）。既然目标
  // 坐标本身就偏了 340 km，距离对「正确候选」和「错误候选」都不再有区分度，
  // 因此不能让距离成为硬性拒绝条件（否则 offset > 500km 的点位会被全部拒掉）。
  //
  // 现行判定：
  //   1) sim >= 0.7  → 接受（名称为主；坐标偏移下不能再卡距离）
  //   2) sim >= 0.55 → 仅在距离确实很近（<=500m）时才接受
  //   3) 其余 → 拒绝
  function passes(sim, dist) {
    if (sim >= 0.7) return true;
    if (sim >= 0.55 && Number.isFinite(dist) && dist <= 500) return true;
    return false;
  }

  window.HMP.matcher = {
    levenshteinSimilarity,
    nameScore,
    subUnitPenalty,
    haversine,
    passes,

    /**
     * @param {object} target {name, lon, lat, admin}
     * @param {Array} candidates 来自 amap.search 或 baidu.search 的候选列表
     * @returns {object|null} {poi, sim, dist, score} 或 null（未匹配）
     */
    /**
     * @param {object} target {name, nameVariants?, lon, lat}
     * @param {Array}  candidates
     * @param {object} [opts]
     * @param {function} [opts.rank] 候选可参观性打分（2=像文物/景点，1=未知，0=明显无关）。
     *        用于同名候选之间的取舍，例如
     *        「上海三山会馆」（博物馆）应胜过「上海三山会馆管理委」（办事机构）。
     */
    pick(target, candidates, opts) {
      if (!Array.isArray(candidates) || !candidates.length) return null;
      const targetName = (target.name || '').trim();
      if (!targetName) return null;
      const rankFn = (opts && typeof opts.rank === 'function') ? opts.rank : null;
      const penFn = (opts && typeof opts.penalty === 'function') ? opts.penalty : null;

      // 目标名变体：优先用调用方给出的完整列表
      // （含从 address/intro 挖出的「现用名」，如 真觉寺金刚宝座 → 北京石刻艺术博物馆）。
      // 这样"用现用名检索到的结果"也能被正确认作名称命中，而不是退化成位置匹配。
      const tVars = (Array.isArray(target.nameVariants) && target.nameVariants.length)
        ? target.nameVariants
        : variantsOf(targetName);

      // 办事机构类后缀：名字里带这些的多半是"管理处/管委会"而非可参观的点位
      const ADMIN_SUFFIX_RE = /(管理委员会|管委会|管理委|管理处|办事处|管理局|管理中心)$/;

      const scored = candidates.map(c => {
        const cName = (c.name || '').trim();
        let sim = 0;
        for (const t of tVars) {
          const s = nameScore(t, cName);
          if (s > sim) sim = s;
          if (sim >= 1) break;
        }
        const dist = (Number.isFinite(target.lon) && Number.isFinite(c.lon))
          ? haversine(target.lon, target.lat, c.lon, c.lat)
          : Infinity;
        const distScore = !Number.isFinite(dist) ? 0.5
          : dist < 30 ? 1
          : Math.max(0, 1 - (dist - 30) / 1500);

        // 类型偏好：可参观的（博物馆/景点/寺庙…）优先
        let typeRank = 0, mult = 1;
        if (rankFn) {
          typeRank = rankFn(c) || 0;
          mult = typeRank === 2 ? 1.12 : (typeRank === 0 ? 0.7 : 1.0);
        }
        // 办事机构名称轻微降权
        if (ADMIN_SUFFIX_RE.test(cName)) mult *= 0.85;

        // 子单元降权（候选名 = 目标名 + 连接号 + 后缀，或本体名 + 附属设施后缀）
        // 传 targetName（原始全名）而不是只传变体：变体是 searchNames 拆出来的短桩，
        // 拿短桩去比会把精确同名的候选误判成子单元（见 subUnitPenalty 注释）。
        const subPen = subUnitPenalty(tVars, cName, targetName);
        const custPen = penFn ? (penFn(c) || 1) : 1;
        const score = (sim * 0.6 + distScore * 0.4) * mult * subPen * custPen;
        return { poi: c, sim, dist, typeRank, score, isSub: subPen < 1 };
      });

      // 先按综合分（含类型偏好）排；同分再看距离
      scored.sort((a, b) =>
        (b.score - a.score) !== 0 ? (b.score - a.score) : (a.dist - b.dist)
      );

      // 依次取第一个"可接受"的候选。
      // 注意可接受性仍用**原始名称相似度**判定，类型偏好只影响排序，不降低门槛。
      for (const s of scored) {
        if (passes(s.sim, s.dist)) return s;
      }
      return null;
    }
  };
})();