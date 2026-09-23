// tests/fields_tests.js
// 营业信息字段容错测试。
//
// 现象：卡片能显示"地址/评分"，但没有"开放时间"。
// 原因：高德各版本/各端返回营业信息的键名不一致——
//   v5 Web API（show_fields=business）→ business.opentime_today / opentime_week（snake_case）
//   iOS SDK 文档                        → opentimeToday / opentimeWeek（camelCase）
//   v3 Web API（extensions=all）        → biz_ext.*
// 百度侧另有坑：telephone 在 POI 顶层，不在 detail_info 里。
//
// 运行: node tests/fields_tests.js
'use strict';
const fs = require('fs');
const path = require('path');

global.window = global;

const SRC = path.join(__dirname, '..', 'src', 'content');
let amapBody = { status: '1', pois: [] };
let baiduBody = { status: 0, results: [] };
global.fetch = async (url) => {
  const u = String(url);
  const isAmap = u.includes('restapi.amap.com');
  return { ok: true, status: 200, json: async () => (isAmap ? amapBody : baiduBody) };
};

['decoder', 'naming', 'geo', 'cache', 'http'].forEach(f =>
  eval(fs.readFileSync(path.join(SRC, f + '.js'), 'utf8')));
eval(fs.readFileSync(path.join(SRC, 'apis', 'amap.js'), 'utf8'));
eval(fs.readFileSync(path.join(SRC, 'apis', 'baidu.js'), 'utf8'));

const AMAP = window.HMP.apis.amap;
const BAIDU = window.HMP.apis.baidu;

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (detail ? '  → ' + detail : '')); }
}

async function amapMap(poi) {
  amapBody = { status: '1', pois: [poi] };
  const r = await AMAP.search({ key: 'K', name: 'x' });
  return r[0];
}
async function baiduMap(poi) {
  baiduBody = { status: 0, results: [poi] };
  const r = await BAIDU.search({ ak: 'A', name: 'x', region: '上海市' });
  return r[0];
}

(async () => {
  // ============ 高德：多种字段拼写 ============
  console.log('\n=== 高德：business 字段拼写容错 ===');

  // ① v5 Web API 实际返回（snake_case）—— 这是最可能的真实形态
  {
    const m = await amapMap({
      id: 'B1', name: '故宫博物院', address: '景山前街4号', type: '科教文化服务;博物馆',
      location: '116.397,39.918',
      business: {
        opentime_today: '08:30-17:00',
        opentime_week: '周二至周日 08:30-17:00',
        tel: '010-85007421',
        rating: '4.8',
        cost: '60',
      },
    });
    check('① snake_case opentime_today 能取到', m.opentimeToday === '08:30-17:00', String(m.opentimeToday));
    check('① snake_case opentime_week 能取到', m.opentimeWeek === '周二至周日 08:30-17:00', String(m.opentimeWeek));
    check('① tel / rating / cost 正常', m.tel === '010-85007421' && m.rating === '4.8' && m.cost === '60',
      `${m.tel} / ${m.rating} / ${m.cost}`);
  }

  // ② camelCase（iOS SDK 文档风格）
  {
    const m = await amapMap({
      id: 'B2', name: 'X', location: '116.4,39.9',
      business: { opentimeToday: '09:00-16:30', opentimeWeek: '周一至周日 09:00-16:30' },
    });
    check('② camelCase opentimeToday 能取到', m.opentimeToday === '09:00-16:30', String(m.opentimeToday));
    check('② camelCase opentimeWeek 能取到', m.opentimeWeek === '周一至周日 09:00-16:30', String(m.opentimeWeek));
  }

  // ③ v3 extensions=all 的 biz_ext（只有一个笼统 opentime）
  {
    const m = await amapMap({
      id: 'B3', name: 'X', location: '116.4,39.9',
      biz_ext: { opentime: '08:00-18:00', cost: '120', rating: '4.5' },
    });
    check('③ biz_ext.opentime 落到「营业时间」', m.opentimeWeek === '08:00-18:00', String(m.opentimeWeek));
    check('③ biz_ext.cost / rating 能取到', m.cost === '120' && m.rating === '4.5', `${m.cost}/${m.rating}`);
  }

  // ④ 字段直接挂在 POI 顶层
  {
    const m = await amapMap({
      id: 'B4', name: 'X', location: '116.4,39.9',
      opentime: '07:30-19:00', tel: '010-1234', cost: '30',
    });
    check('④ 顶层 opentime 能取到', m.opentimeWeek === '07:30-19:00', String(m.opentimeWeek));
    check('④ 顶层 tel / cost 能取到', m.tel === '010-1234' && m.cost === '30', `${m.tel}/${m.cost}`);
  }

  // ⑤ 完全没有营业信息 → 全是 null，且不抛错
  {
    const m = await amapMap({ id: 'B5', name: 'X', location: '116.4,39.9', business: { rating: '4.0' } });
    check('⑤ 无营业信息时为 null（不报错）',
      m.opentimeToday === null && m.opentimeWeek === null && m.cost === null,
      JSON.stringify({ t: m.opentimeToday, w: m.opentimeWeek, c: m.cost }));
    check('⑤ 仍能取到已有的 rating', m.rating === '4.0', String(m.rating));
  }

  // ⑥ 空字符串不应被当成有效值
  {
    const m = await amapMap({
      id: 'B6', name: 'X', location: '116.4,39.9',
      business: { opentime_today: '   ', cost: '' },
    });
    check('⑥ 空白值被忽略', m.opentimeToday === null && m.cost === null,
      JSON.stringify({ t: m.opentimeToday, c: m.cost }));
  }

  // ============ 百度：telephone 在顶层 ============
  console.log('\n=== 百度：字段位置与容错 ===');
  {
    const m = await baiduMap({
      uid: 'c1', name: '故宫博物院', address: '景山前街4号',
      telephone: '010-85007421',        // ← 顶层，不在 detail_info
      location: { lng: 116.397, lat: 39.918 },
      detail_info: { shop_hours: '08:30-17:00', price: '60', overall_rating: '4.8', type: '博物馆' },
    });
    check('telephone 从 POI 顶层取到', m.tel === '010-85007421', String(m.tel));
    check('detail_info.shop_hours 取到', m.shopHours === '08:30-17:00', String(m.shopHours));
    check('detail_info.price 取到', m.price === '60', String(m.price));
    check('detail_info.overall_rating 取到', m.rating === '4.8', String(m.rating));
  }
  {
    const m = await baiduMap({
      uid: 'c2', name: 'X', location: { lng: 116.4, lat: 39.9 },
      detail_info: { tel: '010-9999', opening_hours: '09:00-17:00', cost: '40' },
    });
    check('detail_info.tel 兜底可用', m.tel === '010-9999', String(m.tel));
    check('detail_info.opening_hours 兜底可用', m.shopHours === '09:00-17:00', String(m.shopHours));
    check('detail_info.cost 兜底可用', m.price === '40', String(m.price));
  }

  // ============ extract() 输出给卡片的结构 ============
  console.log('\n=== extract() 输出（卡片消费的字段）===');
  {
    const mapped = await amapMap({
      id: 'B7', name: '故宫博物院', address: '景山前街4号', location: '116.397,39.918',
      business: { opentime_today: '08:30-17:00', opentime_week: '周二至周日', tel: '010-1', rating: '4.8', cost: '60' },
    });
    const info = AMAP.extract(mapped);
    console.log('  ' + JSON.stringify({
      name: info.name, opentimeToday: info.opentimeToday, opentimeWeek: info.opentimeWeek,
      cost: info.cost, tel: info.tel, rating: info.rating,
    }));
    check('extract 保留 opentimeToday', info.opentimeToday === '08:30-17:00');
    check('extract 保留 cost（票价/费用）', info.cost === '60');
    check('extract 保留 tel', info.tel === '010-1');
  }
  {
    const mapped = await baiduMap({
      uid: 'c3', name: 'X', telephone: '010-2', location: { lng: 116.4, lat: 39.9 },
      detail_info: { shop_hours: '09:00-16:00', price: '50' },
    });
    const info = BAIDU.extract(mapped);
    check('百度 extract：opentimeWeek ← shop_hours', info.opentimeWeek === '09:00-16:00', String(info.opentimeWeek));
    check('百度 extract：cost ← price', info.cost === '50', String(info.cost));
    check('百度 extract：tel 正确', info.tel === '010-2', String(info.tel));
  }

  // ============ 错误码 → 可操作提示 ============
  console.log('\n=== 报错必须给出可操作的提示 ===');

  async function expectThrow(fn) {
    try { await fn(); return null; } catch (e) { return e.message; }
  }

  // 百度 240：本插件用户实际踩到过
  baiduBody = { status: 240, message: 'APP 服务被禁用' };
  {
    const msg = await expectThrow(() => BAIDU.search({ ak: 'A', name: '故宫', region: '北京市' }));
    console.log('  百度 240 → ' + msg);
    check('百度 240 抛出错误', !!msg);
    check('提示里点明"未开通地点检索"', !!msg && msg.includes('地点检索'));
    check('提示里给出"服务端"类型的解法', !!msg && msg.includes('服务端'));
    check('提示里给出 IP 白名单写法', !!msg && msg.includes('0.0.0.0/0'));
  }

  baiduBody = { status: 5, message: 'AK Failure' };
  {
    const msg = await expectThrow(() => BAIDU.search({ ak: 'A', name: 'x', region: '上海市' }));
    check('百度 5 → 提示 AK 非法', !!msg && msg.includes('AK'));
  }

  // 高德：数字签名 / Key 类型
  amapBody = { status: '0', info: 'INVALID_USER_SIGNATURE' };
  {
    const msg = await expectThrow(() => AMAP.search({ key: 'K', name: 'x' }));
    console.log('  高德 INVALID_USER_SIGNATURE → ' + msg);
    check('高德 数字签名 提示如何解决', !!msg && msg.includes('数字签名'));
  }

  amapBody = { status: '0', info: 'INVALID_USER_KEY' };
  {
    const msg = await expectThrow(() => AMAP.search({ key: 'K', name: 'x' }));
    check('高德 无效 Key 提示类型要求', !!msg && msg.includes('Web服务API'));
  }

  // ============ popup 保存语义 ============
  console.log('\n=== popup：填了 Key 不等于保存了 ===');
  {
    // 复现用户场景：下拉框选了百度、输入框填了百度 AK，
    // 但没点「保存」→ chrome.storage 里仍然是旧值 → 插件只有高德可用。
    // 修复后「测试 Key」会先自动保存，并显示"有未保存的修改"提示条。
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup', 'popup.html'), 'utf8');
    const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup', 'popup.js'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup', 'popup.css'), 'utf8');

    check('popup 有"未保存"提示条元素', html.includes('id="dirtyHint"'));
    check('提示条有样式', css.includes('.dirty-hint'));
    check('提示条文案点明"点保存才生效"',
      /未保存的修改/.test(html) && /才会生效/.test(html));

    check('popup 记录了已保存快照', /savedSnapshot/.test(js));
    check('popup 能判断是否脏', /function isDirty/.test(js));
    check('测试 Key 之前会先自动保存',
      /await save\(\{ silent: true \}\)/.test(js), '未找到自动保存');
    check('自动保存后告知用户',
      /已先保存当前填写的 Key/.test(js));
    check('保存会刷新脏状态', /savedSnapshot = payload/.test(js));

    // 关键：插件侧读的是 storage，因此必须靠保存才生效——这条留作说明性断言
    const pickSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'card.js'), 'utf8');
    check('插件侧依据 storage 配置选择数据源',
      /defaultProvider === 'baidu' \? 'baidu' : 'amap'/.test(pickSrc));
  }

  // ============ 状态标签 → "可能不开放"提示 ============
  console.log('\n=== 状态标签（暂停营业等）===');
  {
    // 百度把这类信号放在 detail_info.tag 里。此前 closureHint 只查 name 与 status，
    // 于是百度的状态标签完全没有提示 —— 用户反馈的正是这一点。

    const b1 = await (async () => {
      baiduBody = { status: 0, results: [{
        uid: 's1', name: '某纪念馆', address: '某路1号',
        location: { lng: 121.47, lat: 31.23 },
        detail_info: { type: '科教文化服务;博物馆', tag: '暂停营业' },
      }] };
      const r = await BAIDU.search({ ak: 'A', name: '某纪念馆', region: '上海市' });
      return r[0];
    })();
    check('百度 tag 被单独取出', b1 && b1.tag === '暂停营业', b1 ? String(b1.tag) : 'null');
    check('状态类 tag 不冒充类型',
      b1 && b1.type === '科教文化服务;博物馆', b1 ? String(b1.type) : 'null');

    // 品类 tag 仍可兜底为类型（百度不少 POI 只在 tag 里写品类）
    const b2 = await (async () => {
      baiduBody = { status: 0, results: [{
        uid: 's2', name: '某博物馆', location: { lng: 121.47, lat: 31.23 },
        detail_info: { tag: '博物馆' },
      }] };
      const r = await BAIDU.search({ ak: 'A', name: '某博物馆', region: '上海市' });
      return r[0];
    })();
    check('品类 tag 仍可兜底为类型', b2 && b2.type === '博物馆', b2 ? String(b2.type) : 'null');

    // 高德侧也要取到 tag
    const a1 = await (async () => {
      amapBody = { status: '1', pois: [{
        id: 'a1', name: '某纪念馆', type: '科教文化服务;博物馆',
        location: '121.47,31.23', business: { tag: '装修中' },
      }] };
      const r = await AMAP.search({ key: 'K', name: '某纪念馆', region: '上海市' });
      return r[0];
    })();
    check('高德 tag 也被取出', a1 && a1.tag === '装修中', a1 ? String(a1.tag) : 'null');
  }

  console.log('\n结果: 通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
