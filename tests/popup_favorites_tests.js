// tests/popup_favorites_tests.js
// #32b · 弹窗收藏页：结构/样式静态断言 + 视图纯函数 + 数据层撤销/删组语义
'use strict';
const fs = require('fs');
const path = require('path');
const env = require('./_env');
const { check, finish } = env.makeChecker('popup-favorites');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src/popup/popup.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/popup/popup.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'src/popup/popup.js'), 'utf8');

// ---------- 静态结构 ----------
check('popup.html：tablist 两个 tab、默认收藏选中、设置 hidden',
  /role="tablist"/.test(html) &&
  /id="tab-fav"[^>]*aria-selected="true"/.test(html) &&
  /id="tab-set"[^>]*aria-selected="false"/.test(html) &&
  /id="tab-fav"[^>]*aria-controls="panel-fav"/.test(html) &&
  /id="tab-set"[^>]*aria-controls="panel-set"/.test(html) &&
  /id="tab-set"[^>]*tabindex="-1"/.test(html) &&
  /id="panel-fav"[^>]*role="tabpanel"/.test(html) &&
  !/id="panel-fav"[^>]*hidden/.test(html) &&
  /id="panel-set"[^>]*role="tabpanel"[^>]*hidden/.test(html));

check('popup.html：收藏页有搜索、范围 radiogroup、列表、撤销、导出',
  /id="favQuery"/.test(html) &&
  /id="scopeGroup"[^>]*role="radio"/.test(html) &&
  /id="scopeAll"[^>]*role="radio"/.test(html) &&
  /id="favList"[^>]*role="list"/.test(html) &&
  /id="favUndo"[^>]*role="status"/.test(html) &&
  /id="favUndo"[^>]*hidden/.test(html) &&
  /id="favExport"/.test(html));

check('popup.html：撤销条位于搜索栏下、分组 chips 上（#32c，设计 s08）',
  html.indexOf('id="favFound"') >= 0 &&
  html.indexOf('id="favFound"') < html.indexOf('id="favUndo"') &&
  html.indexOf('id="favUndo"') < html.indexOf('id="favChips"') &&
  html.indexOf('id="favUndo"') < html.indexOf('id="favList"') &&
  /class="undo"[^>]*id="favUndo"/.test(html) &&
  /id="favUndoBtn"[^>]*>撤销</.test(html));

check('#49 页脚两页共用：只有一份、位于两个 panel 之后',
  (html.match(/class="hmp-foot"/g) || []).length === 1 &&
  (html.match(/id="updWrap"/g) || []).length === 1 &&
  (html.match(/id="updLinks"/g) || []).length === 1 &&
  (html.match(/id="updInstall"/g) || []).length === 1 &&
  html.indexOf('<footer class="pfoot">') > html.indexOf('id="panel-set"') &&
  html.indexOf('</footer>') < html.indexOf('</main>'));

check('#49 页脚 id 全部保留（ver/updMsg/checkUpdate/dlMain/dlSrc）',
  ['ver', 'updMsg', 'checkUpdate', 'dlMain', 'dlSrc'].every(id => html.indexOf('id="' + id + '"') >= 0));

check('#49 CSS：.popup 列布局 / .pfoot 贴底 / .hmp-foot 不再 sticky',
  /\.popup\{[^}]*display:flex;flex-direction:column/.test(css) &&
  /\.ppanel\{flex:0 0 auto\}/.test(css) &&
  /\.pfoot\{margin-top:auto;flex:0 0 auto;padding-top:8px\}/.test(css) &&
  !/\.hmp-foot\{[^}]*position:sticky/.test(css));

check('popup.html：三种空态与提示带都有独立节点',
  /id="favEmptyTitle"/.test(html) && /id="favEmptyBody"/.test(html) &&
  /id="favEmptyGo"/.test(html) && /id="favEmptyClear"/.test(html) &&
  /id="favHint"/.test(html) && /id="favHintText"/.test(html));

check('popup.html：组管理菜单含新建/重命名/删除（删除 danger）',
  /id="favGroupMenuBtn"[^>]*aria-haspopup="menu"/.test(html) &&
  /id="favNewGroup"/.test(html) && /id="favRenameGroup"/.test(html) &&
  /class="[^"]*danger[^"]*"[^>]*id="favDeleteGroup"/.test(html) &&
  /id="favNewForm"[^>]*hidden/.test(html));

check('popup.html：设置页仍用原 id（结构不变）',
  html.indexOf('id="panel-set"') < html.indexOf('id="band"') &&
  /id="amapKey"/.test(html) && /id="baiduAk"/.test(html) &&
  /id="save"/.test(html) && /id="clearCache"/.test(html) && /id="exportLog"/.test(html) &&
  /id="defaultProvider"/.test(html) && /id="strategyMode"/.test(html));

check('popup.js：默认收藏页 + 搜索 debounce 150 + 撤销 5000',
  /let activeTab = 'fav'/.test(js) &&
  /FAV_SEARCH_DEBOUNCE = 150/.test(js) &&
  /FAV_UNDO_MS = 5000/.test(js) &&
  /activateTab\('fav', false\)/.test(js));

check('popup.js：深链单一出口与高德/百度/复制名称',
  /http:\/\/stele\.geogv\.org\/zhcn\/geo\//.test(js) &&
  js.indexOf('https://stele.geogv.org') === -1 &&
  /zhcn\/search\?keyword=/.test(js) &&
  /amapUrlOf/.test(js) && /baiduUrlOf/.test(js) && /copyFavoriteName/.test(js));

check('popup.js：删组二次确认（带组名/条数）、删除先落盘再移 UI',
  /window\.confirm\(deleteGroupConfirmText\(/.test(js) &&
  js.indexOf('await store.remove(item.steleId') >= 0 &&
  js.indexOf('pushFavUndo(r.item || item, item.groupId)') >= 0);

check('popup.css：两主题变量齐全、收藏页无硬编码颜色',
  /--hmp-page:/.test(css) && /--hmp-primary:/.test(css) &&
  /--hmp-err-ink:/.test(css) && /--hmp-ok-ink:/.test(css) &&
  !/\.fav[^}]*#[0-9a-fA-F]{3,6}/.test(css) &&
  /\.favs\s*\{[^}]*overflow-y:\s*auto/.test(css));

check('popup.css：触控点击区 ≥40、主题开关仍 44×32',
  /\.flink[^{]*\{[^}]*min-height:\s*40px/.test(css) &&
  /\.btn[^{]*\{[^}]*min-height:\s*40px/.test(css) &&
  /\.seg-b[^{]*\{[^}]*width:\s*44px[^}]*height:\s*32px/.test(css));

check('popup.css：撤销条为全宽信息带（s08 口径，#32c）',
  /\.undo\s*\{[^}]*background:\s*var\(--hmp-info-bg\)/.test(css) &&
  /\.undo\s*\{[^}]*margin:\s*4px 12px/.test(css) &&
  /\.undo\s*\{[^}]*padding:\s*6px 10px/.test(css) &&
  /\.undo \.ic\s*\{[^}]*width:\s*16px[^}]*height:\s*16px/.test(css) &&
  /\.undo-t\s*\{[^}]*font-weight:\s*600/.test(css) &&
  /\.undo \.btn\s*\{[^}]*align-self:\s*center[^}]*min-height:\s*40px/.test(css));

check('popup.js：长名称单行省略由 JS 补 title（不是只靠 CSS）',
  /\.fname/.test(css) && /text-overflow:\s*ellipsis/.test(css) &&
  /name\.title = item\.name/.test(js) && /\.fname[^{]*\{[^}]*white-space:\s*nowrap/.test(css));

// ---------- 视图纯函数（从真实源码抽函数体执行） ----------
function grab(name) {
  const start = js.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('missing function ' + name);
  const next = js.indexOf('\n  function ', start + 10);
  return js.slice(start, next < 0 ? js.length : next);
}
const pure = new Function(
  'const FAV_GROUP_DEFAULT = "g-want";\n' +
  ['pad2', 'formatSavedAt', 'buildDeepLink', 'buildSearchLink', 'filterFavorites', 'groupCounts', 'undoAlive', 'undoText', 'favErrorText', 'deleteGroupConfirmText']
    .map(grab).join('\n') +
  '\nreturn {pad2, formatSavedAt, buildDeepLink, buildSearchLink, filterFavorites, groupCounts, undoAlive, undoText, favErrorText, deleteGroupConfirmText};'
)();


const items = [
  { steleId: 'a', name: '龙华寺', address: '龙华路2853号', groupId: 'g-been', savedAt: 1000 },
  { steleId: 'b', name: 'Shanghai Museum', address: '人民大道201号', groupId: 'g-trip', savedAt: 2000 },
  { steleId: 'c', name: '徐家汇天主堂', address: '蒲西路158号', groupId: 'g-trip', savedAt: 1500 }
];

check('filterFavorites：当前组只出本组、按 savedAt 顺序',
  pure.filterFavorites(items, '', 'group', 'g-trip').map(x => x.steleId).join(',') === 'b,c');

check('filterFavorites：全部范围合并、名称/地址子串大小写不敏感、trim',
  pure.filterFavorites(items, '  museum ', 'all', 'g-trip').length === 1 &&
  pure.filterFavorites(items, '  龙华路  ', 'all', 'g-trip').length === 1 &&
  pure.filterFavorites(items, '徐家汇', 'all', 'g-trip').length === 1);

check('filterFavorites：tier 不参与搜索',
  pure.filterFavorites([{ steleId: 'x', name: '甲', address: '', tier: '全国重点', groupId: 'g-want' }], '全国重点', 'all', 'g-want').length === 0);

check('groupCounts：按组计数（含 0 不出现）',
  JSON.stringify(pure.groupCounts(items)) === JSON.stringify({ 'g-been': 1, 'g-trip': 2 }));

check('#47 buildDeepLink：http /zhcn/geo/<id> 单一出口、空 id 返回空串',
  pure.buildDeepLink('82e35243f19442eb8b66416a38f6f0b4') ===
    'http://stele.geogv.org/zhcn/geo/82e35243f19442eb8b66416a38f6f0b4' &&
  pure.buildDeepLink('') === '' && pure.buildDeepLink(null) === '');

check('#47 buildSearchLink：http 兜底、name 编码', /^http:\/\/stele\.geogv\.org\/zhcn\/search\?keyword=/.test(pure.buildSearchLink('十里庙遗址')));

check('undoAlive：边界 now < expiresAt 才有效',
  pure.undoAlive({ expiresAt: 100 }, 99) === true &&
  pure.undoAlive({ expiresAt: 100 }, 100) === false &&
  pure.undoAlive(null, 0) === false);

check('undoText/formatSavedAt：单条给名称、多条给条数、MM-DD 收藏时间',
  pure.undoText({ items: [{ item: { name: '龙华寺' }, groupId: 'g-want' }] }) === '已取消收藏「龙华寺」' &&
  pure.undoText({ items: [{ item: { name: '甲' } }, { item: { name: '乙' } }] }) === '已取消收藏 2 条' &&
  pure.undoText({ items: [{}] }) === '已取消收藏 1 条' &&
  pure.formatSavedAt(new Date(2026, 0, 9).getTime()) === '01-09 收藏');

check('favErrorText：上限/分组上限/重名/非法名/系统组/存储失败都有人话',
  pure.favErrorText('limit').indexOf('500') >= 0 &&
  pure.favErrorText('limit-groups') === '分组已达上限（30 个）。' &&
  pure.favErrorText('duplicate', { groupName: '2026 上海行' }).indexOf('2026 上海行') >= 0 &&
  pure.favErrorText('duplicate-name') === '已有同名分组，换个名字。' &&
  pure.favErrorText('invalid-name').indexOf('24 字') >= 0 &&
  pure.favErrorText('system').indexOf('系统分组') >= 0 &&
  pure.favErrorText('system-group', { groupName: '已去' }) === '「已去」是系统分组，不能删除或改名。' &&
  pure.favErrorText('need-group') === '请选择分组后再收藏。' &&
  pure.favErrorText('size').indexOf('1MB') >= 0 &&
  pure.favErrorText('storage').length > 0);

check('deleteGroupConfirmText：带组名与条数，n=0 省略条目句（P3-4）',
  pure.deleteGroupConfirmText('2026 上海行', 3) ===
    '删除分组「2026 上海行」？组内 3 条收藏会移到「想去」，不会丢失。' &&
  pure.deleteGroupConfirmText('空组', 0) ===
    '删除分组「空组」？组内没有收藏，删除不影响收藏内容。');

check('popup.js：删组确认用插值函数（不走固定占位文案）',
  /window\.confirm\(deleteGroupConfirmText\(/.test(js) &&
  js.indexOf("'删除这个分组？") < 0);

check('#39：顶部 Tab 文字为「开放时间」，但 panel id/aria-controls 不变（只改文字）',
  /id="tab-set"[^>]*>开放时间</.test(html) &&
  /id="tab-set"[^>]*aria-controls="panel-set"/.test(html) &&
  /id="panel-set"[^>]*aria-labelledby="tab-set"/.test(html));

check('#39：收藏默认范围「全部」（HTML 与 JS 初值一致）',
  /id="scopeAll"[^>]*aria-checked="true"/.test(html) &&
  /id="scopeGroup"[^>]*aria-checked="false"/.test(html) &&
  /let favScope = 'all'/.test(js) && /let favActiveGroup = FAV_GROUP_DEFAULT/.test(js));

check('#39：chips 点组即切回当前组过滤（不是只在「全部」里高亮）',
  /favScope = 'group';/.test(js) && /renderFavGroupMenuState/.test(js));

check('#39：系统分组在组菜单里置灰且点击给解释文案',
  /classList\.toggle\('is-disabled', sys\)/.test(js) &&
  /aria-disabled/.test(js) &&
  /是系统分组，不能删除或改名/.test(js) &&
  /\.menu-i\.is-disabled/.test(css));

check('#39：撤销写回原组（add 带 groupId，不靠再 move）',
  /groupId: rec\.groupId \|\| FAV_GROUP_DEFAULT/.test(js) &&
  js.indexOf('await store.move(rec.item.steleId') < 0);

check('popup.js：订阅 chrome.storage.onChanged 刷新收藏页（P2-2）',
  /bindFavoritesStorageSync/.test(js) &&
  /storage\.onChanged/.test(js) &&
  /bindFavorites\(\);\s*\n\s*bindFavoritesStorageSync\(\);/.test(js) &&
  /reason === 'limit-groups'/.test(js));


// ---------- #41：卡片收藏控件在头部右上角（静态结构/CSS）----------
const cardJs = fs.readFileSync(path.join(root, 'src/content/card.js'), 'utf8');
const contentCss = fs.readFileSync(path.join(root, 'src/content/content.css'), 'utf8');

check('#41：headRight 注入 .hmp-st-head，正文底部不再 push 收藏节点',
  /if \(o\.headRight\) head\.appendChild\(o\.headRight\)/.test(cardJs) &&
  /headRight: buildFavoriteHeadRight\(state\)/.test(cardJs) &&
  !/children\.push\(buildFavoriteRow\(state\)\)/.test(cardJs));

check('#41：收藏控件右对齐、菜单绝对定位（不推布局）',
  /\.hmp-fav-ctl \{[^}]*position: relative/.test(contentCss) &&
  /\.hmp-fav-wrap \{[^}]*margin-left: auto/.test(contentCss) &&
  /\.hmp-fav-menu \{[^}]*position: absolute/.test(contentCss) &&
  /\.hmp-fav-ctl \.hmp-btn \{[^}]*min-height: 32px/.test(contentCss));

check('#41：旧正文底部收藏样式已移除，chip 有独立样式',
  contentCss.indexOf('.hmp-fav-row') < 0 && contentCss.indexOf('.hmp-fav-choose') < 0 &&
  /\.hmp-fav-chip \{[^}]*font: 12px/.test(contentCss));


// ---------- 数据层配合：撤销恢复原 savedAt、删组不丢 ----------
env.setup({});
env.load('shared/favorites-store.js');
const S = global.window.HMP.favoritesStore;
const KEY = S.KEY;
const reset = () => { chrome.storage.local._store = {}; };

(async () => {
  reset();
  await S.add({ steleId: 'z1', name: '甲', savedAt: 1234567890 }, { groupId: 'g-been' });
  const kept = await S.add({ steleId: 'z2', name: '乙', savedAt: 1234567890 }, { keepSavedAt: true, groupId: 'g-want' });
  check('store.add 支持 keepSavedAt（撤销恢复原收藏时间）',
    kept.ok === true && kept.item.savedAt === 1234567890);

  const g = await S.createGroup('待删组');
  await S.add({ steleId: 'z3', name: '丙' }, { groupId: 'g-been' });
  await S.move('z3', g.group.id);
  const del = await S.deleteGroup(g.group.id);
  const after = await S.read();
  check('删组后条目回「想去」，不丢条目',
    del.ok === true && after.items.some(x => x.steleId === 'z3' && x.groupId === 'g-want'));

  const exp = await S.exportJSON();
  check('导出 JSON 脱敏（无 key/ak 字段、含 schema/groups/items）',
    !/amapKey|baiduAk|apiKey/i.test(exp) &&
    JSON.parse(exp).schema === 1 && Array.isArray(JSON.parse(exp).items));
  check('导出内容就是单键数据，不多写其它 storage 键',
    Object.keys(chrome.storage.local._store).join(',') === KEY);

  finish();
})();
