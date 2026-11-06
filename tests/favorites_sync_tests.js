// tests/favorites_sync_tests.js
// #53 · WebDAV 同步：合并纯函数（墓碑/组归属/时间比较）+ 最小客户端（mock fetch）
'use strict';
const fs = require('fs');
const path = require('path');
const env = require('./_env');
const { check, finish } = env.makeChecker('favorites-sync');

env.setup({});
env.load('shared/favorites-store.js');
env.load('shared/favorites-sync.js');

const S = global.window.HMP.favoritesStore;
const M = global.window.HMP.favoritesSync;
const KEY = S.KEY;
const WANT = 'g-want';
const BEEN = 'g-been';

const G = (id, name, updatedAt, system) => ({ id, name, system: !!system, createdAt: updatedAt, updatedAt });
const IT = (steleId, name, updatedAt, groupId, extra) => Object.assign({
  steleId, name, savedAt: updatedAt, updatedAt, groupId,
}, extra || {});
const lib = (groups, items, tombstones) => ({
  schema: 2, groups, items, tombstones: tombstones || [],
});

(async () => {
  check('模块导出：SYNC_KEY/默认路径/合并与客户端函数',
    M && M.SYNC_KEY === 'hmp:webdav' && M.DEFAULT_PATH === 'heritage-map/favorites.json' &&
    typeof M.mergeLibraries === 'function' && typeof M.syncLibrary === 'function' &&
    typeof M.buildUrl === 'function' && typeof M.getRemote === 'function');

  // ---- 合并规则 ----
  const NOW = Date.now();
  const baseGroups = [G(BEEN, '已去', 0, true), G(WANT, '想去', 1, true)];

  const m1 = M.mergeLibraries(
    lib(baseGroups, [IT('a', '甲', 100, WANT)]),
    lib(baseGroups, [IT('b', '乙', 120, BEEN)]));
  check('合并：双方独有条目都保留（新增统计 = 远端独有）',
    m1.library.items.length === 2 && m1.stats.added === 1 && m1.stats.kept === 1);

  const m2 = M.mergeLibraries(
    lib(baseGroups, [IT('a', '旧名', 100, WANT)]),
    lib(baseGroups, [IT('a', '新名', 200, WANT)]));
  check('合并：同 key 较新覆盖（updated 统计）',
    m2.library.items.length === 1 && m2.library.items[0].name === '新名' && m2.stats.updated === 1);

  const m3 = M.mergeLibraries(
    lib(baseGroups, [IT('a', '本机新', 300, WANT)]),
    lib(baseGroups, [IT('a', '远端旧', 200, WANT)]));
  check('合并：本机更新时忽略远端（kept，不覆盖）',
    m3.library.items[0].name === '本机新' && m3.stats.updated === 0);

  const m4 = M.mergeLibraries(
    lib(baseGroups, [IT('a', '同刻本机', 500, WANT)]),
    lib(baseGroups, [IT('a', '同刻远端', 500, WANT)]));
  check('合并：updatedAt 相同取本机', m4.library.items[0].name === '同刻本机');

  const m5 = M.mergeLibraries(
    lib(baseGroups, [IT('a', '甲', 100, WANT)]),
    lib(baseGroups, [IT('a', '甲', 100, WANT)],
      [{ kind: 'item', key: 'a', deletedAt: NOW - 1000 }]));
  check('合并：删除传播（墓碑比条目新 → 条目消失、墓碑保留）',
    m5.library.items.length === 0 && m5.stats.removed === 1 &&
    m5.library.tombstones.some(t => t.kind === 'item' && t.key === 'a'));

  const m6 = M.mergeLibraries(
    lib(baseGroups, [IT('a', '复活', NOW, WANT)],
      [{ kind: 'item', key: 'a', deletedAt: NOW - 5000 }]),
    lib(baseGroups, []));
  check('合并：墓碑被较新条目复活并清墓碑',
    m6.library.items.length === 1 && m6.library.items[0].name === '复活' &&
    !m6.library.tombstones.some(t => t.kind === 'item' && t.key === 'a'));

  const mvGroups = baseGroups.concat([G('g-x', '出片', 10)]);
  const m7 = M.mergeLibraries(
    lib(baseGroups, [IT('a', '甲', 100, WANT)]),
    lib(mvGroups, [IT('a', '甲', 200, 'g-x')]));
  check('合并：移动传播且组随远端同步', m7.library.groups.some(g => g.id === 'g-x') && m7.library.items[0].groupId === 'g-x');

  const m8 = M.mergeLibraries(
    lib(baseGroups.concat([G('g-x', '出片', 10)]), [IT('a', '甲', 100, 'g-x')]),
    lib(baseGroups, [], [{ kind: 'group', key: 'g-x', deletedAt: NOW - 1000 }]));
  check('合并：组删除后条目落「想去」、组消失、组墓碑保留',
    !m8.library.groups.some(g => g.id === 'g-x') &&
    m8.library.items[0].groupId === WANT &&
    m8.library.tombstones.some(t => t.kind === 'group' && t.key === 'g-x'));

  const m9 = M.mergeLibraries(
    lib(baseGroups.concat([G('g-local', '出片', 10)]), [IT('a', '甲', 100, 'g-new', { groupName: '出片' })]),
    lib(baseGroups.concat([G('g-local', '出片', 10)]), [IT('a', '甲', 100, 'g-new', { groupName: '出片' })]));
  check('合并：groupId 失效按 groupName 找同名非系统组',
    m9.library.items[0].groupId === 'g-local');

  const m10 = M.mergeLibraries(
    lib(baseGroups.concat([G('g-x', '旧组名', 100)]), []),
    lib(baseGroups.concat([G('g-x', '新组名', 200)]), []));
  check('合并：组改名取 updatedAt 新者', m10.library.groups.find(g => g.id === 'g-x').name === '新组名');

  const m11 = M.mergeLibraries(
    lib(baseGroups, [Object.assign(IT('', '同名点', 100, WANT), { steleId: '', address: '某路1号' })]),
    lib(baseGroups, [Object.assign(IT('', '同名点', 200, BEEN), { steleId: '', address: '某路1号' })]));
  check('合并：缺 steleId 用 name+address 作 key', m11.library.items.length === 1 && m11.library.items[0].groupId === BEEN);

  check('合并：非法 schema / 结构返回 null（normalizeLibrary）',
    M.normalizeLibrary({ schema: 3, groups: [], items: [] }) === null &&
    M.normalizeLibrary({ schema: 2, groups: {}, items: [] }) === null);

  // ---- WebDAV 客户端 ----
  check('buildUrl：路径分段编码、去重斜杠',
    M.buildUrl('https://dav.example.com/dav/', 'heritage-map/favorites.json') ===
      'https://dav.example.com/dav/heritage-map/favorites.json' &&
    M.buildUrl('https://dav.example.com', 'a b/c.json') === 'https://dav.example.com/a%20b/c.json');

  const cfg = { url: 'https://dav.example.com/dav', user: 'u', pass: 'p', path: 'f.json' };
  const url = M.buildUrl(cfg.url, cfg.path);
  check('authHeader：Basic base64(user:pass)',
    M.authHeader(cfg).Authorization === 'Basic ' + Buffer.from('u:p').toString('base64'));

  function resp(status, body) {
    return {
      ok: status >= 200 && status < 300, status,
      text: async () => (body == null ? '' : String(body)),
    };
  }

  const calls = [];
  const f404 = async (u, o) => {
    calls.push({ u, method: (o && o.method) || 'GET' });
    return resp(404);
  };
  const g404 = await M.getRemote(cfg, url, f404);
  check('GET 404 → 首次（远端为空），不当错误', g404.ok === true && g404.missing === true);

  const g401 = await M.getRemote(cfg, url, async () => resp(401));
  check('GET 401 → reason=auth', g401.ok === false && g401.reason === 'auth');

  const badCalls = [];
  const badFetch = async (u, o) => {
    badCalls.push({ u, method: (o && o.method) || 'GET' });
    if (((o && o.method) || 'GET') === 'GET') return resp(200, 'not json');
    return resp(201);
  };
  const fakeStore = {
    lib: lib(baseGroups, [IT('a', '甲', 100, WANT)]),
    async read() { return { schema: 2, groups: this.lib.groups, items: this.lib.items, tombstones: this.lib.tombstones }; },
    async replace(x) { this.lib = x; return { ok: true, library: x }; },
  };
  const badRun = await M.syncLibrary(cfg, fakeStore, badFetch);
  check('远端非法 JSON：中止且不写本机', badRun.ok === false && badRun.reason === 'invalid-remote' &&
    badCalls.every(c => c.method === 'GET'));

  // 404 首次：只 PUT 主文件，不带 .bak
  const firstCalls = [];
  const firstFetch = async (u, o) => {
    const method = (o && o.method) || 'GET';
    firstCalls.push({ method, u });
    if (method === 'GET') return resp(404);
    return resp(201);
  };
  const firstStore = { lib: lib(baseGroups, [IT('a', '甲', 100, WANT)]),
    async read() { return { schema: 2, groups: this.lib.groups, items: this.lib.items, tombstones: [] }; },
    async replace(x) { this.lib = x; return { ok: true }; } };
  const first = await M.syncLibrary(cfg, firstStore, firstFetch);
  check('404 首次：直接 PUT 主文件、不创建 .bak',
    first.ok === true && first.remoteExisted === false &&
    firstCalls.some(c => c.method === 'PUT' && c.u === url) &&
    !firstCalls.some(c => c.u.indexOf('.bak') >= 0) &&
    firstCalls.filter(c => c.method === 'PUT').length === 1);

  // 远端已有：先 HEAD 备份、PUT 备份、再 PUT 主文件、最后写本机
  const seq = [];
  const remoteBody = JSON.stringify(lib(baseGroups, [IT('b', '乙', 200, BEEN)]));
  const seqFetch = async (u, o) => {
    const method = (o && o.method) || 'GET';
    seq.push(method + ' ' + u);
    if (method === 'GET') return resp(200, remoteBody);
    if (method === 'HEAD') return resp(404);
    return resp(201);
  };
  const seqStore = { lib: lib(baseGroups, [IT('a', '甲', 100, WANT)]), replaced: false,
    async read() { return { schema: 2, groups: this.lib.groups, items: this.lib.items, tombstones: [] }; },
    async replace(x) { this.replaced = true; this.lib = x; return { ok: true }; } };
  const seqRun = await M.syncLibrary(cfg, seqStore, seqFetch);
  const putIdx = seq.filter(x => x.indexOf('PUT ') === 0);
  check('远端已有：HEAD .bak → PUT .bak → PUT 主文件 → replace',
    seqRun.ok === true && seqRun.remoteExisted === true && seqStore.replaced === true &&
    seq[0].indexOf('GET ') === 0 &&
    seq.some(x => x.indexOf('HEAD ') === 0 && x.endsWith('.bak')) &&
    putIdx.length === 2 && putIdx[0].endsWith('.bak') && putIdx[1] === 'PUT ' + url);

  check('同步 PUT 内容不含凭据', (() => {
    const body = JSON.stringify(seqRun) + JSON.stringify(seqStore.lib);
    return !body.includes('"pass"') && !body.includes('"user"');
  })());

  const authFetch = async (u, o) => (((o && o.method) || 'GET') === 'GET' ? resp(403) : resp(201));
  const authRun = await M.syncLibrary(cfg, fakeStore, authFetch);
  check('同步 403 → reason=auth、文案「账号或密码不对」',
    authRun.ok === false && authRun.reason === 'auth' && M.syncErrorText('auth') === '账号或密码不对。');

  const netFetch = async () => { throw new Error('network down'); };
  const netRun = await M.syncLibrary(cfg, fakeStore, netFetch);
  check('网络异常 → reason=network、文案「连不上服务器」',
    netRun.ok === false && netRun.reason === 'network' && M.syncErrorText('network').indexOf('连不上服务器') === 0);

  // store.replace：合并结果可写回、schema 2、走队列
  chrome.storage.local._store = {};
  const rep = await S.replace({
    schema: 2,
    groups: [G(BEEN, '已去', 0, true), G(WANT, '想去', 1, true), G('g-x', '出片', 5)],
    items: [IT('r1', '甲', 200, 'g-x')],
    tombstones: [{ kind: 'item', key: 'gone', deletedAt: Date.now() - 1000 }],
  });
  const rl = await S.read();
  check('store.replace：整库写回 + 保留组与墓碑', rep.ok === true && rl.schema === 2 &&
    rl.items[0].groupId === 'g-x' && rl.tombstones.some(t => t.key === 'gone'));
  check('store.replace：结构非法拒写', (await S.replace({ schema: 2, groups: 'x', items: [] })).reason === 'schema');

  // 静态：UI 入口与权限（不读 DOM，只读源文件文本）
  const html = fs.readFileSync(path.join(env.SRC, 'popup/popup.html'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(env.SRC, 'manifest.json'), 'utf8'));
  check('UI：收藏页同步按钮在导出左边、设置页有密码字段',
    /id="favSync"[\s\S]{0,120}id="favExport"/.test(html) &&
    /<input type="password" id="syncPass"/.test(html) &&
    /id="syncSave"/.test(html) && /id="syncTest"/.test(html));
  check('权限：optional_host_permissions 含 http/https，host_permissions 无全量通配',
    Array.isArray(manifest.optional_host_permissions) &&
    manifest.optional_host_permissions.indexOf('https://*/*') >= 0 &&
    manifest.optional_host_permissions.indexOf('http://*/*') >= 0 &&
    !(manifest.host_permissions || []).some(h => h === 'https://*/*' || h === 'http://*/*'));

  // 静态：同步按钮 busy 态与权限申请路径（DOM 行为在真实弹窗验证）
  const popupJs = fs.readFileSync(path.join(env.SRC, 'popup/popup.js'), 'utf8');
  check('UI 源码：busy 恢复、aria-busy、权限申请、凭据键',
    popupJs.indexOf("setAttribute('aria-busy', 'true')") >= 0 &&
    popupJs.indexOf("'同步中…'") >= 0 &&
    popupJs.indexOf("textContent = 'WebDAV 同步'") >= 0 &&
    popupJs.indexOf("origins: [origin + '/*']") >= 0 &&
    popupJs.indexOf("'hmp:webdav'") >= 0);
  check('UI 源码：未配置引导 + http 明文警告 + 完成文案',
    popupJs.indexOf('请先在「开放时间 → WebDAV 同步」配置') >= 0 &&
    popupJs.indexOf('/^http:\\/\\//i') >= 0 &&
    popupJs.indexOf("'已同步：新增 '") >= 0 &&
    popupJs.indexOf('5000') >= 0);

  finish();
})();
