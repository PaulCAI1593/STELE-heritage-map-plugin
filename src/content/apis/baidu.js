// apis/baidu.js
// 百度地图 Place API v2 封装
//  - 行政区检索：https://api.map.baidu.com/place/v2/search?query=&region=
//  - 圆形区域检索：https://api.map.baidu.com/place/v2/search?query=&location=lat,lng&radius=
//                  ← 解决"文保名≠现用名"
//
// 文档：https://lbsyun.baidu.com/index.php?title=dev/webservice-placeapi
//
// 坐标：百度使用 BD09。周边搜索的 location 必须由 geo.steleToBd09() 生成
//       （站点坐标有仿射畸变，必须先校正，见 geo.js）。
//
// ⚠️ 刻意不传 ret_coordtype：让百度返回**原生 BD09**，然后用 poi.bd09 作参考点
//    算距离——两端同系，自洽。
//    若改传 ret_coordtype=gcj02ll 而百度未按预期转换，返回坐标仍是 BD09，
//    与 GCJ02 参考点混算会让所有距离整体偏 ~890 m；在 1 km 半径的周边搜索里
//    这足以把正确目标挤出半径，属于致命的静默错误。

(function () {
  'use strict';
  window.HMP = window.HMP || {};
  window.HMP.apis = window.HMP.apis || {};

  // 周边搜索时用的宽泛分类词（百度要求 query 必填，可用 $ 并列最多 10 个）
  const HERITAGE_QUERY = [
    '博物馆', '景区', '寺庙', '文物古迹', '遗址',
    '公园', '纪念馆', '古建筑', '文化旅游', '景点'
  ].join('$');

  /** 在多个候选对象里按多个候选键名取第一个非空值 */
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

  // 注意：百度把 telephone 放在 POI 顶层（不在 detail_info 里），这里两个位置都查。
  const TEL_KEYS = ['telephone', 'tel', 'phone'];
  const HOURS_KEYS = ['shop_hours', 'shopHours', 'opening_hours', 'opentime', 'open_time'];
  const RATING_KEYS = ['overall_rating', 'rating'];
  const PRICE_KEYS = ['price', 'cost', 'ticket', 'ticket_price'];

  let shapeLogged = false;

  /** 宽容取数：百度不同接口/版本可能给 number，也可能给 string */
  function toNum(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  /**
   * 解析 location。百度搜索结果里它通常是对象 {lng, lat}，
   * 但也可能以 "lat,lng" 字符串形式出现（注意顺序与高德的 "lng,lat" 相反）。
   */
  function readLocation(loc) {
    if (!loc) return { lon: null, lat: null };
    if (typeof loc === 'string') {
      const parts = loc.split(',');
      if (parts.length !== 2) return { lon: null, lat: null };
      return { lon: toNum(parts[1]), lat: toNum(parts[0]) };   // 百度字符串是 lat,lng
    }
    return { lon: toNum(loc.lng), lat: toNum(loc.lat) };
  }

  // 坐标解析失败时只提醒一次：这类问题会静默让坐标路径全废
  let coordWarned = false;

  function mapPoi(p) {
    const detail = p.detail_info || {};
    const sources = [detail, p];

    const dKeys = Object.keys(detail);
    if (!shapeLogged && dKeys.length) {
      shapeLogged = true;
      console.log('[HMP] 百度 detail_info 字段构成 = {' + dKeys.join(',') + '}');
    }

    // 坐标：优先顶层 location，缺失时退回 detail_info.location。
    //
    // ⚠️ 旧实现写的是 typeof p.location.lng === 'number'：
    //    百度若返回字符串坐标，lon/lat 就成 null —— 而后果是连锁的：
    //      · 坐标路径里 distance 变 NaN → 候选被全部跳过 → 该路全废
    //      · 名称路径里 dist 变 Infinity → passes() 只认 sim≥0.7 → 改名场景过不了
    //    两者叠加就是"三路均未搜到候选"。高德侧用的是 parseFloat，一直没事，
    //    所以这个不对称一直没有暴露。
    let loc = readLocation(p.location);
    if (loc.lon == null && detail.location) loc = readLocation(detail.location);
    if (!coordWarned && loc.lon == null && (p.location || detail.location)) {
      coordWarned = true;
      console.warn('[HMP] 百度坐标解析失败，原始 location = ' + JSON.stringify(p.location || detail.location));
    }

    return {
      uid: p.uid,
      id: p.uid,
      name: p.name || '',
      address: p.address || '',
      province: p.province || '',
      city: p.city || '',
      area: p.area || '',
      type: detail.type || detail.tag || '',
      lon: loc.lon,
      lat: loc.lat,
      tel: pickFrom(sources, TEL_KEYS),
      shopHours: pickFrom(sources, HOURS_KEYS),
      status: pickFrom(sources, ['status']),
      rating: pickFrom(sources, RATING_KEYS),
      price: pickFrom(sources, PRICE_KEYS),
      raw: p
    };
  }

  // 百度状态码 → 可操作的中文提示。
  // 官方文档：2xx 表示"无权限"，3xx 表示"配额错误"。
  const BAIDU_HINTS = {
    2: '请求参数非法。百度要求 place/v2/search 必须带 region（行政区划）、'
      + 'location+radius（圆形检索）或 bounds（矩形检索）之一；'
      + '三者全空即报此错（插件已在地址检索中补上 region）',
    3: '权限校验失败：API Key 可能已被停用，或类型与所调服务不符',
    4: '今日调用配额已用完',
    5: 'API Key 不存在或非法，请检查是否复制完整',
    200: '应用不存在：API Key 填错了（百度控制台里叫"访问应用（AK）"，别和安全码（SK）弄混）',
    240: '该 API Key 未开通「地点检索」服务。请到百度控制台改用【服务端】类型的 API Key，'
       + '在服务列表里勾选「地点检索 / Place API」，IP 白名单填 0.0.0.0/0',
    250: '服务被禁用',
    302: '调用配额超限',
  };

  // 只打印一次原始响应构成，便于发现"字段名对不上"——
  // 这类问题会静默产出空数组，表现为"三路均未搜到候选"，不报错、无从察觉。
  let rawShapeLogged = false;

  async function callBaidu(url) {
    // 经 service worker 转发（MV3 下内容脚本不能跨域直连，详见 http.js）
    const text = await window.HMP.http.fetchText(url);
    const j = JSON.parse(text);

    if (!rawShapeLogged) {
      rawShapeLogged = true;
      const keys = Object.keys(j || {});
      const arr = Array.isArray(j.results) ? j.results
        : (Array.isArray(j.pois) ? j.pois : null);
      console.log('[HMP] 百度响应结构 = {' + keys.join(',') + '}' +
        '  status=' + JSON.stringify(j.status) +
        '  results=' + (Array.isArray(j.results) ? j.results.length + '条' : typeof j.results) +
        (arr && arr[0] ? '  首条字段={' + Object.keys(arr[0]).join(',') + '}' : ''));
    }

    if (j.status !== 0) {
      const hint = BAIDU_HINTS[j.status];
      throw new Error(`百度 status=${j.status} ${j.message || ''}` + (hint ? ' —— ' + hint : ''));
    }
    const list = j.results || [];
    // 返回 0 条时把实际请求打出来（隐去 ak）：这类失败不报错，
    // 只能靠"发了什么、回来什么"来定位。
    if (!list.length) {
      const shown = url.replace(/ak=[^&]+/, 'ak=***');
      console.log('[HMP] 百度返回 0 条 · 请求：' + shown);
    }
    return list.map(mapPoi);
  }

  window.HMP.apis.baidu = {
    name: 'baidu',
    label: '百度地图',

    /**
     * 行政区划区域检索：以「市级行政区 + 名称」检索。
     * ⚠️ 不传 location/radius——百度一旦带上就变成圆形区域检索，
     *    而站点原始坐标偏 340km，会把搜索锁死在错误位置。
     *
     * @param {object} args
     * @param {string} args.ak
     * @param {string} args.name
     * @param {string} [args.region] 市级行政区
     * @returns {Promise<Array>}
     */
    async search({ ak, name, region = '' }) {
      if (!ak) throw new Error('baidu ak missing');
      if (!name) return [];
      // 百度把"三个定位参数全空"判为参数非法（status=2）。与其白跑一次拿报错，
      // 不如就地报清楚——调用方漏传 region 是很容易犯的错。
      if (!region) throw new Error('百度行政区划检索必须提供 region（见 BAIDU_HINTS[2]）');
      // ⚠️ query 里**不要**再拼城市：百度官方用法是 query=关键字、region=行政区。
      // 旧实现拼成 "上海市 上海孙中山故居纪念馆" 同时又传 region=上海市，
      // 城市重复会让较长的文保名匹配不到（短名容错高，所以测试按钮看不出问题）。
      const params = new URLSearchParams({
        query: name,
        output: 'json',
        ak,
        scope: '2',
        page_size: '10'
      });
      if (region) params.set('region', region);
      // 不传 ret_coordtype → 返回原生 BD09，与调用方使用的 poi.bd09 参考点同系
      return callBaidu(`https://api.map.baidu.com/place/v2/search?${params.toString()}`);
    },

    /**
     * 圆形区域检索：给定**校正后**的 BD09 坐标，用宽泛分类词找回该位置的 POI。
     * 用于名称完全对不上的场景（真觉寺金刚宝座 → 北京石刻艺术博物馆）。
     *
     * @param {object} args
     * @param {string} args.ak
     * @param {[number,number]} args.location [lon, lat]，必须是 BD09
     * @param {number} [args.radius=1000]
     * @returns {Promise<Array>}
     */
    async searchAround({ ak, location, radius = 1000, query }) {
      if (!ak) throw new Error('baidu ak missing');
      if (!location || !Number.isFinite(location[0]) || !Number.isFinite(location[1])) return [];
      const params = new URLSearchParams({
        // 默认仍用类目串；调用方可传具体 query。
        // ⚠️ HERITAGE_QUERY 是用 '$' 拼的多个类目，这个分隔符在百度侧
        //    是否被当作"或"并不确定（'$' 更像高德的习惯）。
        //    所以 card.js 会在类目检索无果时用**点位自己的名称**再试一次——
        //    单个词一定合法，不依赖任何分隔符语义。
        query: query || HERITAGE_QUERY,
        location: `${location[1]},${location[0]}`, // 百度是 lat,lng 顺序
        radius: String(radius),
        output: 'json',
        ak,
        scope: '2',
        coord_type: '3',            // 输入坐标为 BD09
        page_size: '20'
        // 不传 ret_coordtype → 输出原生 BD09，与 poi.bd09 参考点同系（见文件头注释）
      });
      return callBaidu(`https://api.map.baidu.com/place/v2/search?${params.toString()}`);
    },

    extract(poi) {
      return {
        provider: 'baidu',
        providerLabel: '百度地图',
        name: poi.name,
        opentimeToday: null,        // 百度没有"今日营业时间"
        opentimeWeek: poi.shopHours || null,
        tel: poi.tel || null,
        rating: poi.rating || null,
        cost: poi.price || null,
        status: poi.status || null,
        address: poi.address || null,
        type: poi.type || null,
        externalUrl: poi.uid
          ? `https://map.baidu.com/marker?uid=${encodeURIComponent(poi.uid)}&src=hmp`
          : null
      };
    },

    /**
     * 诊断用：跑一次真实请求，把**原始响应**和**映射结果**都返回。
     * 用法（在 STELE 详情页控制台）：
     *   await HMP.apis.baidu.probe({ ak: '你的AK', name: '故宫', region: '北京市' })
     * 若 raw.results 有数据而 mapped 为 0，就是字段映射对不上。
     */
    async probe({ ak, name, region = '', location, radius = 1000 }) {
      const out = { url: '', raw: null, rawKeys: [], rawCount: null, mapped: [], error: null };
      const params = new URLSearchParams({ output: 'json', ak, scope: '2', page_size: '10' });
      if (location) {
        params.set('query', HERITAGE_QUERY);
        params.set('location', `${location[1]},${location[0]}`);
        params.set('radius', String(radius));
        params.set('coord_type', '3');
      } else {
        const q = region ? `${region} ${name}` : name;
        params.set('query', q);
        if (region) params.set('region', region);
      }
      out.url = 'https://api.map.baidu.com/place/v2/search?' + params.toString();
      try {
        // probe 也走同一条通路，保证"诊断所得"与"实际查询"一致
        const j = JSON.parse(await window.HMP.http.fetchText(out.url));
        out.rawKeys = Object.keys(j || {});
        out.raw = j;
        out.rawCount = Array.isArray(j.results) ? j.results.length : null;
        if (j.status === 0) out.mapped = (j.results || []).map(mapPoi);
      } catch (e) {
        out.error = e.message;
      }
      return out;
    },

    /**
     * 在百度地图网页版中打开一次检索。
     *
     * 用**官方 URI API**（place/search），而不是手拼 map.baidu.com/search/<kw>/ ——
     * 后者是地图页面的内部路由，且缺少官方要求的 output=html 与 src，
     * 实测点开不能正常展示搜索结果。
     *
     * 官方文档：
     *   http://api.map.baidu.com/place/search?query=&region=&output=html&src=webapp.companyName.appName
     *   · output=html —— web 端**必选**，否则不展现地图产品结果
     *   · src —— 必选，规则 webapp.companyName.appName，不传不保证服务
     *   · region / location+radius / bounds 至少给一个（region 优先级最低但最省事）
     *
     * @param {string} name 关键词
     * @param {string} [region] 城市名（来自站点行政区）
     */
    searchUrl(name, region, bd09) {
      const params = new URLSearchParams({
        query: name || '',
        output: 'html',
        src: 'webapp.heritagemap.plugin'
      });
      if (region) params.set('region', region);

      // ⚠️ 必须给中心点，否则百度地图打开后没有落点。
      // 实测：不带 location 时跳转成 map.baidu.com/?c=,&...（c 为空 = 无中心），
      //       地图会停在默认位置（用户反馈"坐标在海里"）；
      //       带上 location 后变成 c=<墨卡托坐标>，且检索模式切到 nb（按坐标周边）。
      //
      // 用**校正后的 BD09**：站点坐标经仿射校正后误差约 150m，足以定住中心。
      // 坐标不可用时就不传（退回只按 region 检索，只是没有精确中心）。
      if (Array.isArray(bd09) && Number.isFinite(bd09[0]) && Number.isFinite(bd09[1])) {
        // URI API 的 location 是 lat,lng 顺序
        params.set('location', bd09[1] + ',' + bd09[0]);
        params.set('radius', '2000');
        params.set('coord_type', 'bd09ll');   // 明确告知这是百度经纬度
      }
      return 'https://api.map.baidu.com/place/search?' + params.toString();
    }
  };
})();