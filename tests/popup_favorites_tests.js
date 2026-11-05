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
  /https:\/\/stele\.geogv\.org\/zhcn\/geo\//.test(js) &&
  /zhcn\/search\?keyword=/.test(js) &&
  /amapUrlOf/.test(js) && /baiduUrlOf/.test(js) && /copyFavoriteName/.test(js));

check('popup.js：删组二次确认、删除先落盘再移 UI',
  /window\.confirm\('删除这个分组？/.test(js) &&
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
  'const FAV_GROUP_DEFAULT = "g-default";\n' +
  ['pad2', 'formatSavedAt', 'buildDeepLink', 'buildSearchLink', 'filterFavorites', 'groupCounts', 'undoAlive', 'undoText', 'favErrorText']
    .map(grab).join('\n') +
  '\nreturn {pad2, formatSavedAt, buildDeepLink, buildSearchLink, filterFavorites, groupCounts, undoAlive, undoText, favErrorText};'
)();

const items = [
  { steleId: 'a', name: '龙华寺', address: '龙华路2853号', groupId: 'g-default', savedAt: 1000 },
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
  pure.filterFavorites([{ steleId: 'x', name: '甲', address: '', tier: '全国重点', groupId: 'g-default' }], '全国重点', 'all', 'g-default').length === 0);

check('groupCounts：按组计数（含 0 不出现）',
  JSON.stringify(pure.groupCounts(items)) === JSON.stringify({ 'g-default': 1, 'g-trip': 2 }));

check('buildDeepLink：/zhcn/geo/<id> 单一出口、空 id 返回空串',
  pure.buildDeepLink('82e35243f19442eb8b66416a38f6f0b4') ===
    'https://stele.geogv.org/zhcn/geo/82e35243f19442eb8b66416a38f6f0b4' &&
  pure.buildDeepLink('') === '' && pure.buildDeepLink(null) === '');

check('buildSearchLink：name 编码兜底', /^https:\/\/stele\.geogv\.org\/zhcn\/search\?keyword=/.test(pure.buildSearchLink('十里庙遗址')));

check('undoAlive：边界 now < expiresAt 才有效',
  pure.undoAlive({ expiresAt: 100 }, 99) === true &&
  pure.undoAlive({ expiresAt: 100 }, 100) === false &&
  pure.undoAlive(null, 0) === false);

check('undoText/formatSavedAt：计数文案与 MM-DD 收藏时间',
  pure.undoText({ items: [1, 2] }) === '已取消收藏 2 条' &&
  pure.formatSavedAt(new Date(2026, 0, 9).getTime()) === '01-09 收藏');

check('favErrorText：上限/重复组名/存储失败都有人话',
  pure.favErrorText('limit').indexOf('500') >= 0 &&
  pure.favErrorText('duplicate', { groupName: '2026 上海行' }).indexOf('2026 上海行') >= 0 &&
  pure.favErrorText('size').indexOf('1MB') >= 0 &&
  pure.favErrorText('storage').length > 0);

// ---------- 数据层配合：撤销恢复原 savedAt、删组不丢 ----------
env.setup({});
env.load('shared/favorites-store.js');
const S = global.window.HMP.favoritesStore;
const KEY = S.KEY;
const reset = () => { chrome.storage.local._store = {}; };

(async () => {
  reset();
  await S.add({ steleId: 'z1', name: '甲', savedAt: 1234567890 });
  const kept = await S.add({ steleId: 'z2', name: '乙', savedAt: 1234567890 }, { keepSavedAt: true });
  check('store.add 支持 keepSavedAt（撤销恢复原收藏时间）',
    kept.ok === true && kept.item.savedAt === 1234567890);

  const g = await S.createGroup('待删组');
  await S.add({ steleId: 'z3', name: '丙' });
  await S.move('z3', g.group.id);
  const del = await S.deleteGroup(g.group.id);
  const after = await S.read();
  check('删组后条目回「未分组」，不丢条目',
    del.ok === true && after.items.some(x => x.steleId === 'z3' && x.groupId === 'g-default'));

  const exp = await S.exportJSON();
  check('导出 JSON 脱敏（无 key/ak 字段、含 schema/groups/items）',
    !/amapKey|baiduAk|apiKey/i.test(exp) &&
    JSON.parse(exp).schema === 1 && Array.isArray(JSON.parse(exp).items));
  check('导出内容就是单键数据，不多写其它 storage 键',
    Object.keys(chrome.storage.local._store).join(',') === KEY);

  finish();
})();
