// tests/background_window_tests.js
// #43：点工具栏图标开独立小窗（440×640），再点聚焦、关窗后重开。
// 做法：桩 chrome.action / chrome.windows / chrome.storage.session，真实执行 service-worker.js，
// 直接调用注册的 onClicked / onRemoved 监听器。
'use strict';
const fs = require('fs');
const path = require('path');
const { makeChecker } = require('./_env');

const { check, finish } = makeChecker('background-window');
const SRC = path.join(__dirname, '..', 'src');
const swSrc = fs.readFileSync(path.join(SRC, 'background', 'service-worker.js'), 'utf8');
const popupJs = fs.readFileSync(path.join(SRC, 'popup', 'popup.js'), 'utf8');
const popupCss = fs.readFileSync(path.join(SRC, 'popup', 'popup.css'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));

function build(opts) {
  const o = opts || {};
  const calls = { create: [], update: [], get: [], sessionSet: [], sessionRemove: [] };
  const listeners = { action: null, removed: [], installed: [], message: null };
  const session = Object.assign({}, o.session || {});

  const chrome = {
    runtime: {
      onInstalled: { addListener(fn) { listeners.installed.push(fn); } },
      onMessage: { addListener(fn) { listeners.message = fn; } },
      getURL: p => 'chrome-extension://test/' + p,
      lastError: undefined,
    },
    action: { onClicked: { addListener(fn) { listeners.action = fn; } } },
    windows: {
      create(args, cb) {
        calls.create.push(args);
        if (cb) cb({ id: 501 });
        return { id: 501 };
      },
      get(id, cb) {
        calls.get.push(id);
        if (o.getThrows) throw new Error('get failed');
        if (id === 42) { if (cb) cb({ id: 42 }); return; }
        chrome.runtime.lastError = { message: 'No window with id: ' + id };
        if (cb) cb(undefined);
        chrome.runtime.lastError = undefined;
      },
      update(id, props) { calls.update.push({ id, props }); },
      onRemoved: { addListener(fn) { listeners.removed.push(fn); } },
    },
    storage: {
      local: {
        get(keys, cb) { if (cb) cb({}); },
        set(obj, cb) { if (cb) cb(); },
        remove(keys, cb) { if (cb) cb(); },
      },
      session: {
        get(keys, cb) {
          const out = {};
          [].concat(keys).forEach(k => { if (Object.prototype.hasOwnProperty.call(session, k)) out[k] = session[k]; });
          if (cb) cb(out);
          return Promise.resolve(out);
        },
        set(obj, cb) { Object.assign(session, obj); calls.sessionSet.push(obj); if (cb) cb(); return Promise.resolve(); },
        remove(keys, cb) {
          [].concat(keys).forEach(k => { delete session[k]; });
          calls.sessionRemove.push(keys);
          if (cb) cb();
          return Promise.resolve();
        },
      },
    },
  };

  global.self = { addEventListener() {} };
  global.chrome = chrome;
  (0, eval)(swSrc);
  return { calls, listeners, session };
}

const KEY = 'hmp:panelWindowId';

console.log('\n=== manifest：默认贴图标弹窗 + 无新增权限 ===');
{
  // #46：用户拍板恢复默认弹窗；点图标出 popup，弹窗内图标按钮可弹出为独立小窗。
  check('#46 manifest 恢复 action.default_popup', !!manifest.action && manifest.action.default_popup === 'popup/popup.html',
    'default_popup=' + (manifest.action && manifest.action.default_popup));
  check('#43 权限只有 storage（无 tabs/windows）',
    JSON.stringify(manifest.permissions) === JSON.stringify(['storage']),
    'permissions=' + JSON.stringify(manifest.permissions));
  check('#43 background service_worker 已注册',
    !!(manifest.background && manifest.background.service_worker));
}

console.log('\n=== 无窗口 id → create 一次，参数 440×640 popup ===');
{
  const H = build();
  H.listeners.action();
  check('#43 无 id：create 一次', H.calls.create.length === 1, 'create=' + H.calls.create.length);
  const a = H.calls.create[0] || {};
  check('#43 create 参数：width 440 / height 640 / type popup',
    a.width === 440 && a.height === 640 && a.type === 'popup',
    JSON.stringify(a));
  check('#43 create url 指向 popup.html?window=1',
    typeof a.url === 'string' && a.url.indexOf('popup/popup.html?window=1') !== -1,
    'url=' + a.url);
  check('#43 create 后把新窗口 id 记进 storage.session',
    H.session[KEY] === 501, KEY + '=' + H.session[KEY]);
}

console.log('\n=== 有窗口 id 且 get 成功 → 只聚焦、不 create ===');
{
  const H = build({ session: { [KEY]: 42 } });
  H.listeners.action();
  check('#43 有 id：先 get(42)', H.calls.get.length === 1 && H.calls.get[0] === 42,
    'get=' + JSON.stringify(H.calls.get));
  check('#43 有 id：update(focused:true) 一次、不 create',
    H.calls.update.length === 1 && H.calls.update[0].id === 42 &&
    H.calls.update[0].props && H.calls.update[0].props.focused === true &&
    H.calls.create.length === 0,
    'update=' + JSON.stringify(H.calls.update) + ' create=' + H.calls.create.length);
}

console.log('\n=== get 抛错 → 退回 create ===');
{
  const H = build({ session: { [KEY]: 42 }, getThrows: true });
  H.listeners.action();
  check('#43 get 抛错：create 一次', H.calls.create.length === 1,
    'create=' + H.calls.create.length + ' update=' + H.calls.update.length);
}

console.log('\n=== 窗口被关（onRemoved）→ 清 id，下次点击重新 create ===');
{
  const H = build();
  H.listeners.action();
  check('#43 首次点击：create 1 次并记住 id', H.calls.create.length === 1 && H.session[KEY] === 501);
  H.listeners.removed.forEach(fn => fn(501));
  check('#43 onRemoved 清掉同 id', H.session[KEY] === undefined, KEY + '=' + H.session[KEY]);
  H.listeners.action();
  check('#43 关窗后再点击：再 create 一次（共 2 次）', H.calls.create.length === 2,
    'create=' + H.calls.create.length);
}

console.log('\n=== ?window=1 宽度出口（静态） ===');
{
  check('#43 popup.js 检测 window=1 并设 data-hmp-window',
    /window=1/.test(popupJs) && /dataset\.hmpWindow\s*=\s*'1'/.test(popupJs),
    'popup.js window mode missing');
  check('#43 popup.css 仅 data-hmp-window=1 时 width:100%',
    /html\[data-hmp-window="1"\][^{]*\{[^}]*width:\s*100%/.test(popupCss),
    'popup.css window rule missing');
  check('#43 普通弹窗 400 固定宽规则仍在',
    /html,body\{width:var\(--hmp-popup-w,400px\)/.test(popupCss),
    'popup.css base width changed');
}

finish();
