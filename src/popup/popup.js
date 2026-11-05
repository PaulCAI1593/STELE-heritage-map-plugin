// popup/popup.js
// 扩展工具栏弹窗（配置面板）：主题、状态带、行内 Key 测试、页脚版本与检测更新。
// 结构与文案口径见 _shared/tasks/04-弹窗落地-方向D.md；
// 依赖顺序：http.js → apis/amap.js、apis/baidu.js → decision-log.js → popup.js（D-028）。

(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  // ---------------- 常量 ----------------
  const THEME_KEY = 'hmpTheme';
  const DEFAULT_THEME = 'glass';
  const THEMES = ['paper', 'glass'];

  const UPDATE_REPO = 'PaulCAI1593/STELE-heritage-map-plugin';
  const UPDATE_API = 'https://api.github.com/repos/' + UPDATE_REPO + '/releases/latest';
  // 兜底镜像：只读 main 分支的 manifest.json 取 version（jsDelivr，国内有节点）
  const UPDATE_MIRROR = 'https://cdn.jsdelivr.net/gh/' + UPDATE_REPO + '@main/src/manifest.json';
  const UPDATE_TIMEOUT_MS = 2500;
  const UPDATE_TTL_MS = 24 * 60 * 60 * 1000;
  const UPDATE_CACHE_KEY = 'hmpUpdateCache';
  // 国内可用代理直出 release 资产；GitHub 直连会 302 到 objects.githubusercontent.com
  const DOWNLOAD_BASE = 'https://ghfast.top/https://github.com/' + UPDATE_REPO + '/releases/download/';
  const DOWNLOAD_ASSET = tag => 'heritage-map-plugin-' + tag + '.zip';
  const RELEASE_PAGE = tag => 'https://github.com/' + UPDATE_REPO + '/releases/tag/' + tag;

  // "已保存"的快照。用来判断输入框里有没有改了但没点保存的内容——
  // 这是"我填了百度 Key、测试也通过了，怎么还是高德的结果"的常见原因：
  // 「测试」测的是输入框里的值，只有点「保存」才会写进 chrome.storage。
  let savedSnapshot = null;

  // 测试/导出等瞬时态
  let currentState = 'empty';
  let lastTest = null;          // null | 'ok' | 'fail'
  let lastTestInfo = null;      // {ok:[], fail:[{label,text}]}
  let busy = false;

  // ---------------- 主题 ----------------
  function normalizeTheme(t) {
    return THEMES.indexOf(t) >= 0 ? t : DEFAULT_THEME;
  }

  function applyTheme(theme, persist) {
    const t = normalizeTheme(theme);
    document.documentElement.setAttribute('data-theme', t);
    document.querySelectorAll('.seg-b').forEach(btn => {
      btn.setAttribute('aria-pressed', String(btn.getAttribute('data-theme-set') === t));
    });
    if (persist) {
      try { chrome.storage.local.set({ [THEME_KEY]: t }); } catch (e) { /* 存不了也不影响当次 */ }
    }
    return t;
  }

  function getTheme() {
    return normalizeTheme(document.documentElement.getAttribute('data-theme'));
  }

  function initTheme() {
    // 防闪：HTML 上已写死 data-theme="glass"（默认），这里只覆盖用户选过的主题。
    let stored = null;
    try {
      // 同步读取不可用，先按默认渲染；读到后再切（同帧内完成，用户看不到中间态）
      chrome.storage.local.get([THEME_KEY], items => {
        stored = items && items[THEME_KEY];
        if (stored) applyTheme(stored, false);
      });
    } catch (e) { /* 忽略 */ }
    applyTheme(getTheme(), false);
  }

  // ---------------- 状态机 ----------------
  const STATE_TEXT = {
    empty: {
      band: 'b-idle', icon: 'info',
      title: '尚未配置',
      desc: '先配高德 Key 即可使用；百度 Key 是备份，可以跳过。'
    },
    ready: {
      band: 'b-info', icon: 'info',
      title: '已填写 Key · 尚未测试',
      desc: '测试会先保存当前填写内容，再发起真实请求。'
    },
    testing: {
      band: 'b-prog', icon: 'spin',
      title: '正在测试 Key…',
      desc: '向高德、百度各发一次最简请求。'
    },
    'test-ok': {
      band: 'b-ok', icon: 'ok',
      title: 'Key 可用',
      desc: '配置已生效，打开遗产地图详情页即可看到开放信息。'
    },
    'test-fail': {
      band: 'b-err', icon: 'err',
      title: '测试失败',
      desc: '按提示检查 Key 或网络后重试。'
    },
    dirty: {
      band: 'b-warn', icon: 'warn',
      title: '有未保存的修改',
      desc: '点「保存」后才会生效（「测试」会自动先保存）。'
    },
    exporting: {
      band: 'b-prog', icon: 'spin',
      title: '正在导出决策…',
      desc: '导出内容已清洗，不含任何 Key。'
    }
  };

  const ICONS = {
    info: '<circle cx="8" cy="8" r="5.6"></circle><path d="M8 5.2v3.4"></path>',
    ok: '<path d="M3 8.5 6.3 12 13 4.6"></path>',
    err: '<path d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8"></path>',
    warn: '<path d="M8 2.4 14.6 13.4H1.4Z"></path><path d="M8 6.6v3M8 11.4h.01"></path>',
    spin: '<circle class="spin" cx="8" cy="8" r="5.6" stroke-dasharray="10 26"></circle>'
  };

  const BAND_ICON = { "b-idle": "info", "b-info": "info", "b-ok": "ok", "b-err": "err", "b-warn": "warn", "b-prog": "spin" };

  function setBand(kind, title, desc, meta) {
    const band = $("band");
    if (!band) return;
    band.className = "band " + kind;
    band.setAttribute("role", kind === "b-err" ? "alert" : "status");
    const icon = band.querySelector(".ic");
    if (icon) icon.innerHTML = ICONS[BAND_ICON[kind] || "info"] || ICONS.info;
    const t = $("bandTitle");
    if (t) {
      // 标题 + 一句描述：结构固定（描述总是 .band-b），避免重复调用时嵌套错位
      t.textContent = title;
      const d = document.createElement("span");
      d.className = "band-b";
      d.id = "bandDesc";
      d.textContent = desc || "";
      t.appendChild(d);
    }
    if (typeof meta === "string" && $("bandMeta")) $("bandMeta").textContent = meta;
  }

  function computeState() {
    if (busy) return 'testing';
    if (lastTest === 'ok') return 'test-ok';
    if (lastTest === 'fail') return 'test-fail';
    if (isDirty()) return 'dirty';
    if (!currentKey('amapKey') && !currentKey('baiduAk')) return 'empty';
    return 'ready';
  }

  /** 渲染六态（不传则按当前表单/测试结果推导） */
  function renderState(state) {
    currentState = state || computeState();
    const root = $('popup');
    if (root) root.setAttribute('data-popup-state', currentState);

    const conf = STATE_TEXT[currentState] || STATE_TEXT.empty;
    let title = conf.title;
    let desc = conf.desc;

    if (currentState === 'test-ok' && lastTestInfo && lastTestInfo.ok.length) {
      title = lastTestInfo.ok.length >= 2 ? '2 个 Key 均可用' : '1 个 Key 可用';
      desc = lastTestInfo.ok.map(x => x.label + '：' + x.text).join(' · ');
    }
    if (currentState === 'test-fail' && lastTestInfo && lastTestInfo.fail.length) {
      title = '测试失败 · ' + lastTestInfo.fail[0].label;
      desc = lastTestInfo.fail[0].short || lastTestInfo.fail[0].text;
    }
    if (currentState === 'ready') {
      const n = (currentKey('amapKey') ? 1 : 0) + (currentKey('baiduAk') ? 1 : 0);
      title = '已填写 ' + n + ' 个 Key · 尚未测试';
    }
    setBand(conf.band, title, desc);
    updateKeyStates();
    return currentState;
  }

  // ---------------- chrome.storage 读写 ----------------
  function storageGet(keys, cb) {
    try { chrome.storage.local.get(keys, cb); } catch (e) { cb({}); }
  }

  function storageSet(obj, cb) {
    try { chrome.storage.local.set(obj, cb || function () {}); } catch (e) { if (cb) cb(); }
  }

  function load() {
    storageGet(['amapKey', 'baiduAk', 'defaultProvider', 'strategyMode', 'enabled'], items => {
      if ($('amapKey')) $('amapKey').value = items.amapKey || '';
      if ($('baiduAk')) $('baiduAk').value = items.baiduAk || '';
      if ($('defaultProvider')) $('defaultProvider').value = items.defaultProvider || 'amap';
      if ($('strategyMode')) $('strategyMode').value = items.strategyMode || 'combine';
      if ($('enabled')) $('enabled').checked = items.enabled !== false;
      savedSnapshot = readForm();
      renderState(computeState());
    });
    refreshCacheInfo();
    initVersion();
    restoreUpdateCache();
  }

  /** 读取当前表单值（与 save() 写入的结构一致） */
  function readForm() {
    return {
      amapKey: ($('amapKey') ? $('amapKey').value : '').trim(),
      baiduAk: ($('baiduAk') ? $('baiduAk').value : '').trim(),
      defaultProvider: $('defaultProvider') ? $('defaultProvider').value : 'amap',
      strategyMode: $('strategyMode') ? $('strategyMode').value : 'combine',
      enabled: $('enabled') ? $('enabled').checked : true
    };
  }

  function currentKey(id) {
    const el = $(id);
    return el ? String(el.value || '').trim() : '';
  }

  function isDirty() {
    if (!savedSnapshot) return false;
    const now = readForm();
    return Object.keys(now).some(k => now[k] !== savedSnapshot[k]);
  }

  function tailOf(key) {
    return key && key.length > 4 ? key.slice(-4) : (key || '');
  }

  function updateKeyStates() {
    [['amapKey', 'amapState'], ['baiduAk', 'baiduState']].forEach(pair => {
      const el = $(pair[1]);
      if (!el) return;
      const now = currentKey(pair[0]);
      const saved = savedSnapshot ? String(savedSnapshot[pair[0]] || '') : '';
      if (!now && !saved) {
        el.textContent = '未配置';
        el.classList.remove('is-dirty');
      } else if (now && saved && now === saved) {
        el.textContent = '已保存 · 尾号 ' + tailOf(now);
        el.classList.remove('is-dirty');
      } else if (now) {
        el.textContent = saved ? '已修改 · 未保存' : '未保存';
        el.classList.add('is-dirty');
      } else {
        el.textContent = '已修改 · 未保存';
        el.classList.add('is-dirty');
      }
    });
  }

  function updateDirtyHint() {
    updateKeyStates();
    if (busy) return;              // 测试中不抢状态带
    renderState(computeState());
  }

  /** 保存并返回 Promise（测试前需要先落盘，所以得能 await） */
  function save(opts) {
    const payload = readForm();
    return new Promise(resolve => {
      storageSet(payload, () => {
        savedSnapshot = payload;
        updateDirtyHint();
        if (!opts || !opts.silent) {
          lastTest = null; lastTestInfo = null;
          renderState(computeState());
          flashBand('b-ok', '已保存', '刷新遗产地图详情页即可生效。');
        }
        resolve();
      });
    });
  }

  /** 临时状态带（保存/清缓存/导出后的反馈），1.8s 后回到推导态 */
  let flashTimer = null;
  function flashBand(kind, title, desc) {
    setBand(kind, title, desc);
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => renderState(computeState()), 1800);
  }

  function clearCache() {
    storageGet(null, items => {
      const keys = Object.keys(items).filter(k => k.startsWith('hmp:cache:'));
      if (keys.length === 0) {
        flashBand('b-ok', '缓存已为空', '无需清除。');
        return;
      }
      try {
        chrome.storage.local.remove(keys, () => {
          flashBand('b-ok', '已清除 ' + keys.length + ' 条缓存', '刷新页面后生效。');
          refreshCacheInfo();
        });
      } catch (e) {
        flashBand('b-err', '清除缓存失败', '请重试。');
      }
    });
  }

  /**
   * 导出最近 20 条匹配决策（JSON）。
   * 导出内容不含 API Key：decision-log 写入与导出时都会清洗（去 key/ak 字段、URL 参数打码）。
   */
  function exportDecisions() {
    const log = window.HMP && window.HMP.decisionLog;
    if (!log) {
      flashBand('b-err', '导出失败', '决策日志模块未加载。');
      return;
    }
    const btn = $('exportLog');
    if (btn) { btn.disabled = true; btn.textContent = '导出中…'; }
    renderState('exporting');
    log.exportJSON().then(text => {
      let n = 0;
      try { n = JSON.parse(text).length; } catch (e) { n = 0; }
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const blob = new Blob([text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'hmp-decisions-' + stamp + '.json';
        document.body.appendChild(a);
        a.click();
        if (a.remove) a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        flashBand('b-ok', n ? '已导出 ' + n + ' 条匹配决策' : '暂无匹配决策',
          n ? '文件已下载。' : '已导出空列表 []。');
      } catch (e) {
        flashBand('b-err', '导出失败', '浏览器拦截了下载，请重试。');
      }
    }).finally(() => {
      if (btn) { btn.disabled = false; btn.textContent = '导出决策'; }
      renderState(computeState());
    });
  }

  /** 状态带右侧：缓存条数（用户判断"是不是旧缓存"的唯一入口） */
  function refreshCacheInfo() {
    storageGet(null, items => {
      const all = Object.keys(items).filter(k => k.startsWith('hmp:cache:'));
      const el = $('bandMeta');
      if (el) el.textContent = all.length ? '缓存 ' + all.length + ' 条' : '当前无缓存';
    });
  }

  // ---------------- Key 测试（行内） ----------------
  // 复用 content/apis/*.js：测试走的就是真实请求路径与真实报错提示。
  async function testAmap(key) {
    const pois = await window.HMP.apis.amap.search({ key, name: '故宫', region: '北京市' });
    if (!pois.length) return { text: '可用（未返回结果，Key 有效）', count: 0 };
    const p = pois[0];
    const hasBiz = (p.opentimeToday || p.opentimeWeek) ? '，含开放时间' : '';
    return { text: '可用，返回 ' + pois.length + ' 条' + hasBiz, count: pois.length };
  }

  async function testBaidu(ak) {
    const rs = await window.HMP.apis.baidu.search({ ak, name: '故宫', region: '北京市' });
    if (!rs.length) return { text: '可用（未返回结果，Key 有效）', count: 0 };
    const r = rs[0];
    const hasBiz = (r.shopHours || r.price) ? '，含营业时间/价格' : '';
    return { text: '可用，返回 ' + rs.length + ' 条' + hasBiz, count: rs.length };
  }

  const PROVIDERS = {
    amap: { label: '高德地图', input: 'amapKey', res: 'resAmap', btn: 'testAmap' },
    baidu: { label: '百度地图', input: 'baiduAk', res: 'resBaidu', btn: 'testBaidu' }
  };

  /**
   * 错误归类：① Key 无效 ② 未开通服务 ③ 网络/超时。
   * 可见正文只放中文短句；原始状态码只进 title（D-031）。
   */
  function classifyError(provider, err) {
    const raw = String((err && (err.message || err)) || '');
    const label = PROVIDERS[provider].label;
    const isTimeout = /超时|timeout|timed out/i.test(raw);
    const isInvalid = /INVALID_USER_KEY|INVALID_USER_SCODE|USER_KEY_PLATFORM_ERROR|Key 无效|不是「Web服务API」|AK 校验|status\s*[=:]\s*(5|200|3)\b/i.test(raw);
    const isNoService = /SERVICE_NOT_AVAILABLE|未开通|地点检索|status\s*[=:]\s*(240|250)\b/i.test(raw);
    if (isTimeout) return { kind: 'network', text: label + '：地图接口响应超时，请稍后重试。', raw };
    if (isNoService) {
      // 百度 240 的原文最具体，直接复用（任务书要求）
      const detail = /未开通|地点检索/.test(raw) ? raw : '该 Key 未开通「地点检索」服务。';
      return { kind: 'unopened', text: label + '：' + detail, raw };
    }
    if (isInvalid) {
      const tip = provider === 'amap'
        ? 'Key 无效——请确认复制完整，且类型是「Web 服务 API」。'
        : 'Key 不存在或非法——请确认复制的是「访问应用（AK）」。';
      return { kind: 'invalid', text: label + '：' + tip, raw };
    }
    if (/HTTP\s*\d{3}|Failed to fetch|NetworkError|network/i.test(raw)) {
      return { kind: 'network', text: label + '：网络请求失败，请检查网络后重试。', raw };
    }
    return { kind: 'network', text: label + '：请求未成功，请稍后重试。', raw };
  }

  function setRes(provider, kind, text, raw) {
    const id = PROVIDERS[provider].res;
    const el = $(id);
    if (!el) return;
    el.setAttribute('data-res', kind);
    el.className = 'res res-' + kind;
    const ic = kind === 'prog' ? ICONS.spin
      : kind === 'ok' ? ICONS.ok
        : kind === 'fail' ? ICONS.err : ICONS.info;
    el.innerHTML = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + ic + '</svg>' +
      '<span></span>';
    const span = el.querySelector('span');
    if (span) span.textContent = text;
    if (raw) el.title = raw; else el.removeAttribute('title');
    el.hidden = false;
  }

  /** 只重置一家的结果行（行内测试另一家的结果要保留） */
  function resetResOne(provider) {
    const el = $(PROVIDERS[provider].res);
    if (!el) return;
    el.setAttribute('data-res', 'idle');
    el.className = 'res res-idle';
    el.innerHTML = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + ICONS.info + '</svg><span>未测</span>';
    el.removeAttribute('title');
    el.hidden = false;
  }

  function resetRes() {
    ['amap', 'baidu'].forEach(p => {
      const el = $(PROVIDERS[p].res);
      if (!el) return;
      el.setAttribute('data-res', 'idle');
      el.className = 'res res-idle';
      el.innerHTML = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" ' +
        'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + ICONS.info + '</svg><span>未测</span>';
      el.removeAttribute('title');
      el.hidden = false;
    });
  }

  function setBusy(on) {
    busy = !!on;
    ['amap', 'baidu'].forEach(p => {
      const b = $(PROVIDERS[p].btn);
      if (!b) return;
      b.disabled = !!on;
      b.setAttribute('aria-busy', String(!!on));
    });
    if (on) renderState('testing'); else renderState(computeState());
  }

  /** 测一家；返回 {ok, label, text, short} */
  async function runTest(provider) {
    const conf = PROVIDERS[provider];
    const key = currentKey(conf.input);
    if (!key) {
      setRes(provider, 'fail', '未填写（可跳过）');
      return { ok: false, label: conf.label, text: '未填写（可跳过）', short: '未填写' };
    }
    setRes(provider, 'prog', '测试中…');
    try {
      const r = provider === 'amap' ? await testAmap(key) : await testBaidu(key);
      setRes(provider, 'ok', r.text);
      return { ok: true, label: conf.label, text: r.text };
    } catch (e) {
      const cls = classifyError(provider, e);
      setRes(provider, 'fail', cls.text, cls.raw);
      return { ok: false, label: conf.label, text: cls.text, short: cls.text.split('：')[1] || cls.text, kind: cls.kind };
    }
  }

  /** 行内单个「测试」按钮 */
  async function testOne(provider) {
    if (busy) return;
    resetResOne(provider); // 只清本家，另一家已出的结果保留
    setBusy(true);
    // 关键：先把当前填写的内容落盘再测——否则"测试通过、插件里没生效"（插件读 storage）
    const wasDirty = isDirty();
    await save({ silent: true });
    if (wasDirty) {
      // 保留这句给用户看懂机制（同时避免"自动保存"变成静默行为）
      setRes(provider, 'prog', '已先保存当前填写的 Key，再开始测试…');
    }
    const one = await runTest(provider);
    lastTestInfo = { ok: one.ok ? [one] : [], fail: one.ok ? [] : [one] };
    // 另一家若已填且还没有结果，补一句省略提示，不让它显示成失败
    ['amap', 'baidu'].forEach(p => {
      if (p !== provider && currentKey(PROVIDERS[p].input)) {
        const el = $(PROVIDERS[p].res);
        if (el && (el.getAttribute('data-res') === 'idle')) setRes(p, 'idle', '未测 · 点右侧「测试」');
      }
    });
    lastTest = one.ok ? 'ok' : 'fail';
    setBusy(false);
  }

  /** 测试全部已填的 Key（页面上没有独立按钮，保留给测试与后续入口） */
  async function testKeys() {
    if (busy) return;
    resetRes();
    setBusy(true);
    const wasDirty = isDirty();
    await save({ silent: true });
    if (wasDirty) {
      // 这一行会出现在第一家的结果位上，说明机制
      setRes('amap', 'prog', '已先保存当前填写的 Key，再开始测试…');
    }
    const ok = [], fail = [];
    for (const p of ['amap', 'baidu']) {
      const key = currentKey(PROVIDERS[p].input);
      if (!key) continue;
      const r = await runTest(p);
      (r.ok ? ok : fail).push(r);
    }
    lastTestInfo = { ok, fail };
    lastTest = fail.length ? 'fail' : (ok.length ? 'ok' : 'fail');
    if (!ok.length && !fail.length) {
      lastTestInfo = { ok: [], fail: [{ label: '两个 Key', text: '请先填写至少一个 Key。', short: '请先填写至少一个 Key' }] };
    }
    setBusy(false);
  }

  // ---------------- 版本与检测更新 ----------------
  function getVersion() {
    let v = '';
    try { v = chrome.runtime.getManifest().version; } catch (e) { v = ''; }
    return v || '0.0.0';
  }

  function initVersion() {
    const el = $('ver');
    if (el) el.textContent = 'v' + getVersion();
  }

  /** 语义化比较：容忍前缀 v / 预发布；返回 1（a 新）、0（同）、-1（a 旧） */
  function compareVersions(a, b) {
    const norm = s => String(s || '').trim().replace(/^v/i, '');
    const split = s => {
      const m = norm(s).split('-');
      return { nums: m[0].split('.').map(n => parseInt(n, 10) || 0), pre: m[1] || '' };
    };
    const A = split(a), B = split(b);
    const len = Math.max(A.nums.length, B.nums.length);
    for (let i = 0; i < len; i++) {
      const x = A.nums[i] || 0, y = B.nums[i] || 0;
      if (x !== y) return x > y ? 1 : -1;
    }
    if (A.pre === B.pre) return 0;
    if (!A.pre) return 1;    // 正式版 > 预发布
    if (!B.pre) return -1;
    return A.pre > B.pre ? 1 : -1;
  }

  function setUpd(state, msg, links) {
    const wrap = $('updWrap');
    if (wrap) wrap.setAttribute('data-upd', state);
    const btn = $('checkUpdate');
    if (btn) {
      btn.disabled = state === 'checking';
      btn.setAttribute('aria-busy', String(state === 'checking'));
      btn.textContent = state === 'checking' ? '检测中…' : '检测更新';
    }
    const m = $('updMsg');
    if (m) {
      m.textContent = msg || '';
      m.className = 'upd-msg' + (state === 'available' ? ' is-new' : state === 'error' ? ' is-err' : '');
    }
    const box = $('updLinks');
    const hint = $('updInstall');
    if (box) box.hidden = !(links && state === 'available');
    if (hint) hint.hidden = !(links && state === 'available');
    if (links && state === 'available') {
      const tag = links.tag;
      const main = $('dlMain'), src = $('dlSrc');
      if (main) main.href = DOWNLOAD_BASE + tag + '/' + DOWNLOAD_ASSET(tag);
      if (src) src.href = links.url || RELEASE_PAGE(tag);
    }
  }

  function withTimeout(promise, what) {
    const http = window.HMP && window.HMP.http;
    if (http && typeof http.withTimeout === 'function') return http.withTimeout(promise, what);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), UPDATE_TIMEOUT_MS);
      promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
    });
  }

  async function fetchJson(url) {
    const res = await withTimeout(fetch(url, { credentials: 'omit', headers: { Accept: 'application/json' } }), 'update');
    if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '?'));
    return res.json();
  }

  function parseUpdate(remote) {
    // 两家来源统一成 {tag, version, url, viaMirror}
    if (remote && remote.tag_name) {
      return { tag: remote.tag_name, version: remote.tag_name.replace(/^v/i, ''), url: remote.html_url || '', viaMirror: false };
    }
    if (remote && remote.version) {
      return { tag: 'v' + String(remote.version).replace(/^v/i, ''), version: String(remote.version).replace(/^v/i, ''), url: '', viaMirror: true };
    }
    return null;
  }

  function cacheUpdate(payload) {
    try {
      storageSet({ [UPDATE_CACHE_KEY]: Object.assign({ checkedAt: Date.now() }, payload) });
    } catch (e) { /* 忽略 */ }
  }

  function restoreUpdateCache() {
    storageGet([UPDATE_CACHE_KEY], items => {
      const c = items && items[UPDATE_CACHE_KEY];
      if (!c || !c.checkedAt) return;
      const fresh = Date.now() - c.checkedAt < UPDATE_TTL_MS;
      if (fresh && c.state === 'available') {
        setUpd('available', '有新版本 ' + c.tag + (c.viaMirror ? ' · 经镜像检查' : ''), c);
      } else if (fresh && c.state === 'latest') {
        setUpd('latest', '已是最新 · 上游 ' + c.tag + (c.viaMirror ? ' · 经镜像检查' : ''));
      }
    });
  }

  async function checkUpdate(force) {
    setUpd('checking', '正在检测更新…');
    let remote = null;
    try {
      remote = parseUpdate(await fetchJson(UPDATE_API));
    } catch (e) {
      // 主链路失败 → 镜像只读 manifest.json 的 version（任务书 §五 兜底）
      try {
        remote = parseUpdate(await fetchJson(UPDATE_MIRROR));
      } catch (e2) {
        setUpd('error', '无法检查更新 · 请检查网络后重试');
        return { state: 'error' };
      }
    }
    if (!remote) {
      setUpd('error', '无法检查更新 · 请检查网络后重试');
      return { state: 'error' };
    }
    const local = getVersion();
    const cmp = compareVersions(remote.version, local);
    if (cmp > 0) {
      const payload = { state: 'available', tag: remote.tag, url: remote.url, viaMirror: remote.viaMirror };
      setUpd('available', '有新版本 ' + remote.tag + (remote.viaMirror ? ' · 经镜像检查' : ''), payload);
      cacheUpdate(payload);
      return payload;
    }
    const latestPayload = { state: 'latest', tag: remote.tag, viaMirror: remote.viaMirror };
    if (cmp === 0) {
      setUpd('latest', '已是最新 · 上游 ' + remote.tag + (remote.viaMirror ? ' · 经镜像检查' : ''));
    } else {
      setUpd('latest', '已领先上游 ' + remote.tag + (remote.viaMirror ? ' · 经镜像检查' : ''));
    }
    cacheUpdate(latestPayload);
    return latestPayload;
  }

  // ---------------- 绑定 ----------------
  function bind() {
    // 主题
    document.querySelectorAll('.seg-b').forEach(btn => {
      btn.addEventListener('click', () => applyTheme(btn.getAttribute('data-theme-set'), true));
    });

    // 启用开关 / 高级设置 / Key 输入
    ['amapKey', 'baiduAk', 'defaultProvider', 'strategyMode', 'enabled'].forEach(id => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('change', updateDirtyHint);
      if (el.tagName === 'INPUT') el.addEventListener('input', updateDirtyHint);
    });

    // 显示/隐藏 Key
    [['amapKey', 'amapShow'], ['baiduAk', 'baiduShow']].forEach(pair => {
      const btn = $(pair[1]);
      if (!btn) return;
      btn.addEventListener('click', () => {
        const inp = $(pair[0]);
        const show = inp.type === 'password';
        inp.type = show ? 'text' : 'password';
        btn.setAttribute('aria-pressed', String(show));
        btn.textContent = show ? '隐藏' : '显示';
      });
    });

    // 行内测试
    ['amap', 'baidu'].forEach(p => {
      const btn = $(PROVIDERS[p].btn);
      if (btn) btn.addEventListener('click', () => testOne(p));
    });

    if ($('save')) $('save').addEventListener('click', () => save());
    if ($('clearCache')) $('clearCache').addEventListener('click', clearCache);
    if ($('exportLog')) $('exportLog').addEventListener('click', exportDecisions);
    if ($('checkUpdate')) $('checkUpdate').addEventListener('click', () => checkUpdate(true));

    // 更新链接在弹窗内点击时用新标签页打开（不当场导航掉弹窗）
    ['dlMain', 'dlSrc'].forEach(id => {
      const a = $(id);
      if (!a) return;
      a.addEventListener('click', ev => {
        const url = a.getAttribute('href');
        if (!url || url === '#') return;
        ev.preventDefault();
        try { chrome.tabs.create({ url }); } catch (e) { window.open(url, '_blank'); }
      });
    });

    if (!savedSnapshot) resetRes();
  }

  // 供测试与截图 harness 使用的钩子（不改产品行为）
  window.HMP = window.HMP || {};
  window.HMP.popup = {
    theme: { get: getTheme, set: applyTheme, normalize: normalizeTheme, KEY: THEME_KEY, default: DEFAULT_THEME },
    state: { get: () => currentState, render: renderState, compute: computeState },
    version: { get: getVersion, compare: compareVersions, parse: parseUpdate, asset: DOWNLOAD_ASSET, page: RELEASE_PAGE },
    update: { check: checkUpdate, set: setUpd, cacheKey: UPDATE_CACHE_KEY, repo: UPDATE_REPO, api: UPDATE_API, mirror: UPDATE_MIRROR, ttl: UPDATE_TTL_MS },
    test: { one: testOne, all: testKeys, classify: classifyError, providers: PROVIDERS, reset: resetRes },
    form: { read: readForm, isDirty, save },
    refreshCacheInfo
  };

  initTheme();
  document.addEventListener('DOMContentLoaded', () => { bind(); load(); });
})();
