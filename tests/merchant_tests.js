// tests/merchant_tests.js
// #20 · 商户/商业点与机关事业点硬排除：玄妙观 → 玄妙观宰鸡店 不得选中
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const env = require('./_env');
const { check, finish } = env.makeChecker('merchant');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src/content');

function loadMatcher() {
  const sandbox = { window: { HMP: {} }, console: { log() {}, warn() {}, error() {} }, Math, Number, String, Array, Object, JSON };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(SRC, 'name-evidence.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(SRC, 'matcher.js'), 'utf8'), sandbox);
  return sandbox.window.HMP.matcher;
}
const M = loadMatcher();
const src = fs.readFileSync(path.join(SRC, 'matcher.js'), 'utf8');

function mk(name, lat, lon) { return { name, lat, lon, adname: '', rank: 2, type: '风景名胜' }; }
function pickName(target, cands) {
  const r = M.pick({ name: target, lat: 33, lon: 112 }, cands.map(c => mk(c.name, c.lat == null ? 33 : c.lat, c.lon == null ? 112 : c.lon)));
  return r ? r.poi.name : null;
}

check('导出 isMerchant / isInstitution / exclusionKindOf',
  typeof M.isMerchant === 'function' && typeof M.isInstitution === 'function' && typeof M.exclusionKindOf === 'function');

// 词表（总监点名的最小集合）
const NEED_MERCHANT = ['店', '饭店', '餐馆', '餐厅', '酒家', '酒楼', '宾馆', '酒店', '旅馆', '民宿', '超市', '便利店', '商店',
  '门市', '批发', '公司', '工厂', '厂', '作坊', '修理', '药房', '药店', '银行', '邮局', '加油站', '洗浴', '美发', '发廊',
  '网吧', '网咖', '市场', '摊位', '铺'];
for (const w of NEED_MERCHANT) {
  check('商户词表含「' + w + '」', src.indexOf("'" + w + "'") >= 0);
}
const NEED_INST = ['党群服务中心', '居委会', '村委会', '学校', '医院', '党校', '法院', '检察院'];
for (const w of NEED_INST) {
  check('机关事业词表含「' + w + '」', src.indexOf("'" + w + "'") >= 0);
}

// ①/② 商户判定
check('商户：玄妙观 → 玄妙观宰鸡店', M.isMerchant('玄妙观', '玄妙观宰鸡店') === true);
check('商户：玄妙观 → 玄妙观饭店', M.isMerchant('玄妙观', '玄妙观饭店') === true);
check('商户：玄妙观 → 玄妙观超市', M.isMerchant('玄妙观', '玄妙观超市') === true);
check('商户：玄妙观 → 玄妙观商贸有限公司', M.isMerchant('玄妙观', '玄妙观商贸有限公司') === true);
check('商户：exclusionKindOf 返回 merchant',
  JSON.stringify(M.exclusionKindOf('玄妙观', '玄妙观宰鸡店')) === JSON.stringify({ kind: 'merchant', word: '宰鸡店' }));

// 负例：身份词/同名/非前缀
check('非商户：故宫 → 故宫博物院', M.isMerchant('故宫', '故宫博物院') === false);
check('非商户：玄妙观 → 玄妙观', M.isMerchant('玄妙观', '玄妙观') === false);
check('非商户：玄妙观 → 南阳市玄妙观', M.isMerchant('玄妙观', '南阳市玄妙观') === false);

// 机关/事业点
check('机关：玄妙观 → 玄妙观村委会', M.isInstitution('玄妙观', '玄妙观村委会') === true);
check('机关：玄妙观 → 玄妙观小学', M.isInstitution('玄妙观', '玄妙观小学') === true);
check('机关：玄妙观 → 玄妙观社区医院', M.exclusionKindOf('玄妙观', '玄妙观社区医院') !== null);
check('机关：exclusionKindOf 返回 institution',
  (M.exclusionKindOf('玄妙观', '玄妙观村委会') || {}).kind === 'institution');

// ③/④/⑤ pick 行为
check('pick：只有商户候选 → 未匹配', pickName('玄妙观', [{ name: '玄妙观宰鸡店' }]) === null);
check('pick：商户 + 政府 + 遗址候选 → 不选商户',
  (() => { const n = pickName('玄妙观', [{ name: '玄妙观宰鸡店' }, { name: '宛城区人民政府' }, { name: '宛城遗址-望仙台' }]); return n === null || M.isMerchant('玄妙观', n) === false; })());
check('pick：本体在候选里 → 选本体',
  pickName('玄妙观', [{ name: '玄妙观宰鸡店' }, { name: '玄妙观' }]) === '玄妙观');
check('pick：故宫 → 故宫博物院 不回归', pickName('故宫', [{ name: '故宫博物院', lat: 39.91, lon: 116.4 }]) === '故宫博物院');
check('pick：村委会/学校候选不得胜',
  pickName('玄妙观', [{ name: '玄妙观村委会' }, { name: '玄妙观小学' }]) === null);

// 负向：正确结果不得被新规则误杀（总监 #20 收窄）
check('负向①：上海国际饭店 → 上海国际饭店（类型饭店）必须选中且不被排除',
  M.exclusionKindOf('上海国际饭店', '上海国际饭店') === null && pickName('上海国际饭店', [{ name: '上海国际饭店' }]) === '上海国际饭店');
check('负向②：马勒住宅 → 上海马勒别墅饭店 不得被直接丢弃（exclusionKind 为空，仍走正常评分）',
  M.exclusionKindOf('马勒住宅', '上海马勒别墅饭店') === null
  && M.scoreCandidate('马勒住宅', ['马勒住宅'], mk('上海马勒别墅饭店'), { refLat: 31.23, refLon: 121.47, source: 'name', rankFn: () => 2 }).excludeKind === '');
// 打分：商户点 simAdj ≤0.5、不吃 mult、带 excludeKind
const sc = M.scoreCandidate('玄妙观', ['玄妙观'], mk('玄妙观宰鸡店'), { refLat: 33, refLon: 112, source: 'name', rankFn: () => 2 });
check('打分：商户点 simAdj ≤ 0.5', sc.simAdj <= 0.5, 'simAdj=' + sc.simAdj);
check('打分：商户点不吃类型加成（mult=1）', sc.mult === 1, 'mult=' + sc.mult);
check('打分：商户点 excludeKind=merchant', sc.excludeKind === 'merchant');
check('打分：设施点仍走 facility 路径', M.scoreCandidate('南阳武侯祠', ['南阳武侯祠'], mk('南阳武侯祠停车场'), { refLat: 33, refLon: 112, source: 'name', rankFn: () => 2 }).excludeKind === 'facility');

finish();
