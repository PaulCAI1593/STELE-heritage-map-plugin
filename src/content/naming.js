// naming.js
// 行政区 / 名称规范化工具：把 STELE 的 admin、name 转成适合高德/百度检索的形式。
//
// 背景（基于 16 个真实点位实测）：
//
// 1) admin 字段格式不统一，直接塞给地图 API 的 region 参数会非法或被忽略：
//      ["北京市 东城区"]                       ← 空格分隔多级
//      ["江苏省南京市玄武区、雨花台区"]          ← 无空格 + 顿号
//      ["云南省丽江市古城区、玉龙纳西族自治县"]   ← 同上
//    必须抽出"市"级（北京市 / 南京市 / 丽江市）再传。
//
// 2) name 有时是"官方文物名"，比地图 POI 名更长、带连接符：
//      "曲阜孔庙及孔府" / "承德避暑山庄及其周围寺庙"
//      "皖南古村落－西递、宏村" / "良渚遗址-莫角山遗址" / "鼓浪屿近代建筑群"
//    需要生成若干候选检索词逐个尝试，并让匹配器按"最佳变体"打分。

(function () {
  'use strict';
  window.HMP = window.HMP || {};

  // 独立的市级名（2-6 字 + 市/自治州/地区/盟）
  const CITY_RE = /^[\u4e00-\u9fa5]{2,6}(?:市|自治州|地区|盟)$/;
  // 省级后缀（兜底时排除）
  const PROV_RE = /(?:省|自治区|特别行政区)$/;
  // 尾部"类型词"，剥离后得到更通用的检索名
  // 尾部类型词。去掉后往往才是地图上真正用的名字。
  //
  // ⚠️ 别漏「旧址 / 故居 / 旧居 / 原址」这类——文保名录习惯这么起名，
  //    但地图 POI 通常不带：
  //      四行仓库抗战旧址 → 地图上叫「上海四行仓库抗战纪念馆」
  //    漏掉它们会让这个点位**一个变体都生不出来**，只剩全名去搜，
  //    高德靠模糊匹配勉强能中，百度就直接返回空。
  const TYPE_TAIL = /(?:近代建筑群|古建筑群|建筑群|寺庙群|墓葬群|石窟|石刻|遗址群|遗址|古城|古村落|园林|保护区|旧址群|旧址|旧居|故居|原址|遗存|纪念地)$/;

  /**
   * 从 admin 里抽出"市"级名称。
   *   ["北京市 东城区"]                      → "北京市"
   *   ["江苏省南京市玄武区、雨花台区"]         → "南京市"
   *   ["云南省丽江市古城区、玉龙纳西族自治县"]  → "丽江市"
   *   ["晋中市 平遥县"]                       → "晋中市"
   *   ["内蒙古自治区呼和浩特市新城区"]         → "呼和浩特市"
   *
   * @param {string[]|string} admin
   * @returns {string} 市级名；无法判断时返回末级名称
   */
  function extractCity(admin) {
    const raw = Array.isArray(admin) ? admin.join(' ') : String(admin || '');
    // 统一分隔符（顿号 / 逗号 / 分号 / 斜杠 → 空格）
    const s = raw.replace(/[、,，;；/]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    const tokens = s.split(' ').filter(Boolean);

    // 1) 独立成段的市级名，取"最靠后"的一个（越靠后越精确）
    //    ["酒泉市 敦煌市"] → "敦煌市"（而非地级市"酒泉市"）
    //    ["北京市 东城区"] → "北京市"（东城区不是市）
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (CITY_RE.test(tokens[i])) return tokens[i];
    }

    // 2) 粘连形式：从"江苏省南京市玄武区"里抠出"南京市"
    //    前一个字符必须是 省/区/县/盟 或字符串开头，避免抠出"苏省南京市"
    const m = s.match(/(?:^|[省区县盟\s])([\u4e00-\u9fa5]{2,4}市)/);
    if (m) return m[1];

    // 3) 自治州 / 地区 / 盟
    const m2 = s.match(/([\u4e00-\u9fa5]{2,6}(?:自治州|地区|盟))/);
    if (m2) return m2[1];

    // 4) 兜底：从后往前找第一个非省级的段
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (tokens[i] && !PROV_RE.test(tokens[i])) return tokens[i];
    }
    return tokens[tokens.length - 1] || '';
  }

  /**
   * 生成用于检索的名称变体（按"从具体到宽泛"排序，去重）。
   *   "故宫"                     → ["故宫"]
   *   "曲阜孔庙及孔府"            → ["曲阜孔庙及孔府", "曲阜孔庙"]
   *   "皖南古村落－西递、宏村"     → ["皖南古村落－西递、宏村", "皖南古村落", "皖南古村落－西递", ...]
   *   "鼓浪屿近代建筑群"          → ["鼓浪屿近代建筑群", "鼓浪屿"]
   *   "良渚遗址-莫角山遗址"       → ["良渚遗址-莫角山遗址", "良渚遗址"]
   *
   * @param {string} name
   * @returns {string[]}
   */
  function searchNames(name) {
    const out = [];
    const push = v => {
      v = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
      if (v && !out.includes(v)) out.push(v);
    };
    const n = String(name || '').trim();
    if (!n) return out;
    push(n);

    // 按"及/暨/与"截断："曲阜孔庙及孔府" → "曲阜孔庙"
    const noAnd = n.split(/[及暨与]/)[0];
    // 按破折号截断："良渚遗址-莫角山遗址" → "良渚遗址"
    const noDash = n.split(/[－—–\-]/)[0];
    // 按顿号截断："西递、宏村" → "西递"
    const noComma = n.split(/[、,，]/)[0];

    push(noAnd);
    push(noDash);
    push(noComma);
    push(noAnd.split(/[－—–\-]/)[0].split(/[、,，]/)[0]);
    push(noDash.split(/[、,，]/)[0]);

    // 去掉尾部类型词（仅当剩余部分 >= 3 字，避免"平遥古城"→"平遥"这类过度缩短）
    for (const c of out.slice()) {
      const stripped = c.replace(TYPE_TAIL, '');
      if (stripped !== c && stripped.length >= 3) push(stripped);
    }

    // 去掉括号注释
    for (const c of out.slice()) {
      const noParen = c.replace(/[\(（][^\)）]*[\)）]/g, '').trim();
      if (noParen !== c) push(noParen);
    }

    return out;
  }

  // 现用名常见后缀。
  // 注意要包含「饭店/酒店/宾馆/餐厅」这类——很多文保建筑现在就是宾馆饭店，
  // 例如 马勒住宅 → 现为「马勒别墅饭店」。
  const MODERN_TAIL = '博物馆|纪念馆|展览馆|陈列馆|艺术馆|美术馆|科技馆|文化馆'
    + '|公园|景区|文管所|管理处|研究院|研究所|大学|书院'
    + '|饭店|酒店|宾馆|餐厅|公寓|大楼|商厦|购物中心|中心';
  // "现为/今为/改为/改作 XXX"
  // 用 "XXX至今" 作终止符很重要：intro 里常见
  // 「由衡山集团改作马勒别墅饭店至今。」，否则会把"至今"一起吃进名字。
  const RE_MODERN_VERB = new RegExp(
    '(?:现(?:为|作|辟为|辟作|已辟为)|今为|改为|改作|改建成|改建为|更名为|易名为|设为|用作)'
    + '([\\u4e00-\\u9fa5A-Za-z0-9]{2,24}?(?:' + MODERN_TAIL + ')?)'
    + '(?=至今|[，。；、,;\\s]|$)', 'g');
  // 地址里以馆/园结尾的机构名，如 "五塔寺村24号北京石刻艺术博物馆内"
  // 要求前面有「号/，/、」边界，避免从中间截出 "号北京石刻艺术博物馆" 这类噪声
  const RE_MODERN_SUFFIX = new RegExp(
    '(?:[号，,、；;]|^)([\\u4e00-\\u9fa5]{2,20}?(?:' + MODERN_TAIL + '))(?=内|里|旁|附近|东侧|西侧|南侧|北侧|、|，|。|,|$)', 'g');
  // "又名/俗称/又称 XXX"
  const RE_ALIAS = /(?:又名|俗称|又称|亦名|旧称)([\u4e00-\u9fa5]{2,12})/g;

  /**
   * 从 address / intro 里挖出「现用名」「别名」。
   * 文保名称常与现用名完全不同（真觉寺金刚宝座 → 北京石刻艺术博物馆），
   * 而站点数据里往往藏着线索：
   *   address: "五塔寺村24号北京石刻艺术博物馆内"
   *   address: "北三环西路甲31号，现为大钟寺古钟博物馆"
   *   intro  : "觉生寺又名大钟寺"
   *
   * @param {string} address
   * @param {string} introHtml
   * @returns {string[]} 额外检索名（可能为空）
   */
  function extractModernNames(address, introHtml) {
    const text = [String(address || ''), String(introHtml || '').replace(/<[^>]+>/g, '')]
      .join('。');

    const raw = [];
    let m;
    RE_MODERN_VERB.lastIndex = 0;
    while ((m = RE_MODERN_VERB.exec(text))) raw.push(m[1]);
    RE_MODERN_SUFFIX.lastIndex = 0;
    while ((m = RE_MODERN_SUFFIX.exec(text))) raw.push(m[1]);
    RE_ALIAS.lastIndex = 0;
    while ((m = RE_ALIAS.exec(text))) raw.push(m[1]);

    // 清洗：去括号注释、去开头的地名尾缀/连接词/日期等噪声
    const cleaned = [];
    for (let v of raw) {
      v = String(v)
        .replace(/[（(][^）)]*[）)]/g, '')
        .replace(/\s+/g, '')
        .trim();
      // 注意不要把「东/西/南/北」等方位字当噪声（"北京石刻艺术博物馆"会被截坏）
      v = v.replace(/^[号内里为作于在的了后又再年月日0-9]+/, '');
      if (v.length < 3 || v.length > 16) continue;
      // 含动词/公文用语的碎片不是机构名
      if (/(辟建|成立|批准|改为|设置|作为|位于|建于|曾为)/.test(v)) continue;
      if (!cleaned.includes(v)) cleaned.push(v);
    }

    // 去掉"被更长串包含"的冗余项：若 A 以 B 结尾，丢弃 A
    return cleaned.filter((a, i) =>
      !cleaned.some((b, j) => j !== i && b.length < a.length && a.endsWith(b))
    );
  }

  /**
   * 文物组子项目的检索名：**带上父文保名**，避免泛词乱匹配。
   *
   * 例：父「上海交通大学早期建筑」+ 子「图书馆」
   *     → ["上海交通大学早期建筑 图书馆", "图书馆"]
   * 只用「图书馆」去搜会匹配到完全无关的 POI（实测匹配到过按摩店）。
   *
   * 若子名已被父名包含（如 父「莫高窟」+ 子「莫高窟」），则不加前缀。
   *
   * @param {string} memberName 子项目名
   * @param {string} parentName 所属文保（组）名
   * @returns {string[]} 检索名，按「从精确到宽泛」排序
   */
  function memberSearchNames(memberName, parentName) {
    const out = [];
    const push = v => {
      v = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
      if (v && !out.includes(v)) out.push(v);
    };
    const m = String(memberName || '').trim();
    const p = String(parentName || '').trim();
    if (!m) return out;

    // 父名 + 子名（更精确）。父子互相包含时跳过，避免出现"莫高窟 莫高窟"
    if (p && !p.includes(m) && !m.includes(p)) {
      push(p + ' ' + m);
    }
    for (const v of searchNames(m)) push(v);
    return out;
  }

  /**
   * 把站点里的地址清成"可直接检索的地址"。
   * 站点的 address 常混着说明文字，直接拿去搜会跑偏：
   *   "景山前街4号，现为故宫博物院"           → "景山前街4号"
   *   "五塔寺村24号北京石刻艺术博物馆内"       → "五塔寺村24号"
   *   "北三环西路甲31号，现为大钟寺古钟博物馆" → "北三环西路甲31号"
   *   "陕西南路30号"                         → "陕西南路30号"
   *
   * @param {string} addr
   * @returns {string}
   */
  function cleanAddress(addr) {
    let a = String(addr == null ? '' : addr).trim();
    if (!a) return '';
    a = a.replace(/[（(][^）)]*[）)]/g, '').trim();   // 去括号注释
    a = a.split(/[，,；;]/)[0].trim();              // 只取第一段（后面通常是"现为XXX"）

    // 地址里常把机构名写在门牌后面（"五塔寺村24号北京石刻艺术博物馆内"）。
    // 直接写正则删容易连门牌号一起吃（数字不在 \u4e00-\u9fa5 里），
    // 所以复用 extractModernNames 先把机构名找出来，再按位置截断。
    for (const m of extractModernNames(a, '')) {
      const i = a.indexOf(m);
      if (i > 0) { a = a.slice(0, i); break; }
    }
    // 去掉残余的方位/描述尾词
    a = a.replace(/(内|里|旁|附近|对面|东侧|西侧|南侧|北侧)$/, '').trim();
    return a;
  }

  /**
   * 组合出「省市级 + 区县级 + 门牌」的检索地址。
   * 站点的 admin 与 address 拼起来正好就是详情页上显示的那一行，例如
   *   admin ["上海市 静安区"] + address "陕西南路30号"
   *   → "上海市 静安区 陕西南路30号"
   * 地址是**最稳定**的标识：不随文保单位改名而变化。
   *
   * @param {string[]|string} admin
   * @param {string} address
   * @returns {string}
   */
  function addressQuery(admin, address) {
    const parts = [];
    const ad = Array.isArray(admin) ? admin : (admin ? [admin] : []);
    for (const seg of ad) {
      const s = String(seg || '').trim();
      if (s && !parts.includes(s)) parts.push(s);
    }
    const a = cleanAddress(address);
    if (a && !parts.includes(a)) parts.push(a);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  window.HMP.naming = {
    extractCity,
    searchNames,
    memberSearchNames,
    extractModernNames,
    cleanAddress,
    addressQuery,
    // 便于测试
    _internals: { CITY_RE, PROV_RE, TYPE_TAIL, RE_MODERN_VERB, RE_MODERN_SUFFIX, RE_ALIAS }
  };
})();