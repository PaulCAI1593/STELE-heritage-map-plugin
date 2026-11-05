// tests/manifest_tests.js
// 条目 2：删掉冗余的 host_permissions 站点域（stele.geogv.org）。
// 注入权限由 content_scripts.matches 授权；扩展自身 fetch 只去两家地图域。
// 运行: node tests/manifest_tests.js
'use strict';
const fs = require('fs');
const path = require('path');
const env = require('./_env');
const { check, finish } = env.makeChecker('manifest');

const M = JSON.parse(fs.readFileSync(path.join(env.SRC, 'manifest.json'), 'utf8'));
const HP = M.host_permissions || [];

// #04 起 host_permissions = 两家地图域 + 两条更新链路（api.github.com / cdn.jsdelivr.net）
const ALLOWED_HP = [
  'https://restapi.amap.com/*',
  'https://api.map.baidu.com/*',
  'https://api.github.com/*',
  'https://cdn.jsdelivr.net/*',
];
check('host_permissions 只含地图域与两条更新链路（负例：stele 站点域已删）',
  HP.every(h => ALLOWED_HP.indexOf(h) >= 0) && !HP.some(h => h.indexOf('stele.geogv.org') >= 0),
  JSON.stringify(HP));
check('host_permissions 未新增清单之外的域', HP.length === ALLOWED_HP.length, JSON.stringify(HP));
check('高德域仍在 host_permissions', HP.indexOf('https://restapi.amap.com/*') >= 0, JSON.stringify(HP));
check('百度域仍在 host_permissions', HP.indexOf('https://api.map.baidu.com/*') >= 0, JSON.stringify(HP));

const CS = (M.content_scripts || [])[0] || {};
const matches = CS.matches || [];
check('注入授权仍由 content_scripts.matches 提供',
  matches.indexOf('*://stele.geogv.org/zhcn/*') >= 0, JSON.stringify(matches));
check('content_scripts.matches 未被本次改动删除', matches.length === 1, JSON.stringify(matches));

// 手工核对：扩展源码里 fetch 只出现两家地图域（与 host_permissions 对齐）
function walk(dir, out) {
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out); else if (/\.js$/.test(n)) out.push(p);
  }
  return out;
}
const files = walk(env.SRC, []);
const hosts = new Set();
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const re = /https?:\/\/([a-z0-9.-]+)/gi;
  let m;
  while ((m = re.exec(src))) hosts.add(m[1].toLowerCase());
}
// 允许：两家地图域 + 用户可见的第三方站点链接（搜索链接/申请 Key 的网页）
const fetchHosts = ['restapi.amap.com', 'api.map.baidu.com'];
check('源码中出现的地图 API 域都在 host_permissions 内',
  fetchHosts.every(h => HP.some(x => x.indexOf(h) >= 0)), [...hosts].join(','));
check('host_permissions 不含 stele.geogv.org 之外的站点域',
  !HP.some(h => h.indexOf('stele.geogv.org') >= 0), JSON.stringify(HP));

finish();
