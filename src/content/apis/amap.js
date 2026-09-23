// apis/amap.js
// 高德地图 Web API v5 封装
//  - 关键字搜索：https://restapi.amap.com/v5/place/text
//  - 周边搜索：  https://restapi.amap.com/v5/place/around   ← 解决"文保名≠现用名"
//
// 文档：https://developer.amap.com/api/webservice/guide/api-advanced/newpoisearch
//
// 坐标：高德一律使用 GCJ02。周边搜索的 location 必须由 geo.steleToGcj02() 生成
//       （站点坐标有仿射畸变，必须先校正，见 geo.js）。

(function () {
  'use strict';
  window.HMP = window.HMP || {};
  window.HMP.apis = window.HMP.apis || {};

  function parseLocation(str) {
    if (typeof str !== 'string') return { lon: null, lat: null };
    const parts = str.split(',');
    if (parts.length !== 2) return { lon: null, lat: null };
    const lon = parseFloat(parts[0]);
    const lat = parseFloat(parts[1]);
    if (Number.isNaN(lon) || Number.isNaN(lat)) return { lon: null, lat: null };
    return { lon, lat };
  }

  /**
   * 在多个候选对象里按多个候选键名取第一个非空值。
   *
   * 高德不同版本/端返回的营业信息字段拼写并不一致：
   *   - v5 Web API（show_fields=business）→ business.opentime_today / opentime_week（snake_case）
   *   - iOS SDK 文档                        → opentimeToday / opentimeWeek（camelCase）
   *   - v3 Web API（extensions=all）        → biz_ext.opentime 等
   * 所以这里全部容错，命中哪个用哪个。
   */
  function pickFrom(sources, keys) {
    for (const src of sources) {
      if (!src) continue;
      for (const k of keys) {
        const v = src[k];
        if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
      }
    }
    return null;
  }

  const OPEN_TODAY_KEYS = ['opentime_today', 'opentimeToday', 'open_time_today'];
  const OPEN_WEEK_KEYS = ['opentime_week', 'opentimeWeek', 'open_time_week'];
  // 只有一个笼统"营业时间"字段时的兜底
  const OPEN_ANY_KEYS = ['opentime', 'open_time', 'opening_hours', 'business_time', 'shop_hours', 'openTime'];
  const TEL_KEYS = ['tel', 'telephone', 'phone'];
  const RATING_KEYS = ['rating', 'overall_rating'];
  const COST_KEYS = ['cost', 'price', 'ticket', 'ticket_price', 'ticketPrice'];

  // 只打印一次真实字段构成，便于排查"字段名猜错"
  let shapeLogged = false;

  // 状态字段诊断（与百度侧对称）：把所有**值**看起来像状态的字段打出来，
  // 确认"暂停开放 / 暂停营业"到底被哪家放在哪个字段里。
  // 只打第一条命中的，避免刷屏。
  let statusFieldLogged = false;
  const STATUS_WORD_RE = /暂停|停业|歇业|关闭|闭馆|闭园|停办|维修|整修|装修|施工|改造|修缮|拆除/;

  /** 把高德原始 POI 映射成插件内部结构 */
  function mapPoi(p) {
    const loc = parseLocation(p.location);
    const b = p.business || {};
    const x = p.biz_ext || {};        // v3 extensions=all
    const sources = [b, x, p];

    const openToday = pickFrom(sources, OPEN_TODAY_KEYS);
    let openWeek = pickFrom(sources, OPEN_WEEK_KEYS);
    if (!openToday && !openWeek) openWeek = pickFrom(sources, OPEN_ANY_KEYS);

    const bKeys = Object.keys(b);
    const xKeys = Object.keys(x);
    if (!shapeLogged && (bKeys.length || xKeys.length)) {
      shapeLogged = true;
      console.log('[HMP] 高德营业信息字段构成 → business={' + bKeys.join(',') +
        '}  biz_ext={' + xKeys.join(',') + '}');
    }

    if (!statusFieldLogged) {
      const hits = [];
      for (const src of sources) {
        if (!src) continue;
        for (const k of Object.keys(src)) {
          const v = src[k];
          if (v == null || typeof v === 'object') continue;
          const sv = String(v);
          if (STATUS_WORD_RE.test(sv)) hits.push(k + '=' + sv.slice(0, 40));
        }
      }
      if (hits.length) {
        statusFieldLogged = true;
        console.log('[HMP] 高德状态类字段：' + hits.join(' | '));
      }
    }

    return {
      id: p.id,
      name: p.name || '',
      address: p.address || '',
      type: p.type || p.typecode || '',
      // 高德会标出 POI 的父子关系：parent 非空说明这是某个 POI 的**子单元**
      // （如"上海孙中山故居纪念馆-草坪与建筑"）。排序时据此降权，
      // 避免细碎子单元盖过本体（见 card.js 的 searchNearby）。
      parent: p.parent || '',
      child: p.child || '',
      lon: loc.lon,
      lat: loc.lat,
      tel: pickFrom(sources, TEL_KEYS),
      // 高德的 business.tag：可能是品类，也可能是"暂停营业"这类状态。
      // 单独保留给 closureHint 用（百度对应的是 detail_info.tag）。
      tag: pickFrom(sources, ['tag']),
      opentimeToday: openToday,
      opentimeWeek: openWeek,
      rating: pickFrom(sources, RATING_KEYS),
      cost: pickFrom(sources, COST_KEYS),
      raw: p
    };
  }

  // 高德 info 码 → 可操作的中文提示
  const AMAP_HINTS = {
    INVALID_USER_KEY: 'Key 无效，或不是「Web服务API」类型的 Key',
    INVALID_USER_SCODE: 'Key 未通过校验',
    INVALID_USER_SIGNATURE: '该 Key 开启了「数字签名」，插件不支持；'
      + '请在控制台关闭数字签名，或重新创建未开启签名的 Key',
    USER_KEY_PLATFORM_ERROR: 'Key 的服务平台类型不对（需选「Web服务API」）',
    SERVICE_NOT_AVAILABLE: '该 Key 未开通此服务',
    DAILY_QUERY_OVER_LIMIT: '今日调用量已用完',
    CUQPS_HAS_EXCEEDED_THE_LIMIT: '并发超限，请稍后再试',
    INVALID_PARAMS: '请求参数非法（多半是插件的问题，请把这条反馈给作者）',
  };

  async function callAmap(url) {
    // 经 service worker 转发（MV3 下内容脚本不能跨域直连，详见 http.js）
    const text = await window.HMP.http.fetchText(url);
    const j = JSON.parse(text);
    if (j.status !== '1') {
      const hint = AMAP_HINTS[j.info];
      throw new Error(`高德 status=${j.status} info=${j.info || ''}` + (hint ? ' —— ' + hint : ''));
    }
    return (j.pois || []).map(mapPoi);
  }

  window.HMP.apis.amap = {
    name: 'amap',
    label: '高德地图',

    /**
     * 关键字搜索：以「市级行政区 + 名称」检索。
     * ⚠️ 不传 location/radius——那是周边搜索的语义，且站点原始坐标偏 340km。
     *
     * @param {object} args
     * @param {string} args.key
     * @param {string} args.name   检索名（可已是名称变体之一）
     * @param {string} [args.region] 市级行政区
     * @returns {Promise<Array>}
     */
    async search({ key, name, region = '' }) {
      if (!key) throw new Error('amap key missing');
      if (!name) return [];
      const keyword = region ? `${region} ${name}` : name;
      const params = new URLSearchParams({ key, keywords: keyword });
      if (region) params.set('region', region);
      params.set('page_size', '10');
      params.set('show_fields', 'business');
      return callAmap(`https://restapi.amap.com/v5/place/text?${params.toString()}`);
    },

    /**
     * 周边搜索：给定**校正后**的 GCJ02 坐标，找回该位置上的 POI。
     * 这是解决「文保名称 ≠ 现用名」的关键——如
     * 真觉寺金刚宝座 → 现为北京石刻艺术博物馆（名称完全无关，位置相同）。
     *
     * @param {object} args
     * @param {string} args.key
     * @param {[number,number]} args.location [lon, lat]，必须是 GCJ02
     * @param {number} [args.radius=1000] 半径（米）
     * @returns {Promise<Array>}
     */
    async searchAround({ key, location, radius = 1000 }) {
      if (!key) throw new Error('amap key missing');
      if (!location || !Number.isFinite(location[0]) || !Number.isFinite(location[1])) return [];
      const params = new URLSearchParams({
        key,
        location: `${location[0]},${location[1]}`,
        radius: String(radius),
        page_size: '20',
        show_fields: 'business'
      });
      return callAmap(`https://restapi.amap.com/v5/place/around?${params.toString()}`);
    },

    /** 提取"开放信息"标准化结果 */
    extract(poi) {
      return {
        provider: 'amap',
        providerLabel: '高德地图',
        name: poi.name,
        opentimeToday: poi.opentimeToday || null,
        opentimeWeek: poi.opentimeWeek || null,
        tel: poi.tel || null,
        rating: poi.rating || null,
        cost: poi.cost || null,
        status: poi.opentimeToday ? 'open' : 'unknown',
        address: poi.address || null,
        type: poi.type || null,
        // 状态标签必须带出来：mapPoi 取到了 tag，但 extract 是手写字面量，
        // 之前漏了它 —— closureHint(info) 的 info.tag 因此永远是 undefined。
        tag: poi.tag || null,
        description: poi.description || null,
        externalUrl: poi.id
          ? `https://uri.amap.com/marker?position=${poi.lon},${poi.lat}&name=${encodeURIComponent(poi.name)}&src=hmp&coordinate=gaode`
          : null
      };
    },

    searchUrl(name) {
      return `https://uri.amap.com/search?keyword=${encodeURIComponent(name)}&src=hmp`;
    }
  };
})();