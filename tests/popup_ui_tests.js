// tests/popup_ui_tests.js
// #04 弹窗落地：脚本顺序（D-028）、双主题、版本一致、更新解析/隐私、错误归类不直出原始码。
// 说明：本套只做静态与纯函数断言（不依赖网络、不依赖真实 Chrome）。
'use strict';
const fs = require('fs');
const path = require('path');
const { makeChecker } = require('./_env');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const html = fs.readFileSync(path.join(SRC, 'popup', 'popup.html'), 'utf8');
const css = fs.readFileSync(path.join(SRC, 'popup', 'popup.css'), 'utf8');
const js = fs.readFileSync(path.join(SRC, 'popup', 'popup.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const { check, finish } = makeChecker('popup-ui');

// ---------------- 1. D-028：http.js 必须先于 apis ----------------
console.log('\n=== D-028：popup 里 http.js 的加载顺序 ===');
{
  const iHttp = html.indexOf('../content/http.js');
  const iAmap = html.indexOf('../content/apis/amap.js');
  const iBaidu = html.indexOf('../content/apis/baidu.js');
  check('popup.html 引入了 ../content/http.js', iHttp >= 0);
  check('http.js 在 amap.js 之前', iHttp >= 0 && iAmap > iHttp);
  check('http.js 在 baidu.js 之前', iHttp >= 0 && iBaidu > iHttp);
  check('popup.js 在 apis 之后加载', html.indexOf('popup.js') > iBaidu);
}

// ---------------- 2. 结构 / 六态挂点 / 双主题开关 ----------------
console.log('\n=== 结构：状态带、行内测试、主题开关、页脚 ===');
{
  check('有 data-popup-state 挂点', html.includes('data-popup-state='));
  check('六态名齐全（html+js 内声明）',
    ['empty', 'ready', 'testing', 'test-ok', 'test-fail', 'dirty'].every(s => js.includes("'" + s + "'")));
  check('有常驻状态带 #band', html.includes('id="band"'));
  check('有未保存提示元素 #dirtyHint（旧断言兼容）', html.includes('id="dirtyHint"'));
  check('提示文案含「未保存的修改」与「才会生效」',
    /未保存的修改/.test(html) && /才会生效/.test(html));
  check('两个 Key 各有行内测试按钮',
    html.includes('data-test="amap"') && html.includes('data-test="baidu"'));
  check('两个 Key 各有行内结果行',
    html.includes('id="resAmap"') && html.includes('id="resBaidu"'));
  check('主题开关 role=group + aria-pressed',
    /role="group" aria-label="主题"/.test(html) && html.includes('aria-pressed="true"'));
  check('HTML 默认主题写死 glass（防闪）', /<html[^>]*data-theme="glass"/.test(html));
  check('CSS 有两套主题变量块',
    css.includes('[data-theme="paper"]') && css.includes('[data-theme="glass"]'));
  check('CSS 主题选择器不挂 :root', !/:root\[data-theme=/.test(css));
  check('页脚免责声明定稿', html.includes('开放信息仅供参考，请以现场公告为准。'));
  check('页脚版本来自 manifest（不写死）',
    html.includes('id="ver"') && /getManifest\(\)\.version/.test(js));
}

// ---------------- 3. 版本三处一致 ----------------
console.log('\n=== 版本 0.4.0 同步 ===');
{
  check('manifest.json 版本 = 0.4.0', manifest.version === '0.4.0', manifest.version);
  check('package.json 版本 = 0.4.0', pkg.version === '0.4.0', pkg.version);
  check('popup 显示版本读 manifest（无硬编码 v0.3）', !/v0\.3\.10/.test(html + js));
}

// ---------------- 4. 权限：只加两条更新链路域名 ----------------
console.log('\n=== host_permissions ===');
{
  const hp = manifest.host_permissions || [];
  check('保留高德/百度权限',
    hp.includes('https://restapi.amap.com/*') && hp.includes('https://api.map.baidu.com/*'));
  check('新增 api.github.com 权限', hp.includes('https://api.github.com/*'));
  check('新增 cdn.jsdelivr.net 权限', hp.includes('https://cdn.jsdelivr.net/*'));
  check('没有再放站点域（#01 的收敛保持）', !hp.includes('*://stele.geogv.org/*'));
}

// ---------------- 5. 纯函数：版本比较 / 更新解析 / 错误归类 ----------------
console.log('\n=== 纯函数（在最小 DOM 桩里加载 popup.js） ===');
function loadPopup() {
  const root = {
    attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] || null; }
  };
  global.window = global;
  global.HMP = {};
  global.document = {
    documentElement: root,
    querySelectorAll: () => [],
    getElementById: () => null,
    addEventListener: () => {},
    createElement: () => ({ appendChild() {}, removeAttribute() {}, setAttribute() {}, remove() {} }),
    body: { appendChild() {} }
  };
  global.chrome = {
    storage: { local: { get: (k, cb) => cb({}), set: (o, cb) => cb && cb(), remove: (k, cb) => cb && cb() } },
    runtime: { getManifest: () => ({ version: '0.4.0' }) },
    tabs: { create() {} }
  };
  (0, eval)(js);
  return global.HMP.popup;
}

const popup = loadPopup();
{
  const { compare } = popup.version;
  check('0.5.0 > 0.4.0', compare('v0.5.0', '0.4.0') === 1);
  check('0.4.0 == v0.4.0', compare('0.4.0', 'v0.4.0') === 0);
  check('0.4.0 < 0.10.0（按数字而非字典序）', compare('0.4.0', '0.10.0') === -1);
  check('预发布 < 正式版', compare('0.5.0-beta', '0.5.0') === -1);
  check('本地领先时返回 -1', compare('0.4.0', 'v0.5.0') === -1);

  const a = popup.version.parse({ tag_name: 'v0.5.0', html_url: 'https://example/x' });
  check('API 响应解析出 tag/version/url', a.tag === 'v0.5.0' && a.version === '0.5.0' && !!a.url && a.viaMirror === false);
  const b = popup.version.parse({ version: '0.5.1' });
  check('镜像 manifest 解析出 tag/version 且标 viaMirror', b.tag === 'v0.5.1' && b.version === '0.5.1' && b.viaMirror === true);
  check('空响应解析为 null', popup.version.parse(null) === null);

  check('主题默认 glass', popup.theme.default === 'glass' && popup.theme.normalize(undefined) === 'glass');
  check('主题只认 paper/glass', popup.theme.normalize('paper') === 'paper' && popup.theme.normalize('dark') === 'glass');
  check('主题存储键 hmpTheme', popup.theme.KEY === 'hmpTheme');

  const ttlH = popup.update.ttl / 3600000;
  check('更新缓存 24h', ttlH === 24, String(ttlH));
  check('主链路 URL 指向 releases/latest', popup.update.api.endsWith('/releases/latest'));
  check('兜底镜像指向 jsDelivr 的 manifest.json', popup.update.mirror.endsWith('@main/src/manifest.json'));
  check('下载资产名带 tag', popup.version.asset('v0.5.0') === 'heritage-map-plugin-v0.5.0.zip');
  check('发布页 URL 带 tag', popup.version.page('v0.5.0').endsWith('/releases/tag/v0.5.0'));

  const urls = [popup.update.api, popup.update.mirror, popup.version.asset('v0.5.0')].join(' ');
  check('更新链路 URL 不含 key/ak 参数', !/[?&](key|ak|token)=/i.test(urls));
}

// ---------------- 6. 错误归类：三类分开、原始码只进 title ----------------
console.log('\n=== 错误归类（三类）+ 原始码不直出 ===');
{
  const c = popup.test.classify;
  const inv = c('amap', new Error('Key 无效（INVALID_USER_KEY），请检查'));
  check('高德 INVALID_USER_KEY → invalid', inv.kind === 'invalid', inv.kind);
  check('invalid 正文是中英短句、不含原始码', /Key 无效/.test(inv.text) && !/INVALID_USER_KEY/.test(inv.text), inv.text);
  check('invalid 原始码保留在 raw（去 title 用）', /INVALID_USER_KEY/.test(inv.raw));

  const nos = c('baidu', new Error('该 API Key 未开通「地点检索」服务。请到控制台改用服务端 Key（status=240）'));
  check('百度 240 → unopened', nos.kind === 'unopened', nos.kind);
  check('unopened 复用原始说明（地点检索）', /地点检索/.test(nos.text), nos.text);

  const to = c('baidu', new Error('请求超时（已重试 1 次）'));
  check('超时 → network', to.kind === 'network', to.kind);
  check('超时文案是中文短句', /超时/.test(to.text), to.text);

  const nf = c('amap', new Error('Failed to fetch'));
  check('网络失败 → network', nf.kind === 'network', nf.kind);

  check('可见正文不写原始码（源码里无 textContent = raw）', !/textContent\s*=\s*[^;]*\braw\b/.test(js));
  check('原始码只通过 title 属性暴露', /el\.title = raw/.test(js));
  check('不承诺自动安装/自动更新', !/自动安装|自动下载|自动更新/.test(js));
  check('更新失败文案是中文短句', /无法检查更新 · 请检查网络后重试/.test(js));
}

// ---------------- 8. 行内测试：不重置另一家的结果 ----------------
console.log('\n=== 行内测试保留另一家结果 ===');
{
  const body = (() => {
    const i = js.indexOf('async function testOne(provider)');
    if (i < 0) return '';
    const j = js.indexOf('\n  }', i);
    return js.slice(i, j < 0 ? js.length : j);
  })();
  check('testOne 里先调 resetResOne(provider)（只清本家）', /resetResOne\(provider\)/.test(body));
  check('testOne 不用全局 resetRes()（否则会抹掉另一家结果）', !/resetRes\(\);/.test(body));
  check('resetResOne 会按 provider 取结果行', /function resetResOne\(provider\)[\s\S]{0,80}PROVIDERS\[provider\]\.res/.test(js));
}

finish();
