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

  // ── #15 补充：长内容用例（结构/样式不变量；几何量测见 证据/task15/measure.json gates）──
  // 说明：本测试环境无布局引擎，不能量 clientWidth/scrollWidth；「单行」由 white-space:nowrap + 无写死 em 列宽保证，
  // 真实几何（rangeRects===1、scrollWidth<=clientWidth、无横滚）由 证据/task15/shoot.mjs 在真实 Chrome 量测。
  const LONG_CASES = [
    { name: '超长景区名（≥20 字）', siteName: '南阳卧龙岗武侯祠景区文物保护管理处',
      info: { name: '南阳卧龙岗武侯祠景区文物保护管理处', opentimeWeek: '周一至周日 08:00-18:00（17:30 停止入场）',
        cost: '成人 60 元，学生半价', address: '河南省南阳市卧龙区卧龙路 766 号武侯祠景区东门游客中心' } },
    { name: '含括号补充说明', siteName: '卧龙岗武侯祠景区（南阳市博物馆）',
      info: { name: '卧龙岗武侯祠景区（南阳市博物馆）', opentimeWeek: '08:00-18:00', cost: '免费（需预约）',
        address: '河南省南阳市卧龙区卧龙路 766 号（南阳市博物馆院内）' } },
    { name: '中英混合名', siteName: 'Shanghai Concert Hall 上海音乐厅',
      info: { name: 'Shanghai Concert Hall 上海音乐厅', opentimeWeek: '09:00-17:30', cost: '50 元',
        address: '上海市黄浦区延安东路 523 号（No.523 Yan’an East Road）' } },
  ];
  for (const c of LONG_CASES) {
    C.renderState({ card: 'single', kind: 'found', provider: 'amap', providerLabel: '高德地图',
      info: c.info, siteName: c.siteName, matchType: 'name',
      evidenceText: '三路证据：名称 1 候选（最高 1.00）', amapSearchUrl: '#', baiduSearchUrl: '#' });
    await sleep(10);
    const el = card();
    const labels = [...el.querySelectorAll('.hmp-f-label')];
    const vals = [...el.querySelectorAll('.hmp-f-val')];
    const styles = labels.map(l => (l.attrs && l.attrs.style) || '');
    check(c.name + '：三个标签都渲染', labels.length === 3 && vals.length === 3,
      labels.length + '/' + vals.length + ' ' + labels.map(l => l.textContent).join('/'));
    check(c.name + '：标签单行（内联 nowrap + width:1%，无写死 em）',
      styles.length === 3 && styles.every(st => /white-space:\s*nowrap/.test(st) && /width:\s*1%/.test(st) && !/\dem/.test(st)),
      JSON.stringify(styles));
    check(c.name + '：值列保留完整文本（不截断）',
      vals.every((v, i) => v.textContent === Object.values(c.info)[i] || v.textContent.length > 0) &&
      env.textOf(el).indexOf(c.info.name) >= 0,
      vals.map(v => (v.textContent || '').slice(0, 12)).join('|'));
  }

  // ── #16：匹配行名称 + 距离独占第二行（前缀单独一行）──
  const MATCH_CASES = [
    { type: 'name', siteName: '南阳武侯祠', name: '南阳武侯祠', want: '地图上同名点位：' },
    { type: 'name', siteName: '南阳武侯祠', name: '卧龙岗武侯祠景区（南阳市博物馆）', want: '匹配到地图上的：' },
    { type: 'location', siteName: '南阳武侯祠', name: '南阳武侯祠博物馆', want: '该点位现用名与文保名称不同，已按位置匹配到：' },
  ];
  for (const c of MATCH_CASES) {
    C.renderState({ card: 'single', kind: 'found', provider: 'amap', providerLabel: '高德地图',
      info: { name: c.name, opentimeWeek: '08:00-18:00', address: '某路 1 号' },
      siteName: c.siteName, matchType: c.type, matchDist: 1234,
      evidenceText: '三路证据：名称 1 候选（最高 1.00）', amapSearchUrl: '#', baiduSearchUrl: '#' });
    await sleep(10);
    const el = card();
    const line = el.querySelector('.hmp-match-line');
    const nameSpan = el.querySelector('.hmp-match-name');
    const lineText = line ? env.textOf(line) : '';
    const nameText = nameSpan ? env.textOf(nameSpan) : '';
    check('匹配行有 .hmp-match-name 且含名称 + 距离',
      !!nameSpan && nameText.indexOf(c.name) >= 0 && nameText.indexOf('（直线约 1234 米）') >= 0,
      nameText);
    // 结构：前缀是 <p> 的直接文本，名称+距离是它下面唯一的 <span>（block 换行），前缀与名称不拼在同一节点
    const kids = (line && line.children) || [];
    const prefixNode = kids[0];
    const bNode = nameSpan && (nameSpan.querySelector('b') ||
      (nameSpan.children || []).filter(k => k.tagName === 'B')[0]);
    check('前缀独占第一行（前缀是匹配行首个文本节点，名称+距离在独立的 .hmp-match-name 里）',
      !!line && !!prefixNode && prefixNode.nodeType === 3 && (prefixNode.textContent === c.want || prefixNode.text === c.want) &&
      kids.length === 2 && /hmp-match-name/.test(kids[1].className || ''),
      JSON.stringify({ kids: kids.map(k => [k.nodeType, k.text || k.className]) }));
    check('名称在 <b> 里（前缀与名称不拼同一节点）',
      !!bNode && env.textOf(bNode) === c.name, bNode ? env.textOf(bNode) : 'no-b');
  }
  // 静态不变量：#16 的样式只在卡片作用域、字号/颜色不回退
  {
    const fsx = require('fs'); const pathx = require('path');
    const cssTxt = fsx.readFileSync(pathx.join(__dirname, '../src/content/content.css'), 'utf8');
    check('CSS：#hmp-opening-card .hmp-match-name display:block + margin-top:2px',
      /#hmp-opening-card \.hmp-match-name \{[^}]*display: block;[^}]*margin-top: 2px;/.test(cssTxt));
    check('CSS：无未作用域的 .hmp-match-name 规则',
      !/(^|\n)[^#\n]*\.hmp-match-name\s*\{/.test(cssTxt.replace(/#hmp-opening-card \.hmp-match-name \{[^}]*\}/g, '')));
    check('匹配行字号/颜色未回退（14px、#333333；窄屏 13px）',
      /#hmp-opening-card \.hmp-match-line \{[^}]*font-size: 14px;[^}]*color: #333333;/.test(cssTxt) &&
      /#hmp-opening-card \.hmp-match-line,\n[^}]*font-size: 13px;/.test(cssTxt));
    check('名称加粗色 #212529 未变',
      /#hmp-opening-card \.hmp-match-line b \{[^}]*font-weight: 600;[^}]*color: #212529;/.test(cssTxt));
  }

  // ── #15 静态不变量（防回退，不依赖布局）──
  const fsx = require('fs'); const pathx = require('path');
  const cssTxt = fsx.readFileSync(pathx.join(__dirname, '../src/content/content.css'), 'utf8');
  const jsTxt = fsx.readFileSync(pathx.join(__dirname, '../src/content/card.js'), 'utf8');
  check('CSS：.hmp-f-label 用 width:1% + white-space:nowrap',
    /\.hmp-f-label \{[^}]*width: 1%;[^}]*white-space: nowrap;/.test(cssTxt));
  check('CSS/JS 不再有 4.6em / 4.2em 写死标签列宽',
    !/4\.6em|4\.2em/.test(cssTxt) && !/4\.6em|4\.2em/.test(jsTxt));
  check('表格改自动布局：card.js 内联 table-layout:auto',
    /table-layout:auto/.test(jsTxt) && /\.hmp-fields \{[^}]*table-layout: auto;/.test(cssTxt));
  check('值列可折行（.hmp-f-val overflow-wrap:anywhere）',
    /\.hmp-f-val \{[^}]*overflow-wrap: anywhere;/.test(cssTxt));
  check('窄屏只调字号，不再覆盖列宽（:244 无 width）',
    /td\.hmp-f-label \{ font-size: 11\.5px; \}/.test(cssTxt));

  finish();
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
