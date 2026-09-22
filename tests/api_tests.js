// tests/api_tests.js
// 校验高德 / 百度请求的「URL 契约」，重点回归本次修复的三个 bug：
//   Bug A: 不得再携带 location / radius（STELE 坐标系统性偏移 ~340km）
//   Bug B: region 必须是市级单一名称（不是 "北京市 东城区" 这种多级串）
//   Bug C: keywords/query 必须是「市级 + 名称」拼接，且支持名称变体
//
// 运行: node tests/api_tests.js
'use strict';
const fs = require('fs');
const path = require('path');

global.window = global;

const SRC = path.join(__dirname, '..', 'src', 'content');
eval(fs.readFileSync(path.join(SRC, 'decoder.js'), 'utf8'));
eval(fs.readFileSync(path.join(SRC, 'naming.js'), 'utf8'));

// ---- 捕获 fetch 请求 ----
const captured = [];
let cannedResponse = { status: '1', pois: [] };
global.fetch = async (url) => {
  captured.push(String(url));
  return {
    ok: true,
    status: 200,
    json: async () => cannedResponse,
  };
};

eval(fs.readFileSync(path.join(SRC, 'http.js'), 'utf8'));
eval(fs.readFileSync(path.join(SRC, 'apis', 'amap.js'), 'utf8'));
eval(fs.readFileSync(path.join(SRC, 'apis', 'baidu.js'), 'utf8'));

const HMP = window.HMP;
let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (detail ? '  → ' + detail : '')); }
}

function lastParams() {
  const u = new URL(captured[captured.length - 1]);
  return { url: u, q: u.searchParams };
}

(async () => {
  // ================= 高德 =================
  console.log('\n=== 高德 v5/place/text ===');
  captured.length = 0;
  cannedResponse = { status: '1', pois: [] };
  await HMP.apis.amap.search({ key: 'TESTKEY', name: '莫高窟', region: '敦煌市' });
  let { url, q } = lastParams();

  check('端点正确', url.origin + url.pathname === 'https://restapi.amap.com/v5/place/text', url.href);
  check('keywords = "敦煌市 莫高窟"', q.get('keywords') === '敦煌市 莫高窟', JSON.stringify(q.get('keywords')));
  check('region = "敦煌市"', q.get('region') === '敦煌市', JSON.stringify(q.get('region')));
  check('🐛BugA 不含 location', !q.has('location'));
  check('🐛BugA 不含 radius', !q.has('radius'));
  check('show_fields=business', q.get('show_fields') === 'business');
  check('携带 key', q.get('key') === 'TESTKEY');

  // 高德：region 只是可选过滤器，无 region 时 keywords 退化为纯名称
  captured.length = 0;
  await HMP.apis.amap.search({ key: 'TESTKEY', name: '故宫', region: '' });
  ({ q } = lastParams());
  check('高德 region 为空时 keywords=名称', q.get('keywords') === '故宫', JSON.stringify(q.get('keywords')));
  check('高德 region 为空时不发 region', !q.has('region'));

  // 百度：region / location / bounds 三者必居其一，全空即 status=2 Parameter Invalid。
  // 与其白跑一次拿报错，不如就地拒绝（调用方漏传 region 是很容易犯的错，
  // 地址检索曾因此整条失败）。
  let refused = null;
  try { await HMP.apis.baidu.search({ ak: 'TESTAK', name: '故宫', region: '' }); }
  catch (e) { refused = e.message; }
  check('百度缺 region 时就地拒绝（不发无效请求）',
    !!refused && /region/.test(refused), String(refused));

  // 地址检索必须带城市——这条断言守住那个 bug 不再回来
  {
    const saved = global.fetch;
    global.fetch = async (u) => {
      captured.push(String(u));
      return { ok: true, status: 200, json: async () => ({ status: 0, results: [] }) };
    };
    // 模拟 searchByAddress 的调用形态：addrQuery 是完整地址，region 取市级
    await HMP.apis.baidu.search({ ak: 'TESTAK', name: '上海市 黄浦区 某路1号', region: '上海市' });
    global.fetch = saved;
    const url = new URL(captured[captured.length - 1]);
    check('百度地址检索带上了 region（否则 status=2）',
      url.searchParams.get('region') === '上海市', String(url.searchParams.get('region')));
    check('百度地址检索的 query 是完整地址本身',
      url.searchParams.get('query') === '上海市 黄浦区 某路1号',
      String(url.searchParams.get('query')));
  }

  // ================= 百度 =================
  console.log('\n=== 百度 place/v2/search ===');
  captured.length = 0;
  cannedResponse = { status: 0, results: [] };
  await HMP.apis.baidu.search({ ak: 'TESTAK', name: '明孝陵', region: '南京市' });
  ({ url, q } = lastParams());

  check('端点正确', url.origin + url.pathname === 'https://api.map.baidu.com/place/v2/search', url.href);
  // 按百度官方用法：query 只放关键字，城市走 region 参数。
  // 旧实现把城市拼进 query 又同时传 region（"南京市 明孝陵" + region=南京市），
  // 城市重复会让较长的文保名匹配不到——短名容错高，所以"测试 Key"看不出问题。
  check('query 只放关键字（不带城市）', q.get('query') === '明孝陵', JSON.stringify(q.get('query')));
  check('城市由 region 承载', q.get('region') === '南京市', JSON.stringify(q.get('region')));
  check('城市不在 query 里重复', !String(q.get('query')).includes('南京市'), JSON.stringify(q.get('query')));
  check('region = "南京市"', q.get('region') === '南京市', JSON.stringify(q.get('region')));
  check('🐛BugA 不含 location', !q.has('location'));
  check('🐛BugA 不含 radius', !q.has('radius'));
  check('scope=2（返回详情）', q.get('scope') === '2');
  // 刻意不传 ret_coordtype：让百度返回原生 BD09，与 poi.bd09 参考点同系。
  // 若传了却被忽略，返回仍是 BD09，与 GCJ02 参考点混算会整体偏 ~890 m。
  check('不传 ret_coordtype（保持原生 BD09）', !q.has('ret_coordtype'));
  check('携带 ak', q.get('ak') === 'TESTAK');

  // ================= 周边搜索（解决改名的关键）=================
  console.log('\n=== 周边搜索 searchAround ===');

  // 高德：location 必须是 GCJ02，且用 /v5/place/around 端点
  captured.length = 0;
  cannedResponse = { status: '1', pois: [] };
  await HMP.apis.amap.searchAround({ key: 'TESTKEY', location: [116.32903, 39.94470], radius: 1000 });
  ({ url, q } = lastParams());
  check('高德端点 = /v5/place/around',
    url.origin + url.pathname === 'https://restapi.amap.com/v5/place/around', url.href);
  // 注意：JS 数值会去掉尾随 0（39.94470 → 39.9447），按数值比较
  const amapLoc = (q.get('location') || '').split(',').map(Number);
  check('高德 location 为 lon,lat 顺序且数值正确',
    amapLoc.length === 2 && Math.abs(amapLoc[0] - 116.32903) < 1e-9 && Math.abs(amapLoc[1] - 39.9447) < 1e-9,
    q.get('location'));
  check('高德 radius = 1000', q.get('radius') === '1000');
  check('高德不带 keywords（纯位置检索）', !q.has('keywords'));
  check('高德 show_fields=business', q.get('show_fields') === 'business');

  // 百度：location 是 lat,lng；输入 BD09；输出 GCJ02
  captured.length = 0;
  cannedResponse = { status: 0, results: [] };
  await HMP.apis.baidu.searchAround({ ak: 'TESTAK', location: [116.33561, 39.95041], radius: 1000 });
  ({ url, q } = lastParams());
  check('百度端点 = /place/v2/search',
    url.origin + url.pathname === 'https://api.map.baidu.com/place/v2/search', url.href);
  check('百度 location = "39.95041,116.33561"（lat,lng）',
    q.get('location') === '39.95041,116.33561', q.get('location'));
  check('百度 coord_type=3（输入 BD09）', q.get('coord_type') === '3');
  check('百度不传 ret_coordtype（返回 BD09，与 poi.bd09 同系）', !q.has('ret_coordtype'));
  check('百度 radius = 1000', q.get('radius') === '1000');
  check('百度 query 为宽泛分类词（含 $ 并列）',
    (q.get('query') || '').includes('$') && (q.get('query') || '').includes('博物馆'),
    q.get('query'));

  // 无坐标时不应发请求
  captured.length = 0;
  const emptyRes = await HMP.apis.amap.searchAround({ key: 'K', location: null });
  check('无坐标时返回空且不发请求',
    Array.isArray(emptyRes) && emptyRes.length === 0 && captured.length === 0);

  // ================= naming 与真实 admin 组合 =================
  console.log('\n=== admin → 市级 → 请求参数（真实数据） ===');
  const FIX = path.join(__dirname, 'fixtures');
  const adminCases = [
    ['故宫', '北京市', '北京市 故宫'],
    ['明孝陵', '南京市', '南京市 明孝陵'],
    ['丽江古城', '丽江市', '丽江市 丽江古城'],
    ['莫高窟', '敦煌市', '敦煌市 莫高窟'],
  ];
  for (const [kw, expCity, expKeyword] of adminCases) {
    // 所有 fixture 统一放在 tests/fixtures/。
    // （莫高窟原先读的是 research/feature_mogao.json，而 research/ 里的站点文件
    //   是不进仓库的，别人 clone 下来会静默少跑 3 项检查——已修正。）
    const file = path.join(FIX, 'feature_' + kw + '.json');
    if (!fs.existsSync(file)) { console.log('  ⏭  缺少 fixture: ' + kw); continue; }
    const feat = HMP.decoder.normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
    const city = HMP.naming.extractCity(feat.admin);
    const variants = HMP.naming.searchNames(feat.name);
    captured.length = 0;
    cannedResponse = { status: '1', pois: [] };
    await HMP.apis.amap.search({ key: 'K', name: variants[0], region: city });
    const p = lastParams().q;
    check(kw + ' 市级=' + expCity, city === expCity, 'got ' + city);
    check(kw + ' keywords="' + expKeyword + '"', p.get('keywords') === expKeyword, 'got ' + p.get('keywords'));
    check(kw + ' region 单级', !/[\s、]/.test(p.get('region') || ''), 'got ' + p.get('region'));
  }

  // ============ 百度坐标解析的容错（曾导致"三路均未搜到候选"）============
  console.log('\n=== 百度坐标解析容错 ===');
  {
    // 旧实现写的是 typeof p.location.lng === 'number'，百度一旦返回字符串坐标，
    // lon/lat 就是 null —— 后果是连锁的：
    //   · 坐标路径 distance 变 NaN → 候选被全部跳过
    //   · 名称路径 dist 变 Infinity → passes() 只认 sim≥0.7 → 改名场景过不了
    // 高德侧一直用 parseFloat，所以这个不对称长期没暴露。
    const saved = global.fetch;
    global.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({
        status: 0, message: 'ok',
        results: [
          { uid: '1', name: '对象型', location: { lng: 121.47, lat: 31.23 }, detail_info: { type: '公园' } },
          { uid: '2', name: '字符串型', location: { lng: '121.48', lat: '31.24' }, detail_info: { type: '公园' } },
          { uid: '3', name: 'latlng字符串', location: '31.25,121.49', detail_info: { type: '公园' } },
          { uid: '4', name: '坐标在detail里', detail_info: { type: '公园', location: { lng: 121.50, lat: 31.26 } } },
        ],
      }),
    });

    const rs = await HMP.apis.baidu.search({ ak: 'K', name: 'x', region: '上海市' });
    global.fetch = saved;

    check('百度返回 4 条候选', rs.length === 4, String(rs.length));
    check('number 坐标能解析', rs[0] && rs[0].lon === 121.47 && rs[0].lat === 31.23,
      rs[0] ? rs[0].lon + ',' + rs[0].lat : 'null');
    check('string 坐标能解析（旧实现会得到 null）',
      rs[1] && Math.abs(rs[1].lon - 121.48) < 1e-6 && Math.abs(rs[1].lat - 31.24) < 1e-6,
      rs[1] ? rs[1].lon + ',' + rs[1].lat : 'null');
    check('"lat,lng" 字符串能解析且顺序正确',
      rs[2] && Math.abs(rs[2].lon - 121.49) < 1e-6 && Math.abs(rs[2].lat - 31.25) < 1e-6,
      rs[2] ? rs[2].lon + ',' + rs[2].lat : 'null');
    check('坐标在 detail_info 里也能取到',
      rs[3] && Math.abs(rs[3].lon - 121.50) < 1e-6 && Math.abs(rs[3].lat - 31.26) < 1e-6,
      rs[3] ? rs[3].lon + ',' + rs[3].lat : 'null');
    check('全部候选都有坐标（否则坐标路径会全废）',
      rs.every(x => x.lon != null && x.lat != null));
  }

  // ============ 跨域架构：地图接口必须经 service worker 转发 ============
  console.log('\n=== 跨域请求架构（MV3 内容脚本不能跨域直连）===');
  {
    // Chrome 从 MV3 起移除了内容脚本绕过 CORS 的能力，host_permissions 不再豁免。
    // 高德接口带 Access-Control-Allow-Origin 所以直连能通，百度接口不带 → 被浏览器拦下。
    // 曾因此让百度三路全空，而各路径把异常吞了，卡片只报"三路均未搜到候选"。
    // 这条测试守住"必须走 service worker 代理"这个架构决定。
    const httpSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'http.js'), 'utf8');
    const swSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'background', 'service-worker.js'), 'utf8');
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'manifest.json'), 'utf8'));

    check('http.js 提供统一入口', /window\.HMP\.http\s*=/.test(httpSrc));
    check('http.js 优先经 service worker 转发', /sendMessage/.test(httpSrc));
    check('http.js 在 worker 不可用时退回直连', /await fetch\(url/.test(httpSrc));
    check('service worker 注册了转发监听', /onMessage\.addListener/.test(swSrc));
    check('service worker 异步响应（返回 true 保持通道）', /return true;\s*\/\/ 异步响应/.test(swSrc));

    const js = manifest.content_scripts[0].js;
    const iHttp = js.indexOf('content/http.js');
    const iAmap = js.indexOf('content/apis/amap.js');
    const iBaidu = js.indexOf('content/apis/baidu.js');
    check('http.js 在 manifest 中已注册', iHttp >= 0, String(iHttp));
    check('http.js 排在 apis 之前（apis 依赖它）',
      iHttp >= 0 && iHttp < iAmap && iHttp < iBaidu,
      'http=' + iHttp + ' amap=' + iAmap + ' baidu=' + iBaidu);

    const amapSrc = fs.readFileSync(path.join(SRC, 'apis', 'amap.js'), 'utf8');
    const baiduSrc = fs.readFileSync(path.join(SRC, 'apis', 'baidu.js'), 'utf8');
    check('高德接口经代理请求', /HMP\.http\.fetchText/.test(amapSrc));
    check('百度接口经代理请求', /HMP\.http\.fetchText/.test(baiduSrc));
    check('两个接口都不再直接调用 fetch(',
      !/await fetch\(/.test(amapSrc) && !/await fetch\(/.test(baiduSrc));

    // 请求失败必须与"没搜到"区分开，否则卡片会误报
    const cardSrc = fs.readFileSync(path.join(SRC, 'card.js'), 'utf8');
    check('名称检索：全部变体失败时抛出（不吞成"未搜到"）',
      /errored === tried\) throw lastErr/.test(cardSrc));
    check('坐标检索：请求失败直接抛出',
      /请求失败 ≠ 没搜到/.test(cardSrc));
  }

  // ============ 降级跳转链接必须用官方 URI API ============
  console.log('\n=== 跳转链接（在百度/高德地图中搜索）===');
  {
    // 「在百度地图中搜索 →」曾手拼 map.baidu.com/search/<kw>/?querytype=s ——
    // 那是地图页面的**内部路由**，且缺少官方要求的 output=html 与 src，
    // 实测点开后不能正常展示搜索结果。
    // 正确做法是用官方 URI API：api.map.baidu.com/place/search
    const url = HMP.apis.baidu.searchUrl('上海孙中山故居纪念馆', '上海市');
    const u = new URL(url);

    check('指向官方 URI API（不是内部路由）',
      u.origin === 'https://api.map.baidu.com' && u.pathname === '/place/search', url);
    check('不再是 map.baidu.com/search/ 内部路由',
      !/map\.baidu\.com\/search\//.test(url), url);
    check('query = 纯名称（城市不堆进关键词）',
      u.searchParams.get('query') === '上海孙中山故居纪念馆', String(u.searchParams.get('query')));
    check('region = 城市名（百度据此解析城市代码）',
      u.searchParams.get('region') === '上海市', String(u.searchParams.get('region')));
    check('output=html（web 端必选，缺了不展现结果）',
      u.searchParams.get('output') === 'html', String(u.searchParams.get('output')));
    check('src 符合 webapp.companyName.appName 规则（必选）',
      /^webapp\.[^.]+\.[^.]+$/.test(String(u.searchParams.get('src'))),
      String(u.searchParams.get('src')));

    // ⚠️ 必须带**中心点**：实测不带 location 时百度跳转成
    //    map.baidu.com/?c=,&...（c 为空 = 无中心），地图停在默认位置
    //    —— 用户反馈"点进去坐标在海里"就是这个原因。
    //    带上 location 后跳转里出现真实墨卡托坐标，检索模式切到 nb（按坐标周边）。
    {
      const withCoord = new URL(
        HMP.apis.baidu.searchUrl('静安寺', '上海市', [121.4453, 31.2231]));
      check('坐标可用时带上 location（否则百度没有中心点）',
        withCoord.searchParams.get('location') === '31.2231,121.4453',
        String(withCoord.searchParams.get('location')));
      check('location 是 lat,lng 顺序（URI API 的规定）',
        withCoord.searchParams.get('location').split(',')[0] === '31.2231',
        String(withCoord.searchParams.get('location')));
      check('带上 radius 与 coord_type=bd09ll',
        withCoord.searchParams.get('radius') === '2000' &&
        withCoord.searchParams.get('coord_type') === 'bd09ll',
        withCoord.searchParams.get('radius') + ' / ' + withCoord.searchParams.get('coord_type'));
    }
    // 坐标不可用时不得传伪造坐标（宁可只按 region 检索）
    {
      const noCoord = new URL(HMP.apis.baidu.searchUrl('静安寺', '上海市', null));
      check('无坐标时不传 location', !noCoord.searchParams.has('location'), noCoord.href);
      const badCoord = new URL(HMP.apis.baidu.searchUrl('静安寺', '上海市', [NaN, 31.2]));
      check('坐标非法时不传 location', !badCoord.searchParams.has('location'), badCoord.href);
    }

    // 没有城市时也要能生成合法链接（region 是可选项之一）
    const noRegion = new URL(HMP.apis.baidu.searchUrl('故宫'));
    check('无城市时仍生成合法链接（含 output/src）',
      noRegion.searchParams.get('output') === 'html' &&
      !!noRegion.searchParams.get('src') &&
      noRegion.searchParams.get('query') === '故宫', noRegion.href);
    check('无城市时不带空 region 参数', !noRegion.searchParams.has('region'), noRegion.href);

    // 高德侧用官方 URI API
    const a = HMP.apis.amap.searchUrl('上海市 故宫');
    check('高德走官方 URI API（uri.amap.com/search）',
      /^https:\/\/uri\.amap\.com\/search\?/.test(a), a);
    check('高德关键词带上城市（避免同名点位跳错城市）',
      new URL(a).searchParams.get('keyword') === '上海市 故宫', a);
  }

  console.log('\n结果: 通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
