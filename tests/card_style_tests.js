// tests/card_style_tests.js
// 任务 #03（方向 A）：卡片渲染结构与状态词的行为测试。
// 只测结构与文案，不测颜色（颜色由 证据/task03/contrast.json 实测）。
'use strict';
const env = require('./_env');
const { check, finish } = env.makeChecker('card-style');

env.setup({});
env.loadContentScripts();
const C = global.window.HMP.card;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function texts() { return env.textOf(global.__hmpBasicEl.parentNode); }
function card() { return global.document.getElementById(C.CARD_ID); }

(async function () {
  // ── 站点类保留（站点融合纪律）──
  C.renderState({ card: 'single', kind: 'found', provider: 'amap', providerLabel: '高德地图',
    info: { name: '测试点位', address: '某路 1 号', opentimeToday: '09:00-17:00' },
    siteName: '测试点位', matchType: 'name', evidenceText: '三路证据：名称 1 候选（最高 1.00）',
    amapSearchUrl: '#', baiduSearchUrl: '#' });
  await sleep(10);
  const found = card();
  check('保留站点标题类 .poi-section-title', !!found.querySelector('.poi-section-title'));
  check('保留站点表格类 .attribute-table + .table-no-border',
    !!found.querySelector('.attribute-table') && !!found.querySelector('.table-no-border'));
  check('状态词＝已匹配', env.textOf(found).indexOf('已匹配') >= 0, env.textOf(found).slice(0, 40));
  check('命中态 data-hmp-state=found', found.attrs['data-hmp-state'] === 'found', found.attrs['data-hmp-state']);
  check('命中态用 .hmp-st-found 容器', !!found.querySelector('.hmp-st-found'));
  check('匹配行含点位名与距离', env.textOf(found).indexOf('测试点位') >= 0);
  check('信息行标签用 .hmp-f-label', !!found.querySelector('.hmp-f-label'));

  // ── loading ──
  C.renderState({ card: 'single', kind: 'loading', provider: 'querying' });
  await sleep(10);
  check('loading 状态词＝查询中', env.textOf(card()).indexOf('查询中') >= 0);
  check('loading 有 role=status + aria-live=polite',
    card().querySelector('.hmp-st').attrs.role === 'status' &&
    card().querySelector('.hmp-st').attrs['aria-live'] === 'polite',
    JSON.stringify(card().querySelector('.hmp-st').attrs));

  // ── 未匹配 vs 超时：四要素必须不同（产品 Q4）──
  C.renderState({ card: 'single', kind: 'not-found', provider: 'amap', providerLabel: '高德地图',
    failureKind: 'no-candidates', amapSearchUrl: '#', baiduSearchUrl: '#' });
  await sleep(10);
  const nfState = card().attrs['data-hmp-state'];
  const nfText = env.textOf(card());
  check('未匹配 data-hmp-state=not-found', nfState === 'not-found', nfState);
  check('未匹配状态词＝未匹配', nfText.indexOf('未匹配') >= 0, nfText.slice(0, 40));

  C.renderState({ card: 'single', kind: 'not-found', provider: 'amap', providerLabel: '高德地图',
    failureKind: 'timeout', amapSearchUrl: '#', baiduSearchUrl: '#' });
  await sleep(10);
  const toState = card().attrs['data-hmp-state'];
  const toText = env.textOf(card());
  check('超时 data-hmp-state=timeout（与 not-found 不同）', toState === 'timeout' && toState !== nfState, toState);
  check('超时状态词＝超时（与未匹配不同）',
    toText.indexOf('超时') >= 0 && toText.indexOf('未匹配') < 0, toText.slice(0, 40));
  check('超时首句含「地图接口超时（已重试 1 次）」',
    toText.indexOf('地图接口超时（已重试 1 次）') >= 0, toText.slice(0, 80));
  check('超时容器 .hmp-st-timeout 且 role=alert',
    !!card().querySelector('.hmp-st-timeout') &&
    card().querySelector('.hmp-st-timeout').attrs.role === 'alert');
  check('超时按钮文案＝重试查询', toText.indexOf('重试查询') >= 0 && !!card().querySelector('.hmp-btn'));

  // ── 文物组概念态（dormant：产品路径不会渲染）──
  C.renderState({ card: 'group', kind: 'group-done', provider: 'group', groupName: '徐家汇天主教历史建筑群',
    total: 2, results: [
      { name: '徐家汇天主堂', status: 'found', info: { name: '徐家汇天主堂', opentimeToday: '08:30-17:30', address: '蒲西路 158 号' } },
      { name: '徐汇公学旧址', status: 'not-found', info: null },
    ] });
  await sleep(10);
  const gText = env.textOf(card());
  check('文物组 badge 文案', gText.indexOf('概念态 · 当前版本不显示') >= 0, gText.slice(0, 60));
  check('文物组标题含组名与子项目数',
    gText.indexOf('徐家汇天主教历史建筑群') >= 0 && gText.indexOf('共 2 个子项目') >= 0);
  check('文物组表格渲染（4 列表头 + 2 行数据）',
    !!card().querySelector('.hmp-grp') &&
    ['子项目', '开放时间', '票价', '地址'].every(h => gText.indexOf(h) >= 0) &&
    gText.indexOf('徐家汇天主堂') >= 0 && gText.indexOf('徐汇公学旧址') >= 0, gText.slice(0, 160));
  check('未匹配子项目在表格里写「未匹配到」', gText.indexOf('未匹配到') >= 0, gText.slice(0, 120));

  finish();
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
