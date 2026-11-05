// tests/name_evidence_tests.js
// #14-S · 核心提取（name-evidence.js）单元测试
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const env = require('./_env');
const { check, finish } = env.makeChecker('name-evidence');

const ROOT = path.resolve(__dirname, '..');
const sandbox = { window: {}, module: { exports: {} }, console };
sandbox.window.HMP = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/content/name-evidence.js'), 'utf8'), sandbox);
const NE = sandbox.window.HMP.nameEvidence || sandbox.module.exports;
check('模块挂到 window.HMP.nameEvidence', !!NE && typeof NE.coreEvidence === 'function');
check('commonSubstrings 已导出', !!NE && typeof NE.commonSubstrings === 'function');

// 正例：P13 边界 3/5 = 0.60 恰好过线
const p13 = NE.coreEvidence('南阳武侯祠', '南阳市武侯祠');
check('P13：核心「武侯祠」、覆盖率 0.6 过线', p13.core === '武侯祠' && p13.abstain === false,
  JSON.stringify(p13));
check('P13：coverRatio = 0.6（含边界）', p13.coverRatio === 0.6, String(p13.coverRatio));
check('P13：prefix/suffix 为候选名中核心前后字数',
  p13.prefixLen === 3 && p13.suffixLen === 0, JSON.stringify({ p: p13.prefixLen, s: p13.suffixLen }));

// 负例：2/5 = 0.40 弃权
const low = NE.coreEvidence('南阳武侯祠', '南阳文化馆');
check('负例：覆盖率 2/5 = 0.4 → 名称路弃权', low.abstain === true && low.core === null,
  JSON.stringify(low));

// 负例：核心若是通用词整段 → 丢弃取次长
const gen = NE.coreEvidence('南阳市博物馆', '南阳市公安局');
check('负例：核心不得是整段通用词（市级/公安等）',
  gen.abstain === true || !['市', '南阳市', '公安局'].includes(gen.core), JSON.stringify(gen));

// 正例：真名字里的机构词不受影响（只判整段相等，不判包含）
const guan = NE.coreEvidence('武侯祠', '武侯祠博物馆');
check('正例：核心「武侯祠」不被包含式误杀', guan.core === '武侯祠' && guan.suffixLen === 3,
  JSON.stringify(guan));

// 正例：候选是文保名整段 + 前缀冠名
const brand = NE.coreEvidence('上海音乐厅', '凯迪拉克·上海音乐厅');
check('正例：前缀冠名 → 核心=全名、prefixLen=6', brand.core === '上海音乐厅' &&
  brand.prefixLen === 5 && brand.coverRatio === 1, JSON.stringify(brand));

// 负例：无公共子串（长度≥2）
const none = NE.coreEvidence('故宫', '景山公园');
check('负例：无 ≥2 字公共子串 → 弃权', none.abstain === true && none.reason === 'no-core',
  JSON.stringify(none));

// 负例：空输入
check('负例：空名称弃权', NE.coreEvidence('', '故宫').abstain === true &&
  NE.coreEvidence('故宫', '').abstain === true);

// 通用词表存在且用于整段判断
check('通用词表含行政/机构词', ['市', '区', '街道', '政府', '派出所', '管委会']
  .every(w => NE.GENERIC_WORDS.includes(w)), String(NE.GENERIC_WORDS.length));

// 最长公共子串优先（不是子序列）：避免跨字拼凑
const sub = NE.coreEvidence('上海马桥遗址', '马桥古文化遗址公园');
check('核心取连续子串「马桥」而非跨字拼凑（2/6 覆盖率不足 → 弃权）', sub.abstain === true && sub.reason === 'low-cover',
  JSON.stringify(sub));

finish();
