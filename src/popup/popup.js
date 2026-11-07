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
  // #17：Key 测试状态的独立存储键（不塞进 decisionLog / 配置对象）
  const KEY_TEST_KEY = 'hmp:keyTest';

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

  // #72：更新检查先 Gitee 后 GitHub，两边都参与版本比较，取更新的那个；相同取 Gitee。
  // Gitee 走匿名 API（不带任何令牌），仓库公开后可用；资产链接取 releases/latest 里的精确资产。
  const GITEE_REPO = 'Paul1593/stele-heritage-map-plugin';
  const GITEE_API = 'https://gitee.com/api/v5/repos/' + GITEE_REPO + '/releases/latest';
  const GITEE_PAGE = tag => 'https://gitee.com/' + GITEE_REPO + '/releases/tag/' + tag;
  const GITEE_DOWNLOAD = tag => 'https://gitee.com/' + GITEE_REPO + '/releases/download/' + tag + '/' + DOWNLOAD_ASSET(tag);
  const UPDATE_SOURCES = [
    { id: 'gitee', label: 'Gitee', api: GITEE_API, page: GITEE_PAGE, download: GITEE_DOWNLOAD },
    { id: 'github', label: 'GitHub', api: UPDATE_API, page: RELEASE_PAGE, download: tag => DOWNLOAD_BASE + tag + '/' + DOWNLOAD_ASSET(tag) },
  ];

  // "已保存"的快照。用来判断输入框里有没有改了但没点保存的内容——
  // 这是"我填了百度 Key、测试也通过了，怎么还是高德的结果"的常见原因：
  // 「测试」测的是输入框里的值，只有点「保存」才会写进 chrome.storage。
  let savedSnapshot = null;

  // 测试/导出等瞬时态
  let currentState = 'empty';
  let lastTest = null;          // null | 'ok' | 'fail'
  let lastTestInfo = null;      // {ok:[], fail:[{label,text}]}
  // #17：{ amap: {ok, ts, tail} | null, baidu: ... }；tail 只存 Key 后 4 位
  let keyTest = { amap: null, baidu: null };
  let restoredFail = false;     // 重开时只有失败记录：状态带用「上次测试失败」措辞
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
      if (restoredFail) title = '已填写 ' + n + ' 个 Key · 上次测试失败';
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
    storageGet(['amapKey', 'baiduAk', 'defaultProvider', 'strategyMode', 'enabled', KEY_TEST_KEY], items => {
      if ($('amapKey')) $('amapKey').value = items.amapKey || '';
      if ($('baiduAk')) $('baiduAk').value = items.baiduAk || '';
      if ($('defaultProvider')) $('defaultProvider').value = items.defaultProvider || 'amap';
      if ($('strategyMode')) $('strategyMode').value = items.strategyMode || 'combine';
      if ($('enabled')) $('enabled').checked = items.enabled !== false;
      savedSnapshot = readForm();
      // #17：首帧先读回测试状态（用已保存配置比对尾号），再渲染状态带
      const stored = (items && items[KEY_TEST_KEY]) || {};
      keyTest = {
        amap: stored.amap && typeof stored.amap === 'object' ? stored.amap : null,
        baidu: stored.baidu && typeof stored.baidu === 'object' ? stored.baidu : null
      };
      pruneKeyTest(savedSnapshot);
      restoreResStates();
      applyRestoredTestState();
      renderState(computeState());
    });
    refreshCacheInfo();
    loadSyncConfig();
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

  // ---------------- Key 测试状态（#17） ----------------
  function pad2(n) { return String(n).length < 2 ? '0' + n : String(n); }

  /** 当天只显示 HH:MM，跨天显示 MM-DD（本地时间） */
  function formatTestTime(ts, now) {
    const d = new Date(ts);
    const n = now == null ? new Date() : new Date(now);
    if (isNaN(d.getTime())) return '';
    const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
    return sameDay ? pad2(d.getHours()) + ':' + pad2(d.getMinutes()) : pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** 记录是否仍对当前「已保存」的 Key 有效（尾号一致且非空） */
  function keyTestRecord(provider) {
    const rec = keyTest[provider];
    if (!rec || typeof rec.ts !== 'number' || !rec.tail) return null;
    const saved = savedSnapshot ? String(savedSnapshot[PROVIDERS[provider].input] || '') : '';
    if (!saved || tailOf(saved) !== rec.tail) return null;
    return rec;
  }

  function keyTestLabel(rec) {
    return (rec.ok ? '已测试通过 · ' : '上次测试失败 · ') + formatTestTime(rec.ts);
  }

  /** 首帧把持久化结果写回两家结果行（先于状态带，避免闪一下「未测」） */
  function restoreResStates() {
    ['amap', 'baidu'].forEach(p => {
      if (!$(PROVIDERS[p].res)) return;
      const saved = savedSnapshot ? String(savedSnapshot[PROVIDERS[p].input] || '') : '';
      if (!saved) return;                    // 未配置：保留「未测」
      const rec = keyTestRecord(p);
      if (rec) setRes(p, rec.ok ? 'ok' : 'fail', keyTestLabel(rec));
      else setRes(p, 'idle', '已配置 · 未测试');
    });
  }

  /** 重开后按记录回填状态带：有通过记录 → 等同于「上次测试通过」 */
  function applyRestoredTestState() {
    restoredFail = false;
    const ok = [], fail = [];
    ['amap', 'baidu'].forEach(p => {
      const rec = keyTestRecord(p);
      if (!rec) return;
      (rec.ok ? ok : fail).push({ label: PROVIDERS[p].label, text: keyTestLabel(rec) });
    });
    if (ok.length && !isDirty()) {
      lastTest = 'ok';
      lastTestInfo = { ok, fail: [] };
    } else if (fail.length && !isDirty()) {
      lastTest = null;
      lastTestInfo = null;
      restoredFail = true;
    }
  }

  /** 测试结果落盘：{ok, ts, tail}，tail 只取后 4 位；清缓存不会碰它 */
  function persistKeyTest(provider, ok, key) {
    if (!key) return;
    keyTest[provider] = { ok: !!ok, ts: Date.now(), tail: tailOf(key) };
    const out = {};
    ['amap', 'baidu'].forEach(p => { if (keyTest[p]) out[p] = keyTest[p]; });
    storageSet({ [KEY_TEST_KEY]: out });
  }

  /** Key 被改/清空（保存后尾号不一致）⇒ 记录失效；清缓存不清这里 */
  function pruneKeyTest(form) {
    let changed = false;
    ['amap', 'baidu'].forEach(p => {
      const rec = keyTest[p];
      if (!rec) return;
      const key = String(form[PROVIDERS[p].input] || '');
      if (!key || tailOf(key) !== rec.tail) { delete keyTest[p]; changed = true; }
    });
    if (changed) storageSet({ [KEY_TEST_KEY]: Object.assign({}, keyTest) });
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
        pruneKeyTest(payload);            // Key 改了/清空 ⇒ 旧测试记录失效
        if (!opts || !opts.silent) {
          lastTest = null; lastTestInfo = null;
        }
        restoreResStates();
        applyRestoredTestState();
        updateDirtyHint();
        if (!opts || !opts.silent) {
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
    persistKeyTest(provider, one.ok, currentKey(PROVIDERS[provider].input));
    restoredFail = false;
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
      persistKeyTest(p, r.ok, key);
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
      if (main) main.href = links.download || (DOWNLOAD_BASE + tag + '/' + DOWNLOAD_ASSET(tag));
      if (src) {
        src.href = links.url || RELEASE_PAGE(tag);
        // #72：来源可能是 Gitee，链接文案必须跟着来源走；镜像/未知来源回落中性的「发布页」
        src.textContent = links.label ? links.label + ' 发布页' : '发布页';
      }
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

  // #72：Gitee / GitHub / jsDelivr 兜底统一成同一种结构，链接与来源标签跟着走。
  const FALLBACK_SOURCE = {
    id: 'github', label: 'GitHub', page: RELEASE_PAGE,
    download: tag => DOWNLOAD_BASE + tag + '/' + DOWNLOAD_ASSET(tag),
  };

  function parseUpdate(remote, source) {
    // 两家来源统一成 {tag, version, url, download, source, label, viaMirror}
    const src = source || FALLBACK_SOURCE;
    if (remote && remote.tag_name) {
      const tag = String(remote.tag_name);
      return {
        tag,
        version: tag.replace(/^v/i, ''),
        url: remote.html_url || (typeof src.page === 'function' ? src.page(tag) : ''),
        download: resolveDownload(remote, tag, src),
        source: src.id, label: src.label, viaMirror: false,
      };
    }
    if (remote && remote.version) {
      const v = String(remote.version).replace(/^v/i, '');
      return { tag: 'v' + v, version: v, url: '', download: '', source: 'mirror', label: '', viaMirror: true };
    }
    return null;
  }

  /** #72：Gitee release 里还有源码包（v0.6.0.zip / .tar.gz），必须按精确资产名取，
   *  不能取第一个 .zip。匹配不到才退回拼出来的地址。 */
  function resolveDownload(remote, tag, src) {
    const want = DOWNLOAD_ASSET(tag);
    if (src && src.id === 'gitee' && remote && Array.isArray(remote.assets)) {
      const hit = remote.assets.find(a => a && a.name === want);
      if (hit && hit.browser_download_url) return hit.browser_download_url;
    }
    return typeof src.download === 'function' ? src.download(tag) : '';
  }

  /** 来源标签后缀：镜像优先；否则「· 来自 Gitee / GitHub」 */
  function sourceSuffix(remote) {
    if (!remote) return '';
    if (remote.viaMirror) return ' · 经镜像检查';
    return remote.label ? ' · 来自 ' + remote.label : '';
  }

  /** #21：由远端信息与本机版本决定状态与文案（纯函数，便于四态测试）。 */
  function decideUpdate(remote, local) {
    if (!remote) return { state: 'error', text: '无法检查更新 · 请检查网络后重试' };
    const cmp = compareVersions(remote.version, local);
    const suffix = sourceSuffix(remote);
    if (cmp > 0) {
      return {
        state: 'available', tag: remote.tag, url: remote.url, download: remote.download || '',
        source: remote.source || '', label: remote.label || '', viaMirror: !!remote.viaMirror,
        text: '有新版本 ' + remote.tag + suffix,
      };
    }
    const ahead = cmp < 0;
    return {
      state: 'latest', tag: remote.tag, source: remote.source || '', label: remote.label || '',
      download: remote.download || '', viaMirror: !!remote.viaMirror, ahead,
      text: (ahead ? '已领先上游 ' : '已是最新 · 上游 ') + remote.tag + suffix,
    };
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
        // #72：缓存里带来源信息，回显文案与下载链接必须和当时选中的来源一致
        setUpd('available', c.text || ('有新版本 ' + c.tag + sourceSuffix(c)), c);
      } else if (fresh && c.state === 'latest') {
        // 缓存里带 ahead/text（#21：本机 0.4.2 高于上游 0.4.1 时显示「已领先上游」，不能退回「已是最新」）
        const text = c.text || ((c.ahead ? '已领先上游 ' : '已是最新 · 上游 ') + c.tag + sourceSuffix(c));
        setUpd('latest', text);
      }
    });
  }

  /** #72：在多个来源结果里取版本号最新的；版本相同保留先查到的（Gitee 优先）。 */
  function pickNewer(list) {
    let best = null;
    for (const r of (list || [])) {
      if (!r) continue;
      if (!best || compareVersions(r.version, best.version) > 0) best = r;
    }
    return best;
  }

  /** 单个来源失败（超时/404/非 200）都只返回 null，不影响另一个来源。 */
  async function fetchSource(src) {
    try { return parseUpdate(await fetchJson(src.api), src); } catch (e) { return null; }
  }

  async function checkUpdate(force) {
    setUpd('checking', '正在检测更新…');
    // #72：先 Gitee、再 GitHub（各自 2.5s 超时），两边都参与比较，取更新的那个。
    const remoteList = [];
    for (const src of UPDATE_SOURCES) remoteList.push(await fetchSource(src));
    let remote = pickNewer(remoteList);
    if (!remote) {
      // 两边都不可用 → 保留原兜底：镜像只读 manifest.json 的 version（任务书 §五 兜底）
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
    const decision = decideUpdate(remote, getVersion());
    setUpd(decision.state, decision.text, decision);
    cacheUpdate(decision);
    return decision;
  }

  // ---------------- 收藏页（#32b） ----------------
  // 视图完全由 items+groups+query+scope+activeGroupId 派生；删除先落盘再移除 UI，
  // 撤销窗口 5 秒（首次删除起算，连删合并计数，窗口不重置）。
  // 0.5.0 追加：默认两组「已去 / 想去」，没有「未分组」；兜底分组用「想去」。
  const FAV_GROUP_DEFAULT = 'g-want';
  const FAV_UNDO_MS = 5000;
  const FAV_SEARCH_DEBOUNCE = 150;

  let activeTab = 'fav';
  let favActiveGroup = FAV_GROUP_DEFAULT;
  let favScope = 'all';   // 两组后默认看「全部」，否则像丢了收藏
  let favQuery = '';
  let favUndo = null;          // {items:[{item, groupId}], expiresAt, timer}
  let favSearchTimer = null;
  let favMovingId = null;
  let favHint = null;          // {kind, text, actGroupId?}
  let favGroupsCache = [];     // 最近一次渲染用的分组表（供改名预填）

  function favStore() { return (window.HMP && window.HMP.favoritesStore) || null; }

  function pad2(n) { return String(n).length < 2 ? '0' + n : String(n); }

  function formatSavedAt(ts) {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' 收藏';
  }

  /** D-115：深链单一出口；拿不到 id 时退化为站内搜索（调用方决定）
   *  #47：stele.geogv.org 只支持 http（https 连接 12s 超时、页面空白），因此这里必须用 http。 */
  function buildDeepLink(steleId) {
    return steleId ? 'http://stele.geogv.org/zhcn/geo/' + encodeURIComponent(steleId) : '';
  }

  function buildSearchLink(name) {
    return 'http://stele.geogv.org/zhcn/search?keyword=' + encodeURIComponent(name || '');
  }

  function openExternal(url) {
    if (!url) return;
    try { chrome.tabs.create({ url }); } catch (e) { window.open(url, '_blank'); }
  }

  // #45：定位 = 在「普通窗口」的当前标签打开；不导航插件自己的小窗，也不关窗。
  // 标签取用顺序（均不需要 tabs 权限）：
  //   a) getLastFocused({windowTypes:['normal']}) → tabs.query({active, windowId})
  //   b) tabs.query({active, lastFocusedWindow:true})
  //   c) tabs.query({active}) 里排除插件页自身的标签
  // update 失败 / 无标签（chrome:// 等受限页）→ 新开标签，同样不关窗，不报错。
  function openFavorite(item) {
    const url = buildDeepLink(item.steleId) || buildSearchLink(item.name);
    if (!url) return;
    const tabs = (typeof chrome !== 'undefined' && chrome.tabs) ? chrome.tabs : null;
    const wins = (typeof chrome !== 'undefined' && chrome.windows) ? chrome.windows : null;
    if (!tabs || typeof tabs.query !== 'function') { openExternal(url); return; }

    let done = false;
    const fallback = () => { if (done) return; done = true; openExternal(url); };

    const selfId = (cb) => {
      try {
        if (typeof tabs.getCurrent === 'function') {
          tabs.getCurrent(tab => cb(tab && tab.id != null ? tab.id : null));
          return;
        }
      } catch (e) { /* 忽略 */ }
      cb(null);
    };

    const tryUpdate = (tab) => {
      if (done) return;
      if (!tab || tab.id == null || typeof tabs.update !== 'function') { fallback(); return; }
      selfId(id => {
        if (done) return;
        if (id != null && String(tab.id) === String(id)) { fallback(); return; }
        let settled = false;
        const fail = () => { if (settled) return; settled = true; fallback(); };
        try {
          const ret = tabs.update(tab.id, { url }, () => {
            if (settled) return;
            settled = true;
            const err = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) || null;
            if (err) fallback();   // 失败：新开标签；成功则什么都不做（不关窗）
          });
          if (ret && typeof ret.then === 'function') {
            ret.then(() => { if (!settled) settled = true; }, fail);
          }
        } catch (e) { fail(); }
      });
    };

    const pick = (list, excludeId) => {
      const arr = Array.isArray(list) ? list : [];
      for (let i = 0; i < arr.length; i++) {
        const t = arr[i];
        if (!t || t.id == null) continue;
        if (excludeId != null && String(t.id) === String(excludeId)) continue;
        return t;
      }
      return null;
    };

    const query = (opts, next) => {
      let called = false;
      const cb = list => {
        if (called || done) return;
        called = true;
        const t = pick(list, null);
        if (t) tryUpdate(t); else next();
      };
      try {
        const ret = tabs.query(opts, cb);
        if (ret && typeof ret.then === 'function') ret.then(cb, () => { if (!called && !done) { called = true; next(); } });
      } catch (e) { if (!called && !done) { called = true; next(); } }
    };

    const stageC = () => {
      selfId(id => {
        if (done) return;
        let called = false;
        const cb = list => {
          if (called || done) return;
          called = true;
          const t = pick(list, id);
          if (t) tryUpdate(t); else fallback();
        };
        try {
          const ret = tabs.query({ active: true }, cb);
          if (ret && typeof ret.then === 'function') ret.then(cb, () => { if (!called && !done) { called = true; fallback(); } });
        } catch (e) { if (!called && !done) { called = true; fallback(); } }
      });
    };

    const stageB = () => query({ active: true, lastFocusedWindow: true }, stageC);

    const stageA = () => {
      if (!wins || typeof wins.getLastFocused !== 'function') { stageB(); return; }
      let called = false;
      const onWin = win => {
        if (called || done) return;
        called = true;
        const err = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) || null;
        if (err || !win || win.id == null) { stageB(); return; }
        query({ active: true, windowId: win.id }, stageB);
      };
      try {
        const ret = wins.getLastFocused({ windowTypes: ['normal'] }, onWin);
        if (ret && typeof ret.then === 'function') ret.then(onWin, () => { if (!called && !done) { called = true; stageB(); } });
      } catch (e) { if (!called && !done) { called = true; stageB(); } }
    };

    stageA();
  }

  function amapUrlOf(item) {
    try { return window.HMP.apis.amap.searchUrl(item.name); } catch (e) {
      return 'https://uri.amap.com/search?keyword=' + encodeURIComponent(item.name || '');
    }
  }

  function baiduUrlOf(item) {
    const region = (item.admin && item.admin[0]) || '';
    try { return window.HMP.apis.baidu.searchUrl(item.name, region); } catch (e) {
      return 'https://map.baidu.com/search/' + encodeURIComponent(item.name || '');
    }
  }

  function copyFavoriteName(item) {
    const text = String(item.name || '');
    const done = () => {
      favHint = { kind: 'info', text: '已复制「' + text + '」' };
      renderFavHint();
      setTimeout(() => { if (favHint && favHint.kind === 'info') { favHint = null; renderFavHint(); } }, 1800);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, done);
      return;
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* 忽略 */ }
    if (ta.remove) ta.remove();
    done();
  }

  /** 纯函数：列表可见项（与 store.search 同口径：名称+地址子串、大小写不敏感） */
  function filterFavorites(items, query, scope, groupId) {
    const q = String(query == null ? '' : query).trim().toLowerCase();
    let list = (items || []).filter(x => scope === 'all' || x.groupId === (groupId || FAV_GROUP_DEFAULT));
    if (!q) return list;
    return list.filter(x => {
      const hay = [x.name, x.address].filter(Boolean).join('\n').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  function groupCounts(items) {
    const out = {};
    (items || []).forEach(x => { out[x.groupId] = (out[x.groupId] || 0) + 1; });
    return out;
  }

  /** 撤销是否仍有效（纯函数，便于边界测试） */
  function undoAlive(undo, now) {
    return !!undo && now < undo.expiresAt;
  }

  function undoText(undo) {
    const items = (undo && Array.isArray(undo.items)) ? undo.items : [];
    if (items.length === 1) {
      const rec = items[0] || {};
      const name = (rec.item && rec.item.name) || rec.name || '';
      // P3-5：单条给名称，多条给条数（任务书 PRD §3.4）
      return name ? '已取消收藏「' + name + '」' : '已取消收藏 1 条';
    }
    return '已取消收藏 ' + items.length + ' 条';
  }

  function favErrorText(reason, info) {
    if (reason === 'limit') return '收藏夹已满（上限 500 条），请先删除一些条目。';
    if (reason === 'limit-groups') return '分组已达上限（30 个）。';
    if (reason === 'size') return '收藏数据过大（超过 1MB），请先删除一些条目。';
    if (reason === 'schema') return '收藏数据版本不兼容，本次操作未写入。';
    if (reason === 'storage') return '本地存储写入失败，请重试。';
    if (reason === 'duplicate') return '已存在于「' + ((info && info.groupName) || '收藏') + '」';
    if (reason === 'duplicate-name') return '已有同名分组，换个名字。';
    if (reason === 'invalid-name') return '分组名不能为空，且不超过 24 字。';
    if (reason === 'system') return '系统分组不能删除或改名。';
    if (reason === 'system-group') return '「' + ((info && info.groupName) || '该分组') + '」是系统分组，不能删除或改名。';
    if (reason === 'need-group') return '请选择分组后再收藏。';
    if (reason === 'unknown-group') return '目标分组已不存在。';
    if (reason === 'not-found') return '条目已不存在，请刷新。';
    return '操作未完成，请重试。';
  }

  /** P3-4：删组二次确认文案（PRD L116）。n=0 时不谈条目，避免吓人。 */
  function deleteGroupConfirmText(name, n) {
    const groupName = name || '这个分组';
    const count = Number(n) > 0 ? Number(n) : 0;
    if (!count) {
      return '删除分组「' + groupName + '」？组内没有收藏，删除不影响收藏内容。';
    }
    return '删除分组「' + groupName + '」？组内 ' + count + ' 条收藏会移到「想去」，不会丢失。';
  }

  function showFavHint(kind, reason, info) {
    favHint = { kind: kind || 'warn', text: favErrorText(reason, info), reason };
    renderFavHint();
  }

  function clearFavHint() { favHint = null; renderFavHint(); }

  // #56：状态带语义化——成功/信息/错误各自一套 class，成功不再显示警告底色与三角图标。
  const FAV_HINT_CLASS = { ok: 'b-ok', info: 'b-info', err: 'b-err', warn: 'b-warn' };

  function renderFavHint() {
    const box = $('favHint');
    if (!box) return;
    const text = $('favHintText');
    box.hidden = !favHint;
    if (!favHint) return;
    box.className = 'band ' + (FAV_HINT_CLASS[favHint.kind] || 'b-warn');
    if (text) text.textContent = favHint.text;
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function renderFavChips(groups, counts) {
    const box = $('favChips');
    if (!box) return;
    box.innerHTML = '';
    groups.forEach(g => {
      const b = el('button', 'grp');
      b.type = 'button';
      b.setAttribute('data-g', g.id);
      // #67：chip 按下态只在「按组」范围下成立；范围为「全部」时没有任何 chip 按下
      b.setAttribute('aria-pressed', String(favScope === 'group' && g.id === favActiveGroup));
      const t = el('span', 'gt', g.name);
      t.title = g.name;
      b.appendChild(t);
      b.appendChild(el('span', 'n', String(counts[g.id] || 0)));
      b.addEventListener('click', () => {
        favActiveGroup = g.id;
        favScope = 'group';   // chips = 单组过滤（默认「全部」时点组即切回当前组）
        favMovingId = null;
        clearFavHint();
        renderFavorites();
      });
      box.appendChild(b);
    });
  }

  function renderFavScope() {
    const g = $('scopeGroup'), a = $('scopeAll');
    if (g) { g.setAttribute('aria-checked', String(favScope === 'group')); g.setAttribute('aria-pressed', String(favScope === 'group')); }
    if (a) { a.setAttribute('aria-checked', String(favScope === 'all')); a.setAttribute('aria-pressed', String(favScope === 'all')); }
  }

  function renderFavItem(item, groups) {
    const li = el('li', 'fav');
    li.setAttribute('role', 'listitem');

    const main = el('button', 'fav-main');
    main.type = 'button';
    main.setAttribute('aria-label', '定位：' + (item.name || '未命名'));
    const l1 = el('span', 'fline1');
    const name = el('span', 'fname', item.name || '未命名');
    name.title = item.name || '';
    const grp = groups.find(g => g.id === item.groupId);
    const go = el('span', 'fgo', '定位 ›');
    l1.appendChild(name);
    if (grp) {
      const tag = el('span', 'fgrp', grp.name);
      tag.title = grp.name;
      l1.appendChild(tag);
    }
    l1.appendChild(go);
    main.appendChild(l1);

    const metaText = [item.tier, item.address].filter(Boolean).join(' · ');
    if (metaText) {
      const meta = el('span', 'fmeta', metaText);
      meta.title = metaText;
      main.appendChild(meta);
    }

    const m = item.match || {};
    // #56：第三行只讲「匹配/未匹配」，不再回退成地址（地址已在上一行 metaText，避免同文两行）。
    const snapText = m.matchedName
      ? '匹配到 ' + m.matchedName + (Number.isFinite(m.matchDist) ? ' · 直线约 ' + Math.round(m.matchDist) + ' 米' : '')
      : '未匹配地图地点';
    const snap = el('span', 'fsnap');
    const st = el('span', 'fsnap-t', snapText);
    st.title = snapText;
    snap.appendChild(st);
    snap.appendChild(el('span', 'ftime', formatSavedAt(item.savedAt)));
    main.appendChild(snap);

    main.addEventListener('click', () => openFavorite(item));
    li.appendChild(main);

    const ops = el('div', 'fops');
    const links = el('span', 'flinks');
    [['高德', amapUrlOf(item)], ['百度', baiduUrlOf(item)]].forEach(pair => {
      const b = el('button', 'flink', pair[0]);
      b.type = 'button';
      b.addEventListener('click', () => openExternal(pair[1]));
      links.appendChild(b);
    });
    const copy = el('button', 'flink', '复制名称');
    copy.type = 'button';
    copy.addEventListener('click', () => copyFavoriteName(item));
    links.appendChild(copy);
    ops.appendChild(links);

    const btns = el('span', 'fbtns');
    const move = el('button', 'fop-b', '移动');
    move.type = 'button';
    move.setAttribute('aria-expanded', String(favMovingId === item.steleId));
    move.addEventListener('click', () => {
      favMovingId = favMovingId === item.steleId ? null : item.steleId;
      renderFavorites();
    });
    btns.appendChild(move);

    const del = el('button', 'fop-b danger', '取消收藏');
    del.type = 'button';
    del.addEventListener('click', () => removeFavorite(item));
    btns.appendChild(del);
    ops.appendChild(btns);
    li.appendChild(ops);

    if (favMovingId === item.steleId) li.appendChild(renderMoveRow(item, groups));
    return li;
  }

  function renderMoveRow(item, groups) {
    const box = el('div', 'move');
    box.appendChild(el('p', 'move-t', '移动到分组'));
    groups.filter(g => g.id !== item.groupId).forEach(g => {
      const lab = el('label', 'opt');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'fav-move-' + item.steleId;
      input.value = g.id;
      input.addEventListener('change', () => moveFavorite(item, g.id));
      lab.appendChild(input);
      lab.appendChild(el('span', 'oi', g.name));
      box.appendChild(lab);
    });
    return box;
  }

  function renderFavEmpty(allItems, visible, groups) {
    const box = $('favEmpty');
    if (!box) return false;
    const title = $('favEmptyTitle'), body = $('favEmptyBody');
    const go = $('favEmptyGo'), clear = $('favEmptyClear');
    const activeGroupObj = groups.find(g => g.id === favActiveGroup);
    let show = false;
    if (!allItems.length) {
      show = true;
      if (title) title.textContent = '还没有收藏';
      if (body) body.textContent = '在地图详情页打开一个点位，点卡片上的「收藏」即可保存到这里。';
      // #48：空态不引导配置 Key（收藏与 Key 配置解耦）；按钮默认隐藏，文案留给分组空态。
      if (go) go.hidden = true;
      if (clear) clear.hidden = true;
    } else if (favQuery.trim() && !visible.length) {
      show = true;
      if (title) title.textContent = '没有匹配的收藏';
      if (body) body.textContent = '换个关键词试试，或把范围切到「全部」。';
      if (go) go.hidden = true;
      if (clear) clear.hidden = false;
    } else if (!favQuery.trim() && !visible.length) {
      show = true;
      if (title) title.textContent = '「' + ((activeGroupObj && activeGroupObj.name) || '这个分组') + '」还是空的';
      if (body) body.textContent = '切到「全部」能看到其它分组的收藏，或在卡片上收藏新点位后移动到本组。';
      if (go) { go.hidden = false; go.textContent = '查看全部收藏'; }
      if (clear) clear.hidden = true;
    }
    box.hidden = !show;
    return show;
  }

  function renderFavUndo() {
    const box = $('favUndo');
    if (!box) return;
    const alive = undoAlive(favUndo, Date.now());
    box.hidden = !alive;
    const t = $('favUndoText');
    if (t) t.textContent = alive ? undoText(favUndo) : '';
  }

  /** 清空撤销窗口（切 Tab / 超时）；删除本身保留 */
  function cancelFavUndo() {
    if (favUndo && favUndo.timer) clearTimeout(favUndo.timer);
    favUndo = null;
    renderFavUndo();
  }

  function pushFavUndo(item, groupId) {
    const now = Date.now();
    if (!undoAlive(favUndo, now)) {
      if (favUndo && favUndo.timer) clearTimeout(favUndo.timer);
      favUndo = { items: [], expiresAt: now + FAV_UNDO_MS, timer: null };
      favUndo.timer = setTimeout(() => {
        favUndo = null;
        renderFavUndo();
        const list = $('favList');
        if (list && list.focus) list.focus();
      }, FAV_UNDO_MS);
    }
    favUndo.items.push({ item, groupId: groupId || FAV_GROUP_DEFAULT });
    renderFavUndo();
    const btn = $('favUndoBtn');
    if (btn && btn.focus) btn.focus();
  }

  async function undoFavRemove() {
    const u = favUndo;
    if (!u) return;
    if (u.timer) clearTimeout(u.timer);
    favUndo = null;
    renderFavUndo();
    const store = favStore();
    if (!store) return;
    let failed = null;
    for (let i = u.items.length - 1; i >= 0; i--) {
      const rec = u.items[i];
      const r = await store.add(rec.item, { keepSavedAt: true, groupId: rec.groupId || FAV_GROUP_DEFAULT });
      if (!r.ok) { failed = r; continue; }
    }
    if (failed) showFavHint('warn', failed.reason, failed);
    await renderFavorites();
    const list = $('favList');
    if (list && list.focus) list.focus();
  }

  async function removeFavorite(item) {
    const store = favStore();
    if (!store) return;
    const r = await store.remove(item.steleId, item.groupId);
    if (!r.ok) { showFavHint('warn', r.reason, r); return; }
    if (!r.removed) { showFavHint('warn', 'not-found'); return; }
    clearFavHint();
    pushFavUndo(r.item || item, item.groupId);
    await renderFavorites();
  }

  async function moveFavorite(item, groupId) {
    const store = favStore();
    if (!store) return;
    const r = await store.move(item.steleId, groupId);
    favMovingId = null;
    if (!r.ok) { showFavHint('warn', r.reason, r); await renderFavorites(); return; }
    clearFavHint();
    await renderFavorites();
  }

  async function renderFavorites() {
    const store = favStore();
    if (!store) return;
    const lib = await store.read();
    const groups = (lib.groups && lib.groups.length) ? lib.groups : [
      { id: 'g-been', name: '已去', system: true, createdAt: 0 },
      { id: 'g-want', name: '想去', system: true, createdAt: 1 },
    ];
    favGroupsCache = groups;
    if (!groups.some(g => g.id === favActiveGroup)) favActiveGroup = groups[0].id;
    const all = lib.items || [];
    const visible = filterFavorites(all, favQuery, favScope, favActiveGroup);

    renderFavChips(groups, groupCounts(all));
    renderFavGroupMenuState();
    renderFavScope();
    renderFavHint();

    const list = $('favList');
    const isEmpty = renderFavEmpty(all, visible, groups);
    if (list) {
      list.innerHTML = '';
      list.hidden = isEmpty;
      if (!isEmpty) visible.forEach(item => list.appendChild(renderFavItem(item, groups)));
    }

    const found = $('favFound');
    if (found) found.textContent = favQuery.trim() ? '找到 ' + visible.length + ' 条' : '';
  }

  function setFavScope(scope) {
    favScope = scope === 'all' ? 'all' : 'group';
    renderFavorites();
  }

  function setFavQuery(q) {
    favQuery = String(q == null ? '' : q);
    const input = $('favQuery');
    if (input && input.value !== favQuery) input.value = favQuery;
    renderFavorites();
  }

  function openFavGroupMenu(open) {
    const menu = $('favMenu'), btn = $('favGroupMenuBtn');
    const show = open == null ? !(menu && !menu.hidden) : !!open;
    if (show) renderFavGroupMenuState();
    if (menu) menu.hidden = !show;
    if (btn) btn.setAttribute('aria-expanded', String(show));
  }

  function showFavForm(which, show) {
    const newForm = $('favNewForm'), renameForm = $('favRenameForm');
    if (newForm) newForm.hidden = !(show && which === 'new');
    if (renameForm) renameForm.hidden = !(show && which === 'rename');
    if (show) {
      const input = $(which === 'new' ? 'favNewName' : 'favRenameName');
      if (input) {
        input.value = which === 'rename' ? ((currentGroupObj() || {}).name || '') : '';
        if (input.focus) input.focus();
      }
    }
  }

  function currentGroupObj() {
    return favGroupsCache.find(g => g.id === favActiveGroup) || null;
  }

  /** 系统组（已去/想去）在组菜单里置灰：不能改名/删除，点击给解释文案。 */
  function renderFavGroupMenuState() {
    const g = currentGroupObj();
    const sys = !!(g && g.system);
    const tip = sys ? '「' + g.name + '」是系统分组，不能删除或改名。' : '';
    [['favRenameGroup'], ['favDeleteGroup']].forEach(pair => {
      const b = $(pair[0]);
      if (!b) return;
      b.classList.toggle('is-disabled', sys);
      b.setAttribute('aria-disabled', String(sys));
      if (tip) b.setAttribute('title', tip);
      else b.removeAttribute('title');
    });
  }

  async function submitFavGroup(which) {
    const store = favStore();
    if (!store) return;
    const input = $(which === 'new' ? 'favNewName' : 'favRenameName');
    const name = input ? String(input.value || '').trim() : '';
    const r = which === 'new' ? await store.createGroup(name) : await store.renameGroup(favActiveGroup, name);
    if (!r.ok) {
      showFavHint('warn', r.reason, r);
      return;
    }
    clearFavHint();
    showFavForm(which, false);
    if (which === 'new' && r.group) favActiveGroup = r.group.id;
    await renderFavorites();
  }

  async function deleteCurrentGroup() {
    const store = favStore();
    if (!store) return;
    const group = currentGroupObj();
    if (group && group.system) { showFavHint('warn', 'system-group', { groupName: group.name }); return; }
    const lib = await store.read();
    const items = (lib && Array.isArray(lib.items)) ? lib.items : [];
    const n = items.filter(x => x.groupId === favActiveGroup).length;
    if (typeof window.confirm === 'function' &&
        !window.confirm(deleteGroupConfirmText(group && group.name, n))) return;
    const r = await store.deleteGroup(favActiveGroup);
    if (!r.ok) { showFavHint('warn', r.reason, r); return; }
    favActiveGroup = FAV_GROUP_DEFAULT;
    clearFavHint();
    await renderFavorites();
  }

  // ---------------- #53 WebDAV 同步 ----------------
  let syncCfg = null;
  let syncBusy = false;

  // #57 / #58：配置区就在收藏页，未配置时的指引只面向本区，不再跨页指向「开放时间」。
  const SYNC_LOCAL_GUIDE = '请先填写地址并保存配置。';

  /** #59：展开/收起收藏页内的 WebDAV 配置区，同步维护按钮 aria-expanded。 */
  function setSyncConfigOpen(open) {
    const box = $('advSync');
    const btn = $('favSyncCfg');
    if (box) box.hidden = !open;
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  /** #59：就地展开配置区并聚焦服务器地址（未配置点「立即同步」时用）。 */
  function openSyncConfig() {
    setSyncConfigOpen(true);
    const input = $('syncUrl');
    if (input && typeof input.focus === 'function') input.focus();
    const box = $('advSync');
    // 真实弹窗高度有限（约 600px），展开后把配置区滚进视野，避免看起来「点了没反应」
    if (box && typeof box.scrollIntoView === 'function') box.scrollIntoView({ block: 'nearest' });
  }

  /** #59：工具行「WebDAV 同步设置」按钮切换配置区。 */
  function toggleSyncConfig() {
    const box = $('advSync');
    if (box && box.hidden) openSyncConfig();
    else setSyncConfigOpen(false);
  }

  function syncModule() { return window.HMP && window.HMP.favoritesSync; }

  function parseSyncOrigin(raw) {
    try {
      const u = new URL(String(raw || '').trim());
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      return u.origin;
    } catch (e) { return ''; }
  }

  function readSyncForm() {
    const mod = syncModule();
    const path = ($('syncPath') ? String($('syncPath').value || '').trim() : '') ||
      (mod ? mod.DEFAULT_PATH : 'heritage-map/favorites.json');
    return {
      url: ($('syncUrl') ? String($('syncUrl').value || '').trim() : ''),
      user: ($('syncUser') ? String($('syncUser').value || '') : ''),
      pass: ($('syncPass') ? String($('syncPass').value || '') : ''),
      path,
    };
  }

  function updateSyncHttpWarn() {
    const warn = $('syncHttpWarn');
    if (!warn) return;
    const url = $('syncUrl') ? String($('syncUrl').value || '').trim() : '';
    warn.hidden = !/^http:\/\//i.test(url);
  }

  function setSyncStatus(text, kind) {
    const el = $('syncStatus');
    if (!el) return;
    el.textContent = text || '';
    el.dataset.kind = kind || '';
    const state = $('syncState');
    if (state) state.dataset.kind = kind || '';
  }

  function renderSyncConfig(cfg) {
    syncCfg = cfg && cfg.url ? cfg : null;
    if ($('syncUrl')) $('syncUrl').value = (syncCfg && syncCfg.url) || '';
    if ($('syncUser')) $('syncUser').value = (syncCfg && syncCfg.user) || '';
    if ($('syncPass')) $('syncPass').value = (syncCfg && syncCfg.pass) || '';
    if ($('syncPath')) $('syncPath').value = (syncCfg && syncCfg.path) ||
      (syncModule() ? syncModule().DEFAULT_PATH : 'heritage-map/favorites.json');
    updateSyncHttpWarn();
    setSyncStatus(syncCfg ? '' : SYNC_LOCAL_GUIDE, 'info');
  }

  function loadSyncConfig() {
    storageGet([syncModule() ? syncModule().SYNC_KEY : 'hmp:webdav'], items => {
      renderSyncConfig((items && items['hmp:webdav']) || null);
    });
  }

  function requestOriginPermission(origin) {
    return new Promise(resolve => {
      if (!chrome.permissions || !chrome.permissions.request) { resolve(false); return; }
      try {
        chrome.permissions.request({ origins: [origin + '/*'] }, granted => resolve(!!granted));
      } catch (e) { resolve(false); }
    });
  }

  /** 保存配置：先申请 origin 权限，拒绝则不落库。 */
  function saveSyncConfig() {
    const cfg = readSyncForm();
    const origin = parseSyncOrigin(cfg.url);
    if (!origin) { setSyncStatus('服务器地址无效（需 http/https）。', 'err'); return Promise.resolve(false); }
    return requestOriginPermission(origin).then(granted => {
      if (!granted) { setSyncStatus('未授予站点权限，配置未保存。', 'err'); return false; }
      return new Promise(resolve => {
        storageSet({ [syncModule() ? syncModule().SYNC_KEY : 'hmp:webdav']: cfg }, () => {
          syncCfg = cfg;
          updateSyncHttpWarn();
          setSyncStatus('已保存', 'ok');
          resolve(true);
        });
      });
    });
  }

  async function testSyncConnection() {
    const mod = syncModule();
    if (!mod) { setSyncStatus('同步模块未加载。', 'err'); return { ok: false, reason: 'unconfigured' }; }
    const cfg = readSyncForm();
    const origin = parseSyncOrigin(cfg.url);
    if (!origin) { setSyncStatus('请先填写有效的服务器地址。', 'err'); return { ok: false, reason: 'unconfigured' }; }
    setSyncStatus('连接中…', 'busy');
    const r = await mod.getRemote(cfg, mod.buildUrl(cfg.url, cfg.path),
      typeof fetch === 'function' ? fetch : null);
    if (r.ok) setSyncStatus(r.missing ? '连接成功（远端还没有文件）' : '连接成功', 'ok');
    else setSyncStatus(mod.syncErrorText(r.reason, r.status), 'err');
    return r;
  }

  async function runSync() {
    const mod = syncModule();
    const store = favStore();
    if (!mod || !store) { setSyncStatus('同步模块未加载。', 'err'); return { ok: false, reason: 'unconfigured' }; }
    if (syncBusy) return { ok: false, reason: 'busy' };
    const cfg = readSyncForm();
    if (!parseSyncOrigin(cfg.url)) {
      // #59：未配置就地展开配置区、聚焦地址并给提示，不发起请求
      openSyncConfig();
      setSyncStatus(cfg.url ? '服务器地址要以 http:// 或 https:// 开头。' : SYNC_LOCAL_GUIDE, cfg.url ? 'err' : 'info');
      return { ok: false, reason: 'unconfigured' };
    }
    const btn = $('syncRun');
    syncBusy = true;
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); btn.textContent = '同步中…'; }
    setSyncStatus('同步中…', 'busy');
    let out;
    try {
      out = await mod.syncLibrary(cfg, store, typeof fetch === 'function' ? fetch : null);
    } catch (e) {
      out = { ok: false, reason: 'unknown' };
    }
    if (out.ok) {
      const st = out.stats || { added: 0, updated: 0, removed: 0 };
      const text = '已同步：新增 ' + st.added + '、更新 ' + st.updated + '、删除 ' + st.removed;
      // #59：同步结果只显示在配置区状态行（不再占用列表上方的 favHint）
      setSyncStatus(text, 'ok');
      await renderFavorites();
    } else {
      setSyncStatus(mod.syncErrorText(out.reason, out.status), 'err');
    }
    syncBusy = false;
    if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); btn.textContent = '立即同步'; }
    return out;
  }

  function exportFavorites() {
    const store = favStore();
    if (!store) return;
    store.exportJSON().then(text => {
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const blob = new Blob([text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'hmp-favorites-' + stamp + '.json';
        document.body.appendChild(a);
        a.click();
        if (a.remove) a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        favHint = { kind: 'info', text: '已导出收藏（不含任何 Key）' };
        renderFavHint();
      } catch (e) {
        showFavHint('warn', 'storage');
      }
    });
  }

  // Tab：默认收藏（D-114）；设置页 DOM 不重建，dirty/表单值/折叠态原样（Q16）
  function activateTab(name, focus) {
    activeTab = name === 'set' ? 'set' : 'fav';
    const fav = $('panel-fav'), set = $('panel-set');
    const tbFav = $('tab-fav'), tbSet = $('tab-set');
    if (fav) fav.hidden = activeTab !== 'fav';
    if (set) set.hidden = activeTab !== 'set';
    if (tbFav) { tbFav.setAttribute('aria-selected', String(activeTab === 'fav')); tbFav.tabIndex = activeTab === 'fav' ? 0 : -1; }
    if (tbSet) { tbSet.setAttribute('aria-selected', String(activeTab === 'set')); tbSet.tabIndex = activeTab === 'set' ? 0 : -1; }
    if (activeTab === 'fav') {
      renderFavorites();
    } else {
      cancelFavUndo();
      renderState(computeState());
    }
    if (focus) {
      const t = activeTab === 'fav' ? tbFav : tbSet;
      if (t && t.focus) t.focus();
    }
  }

  function bindFavorites() {
    const tbFav = $('tab-fav'), tbSet = $('tab-set');
    if (tbFav) tbFav.addEventListener('click', () => activateTab('fav', true));
    if (tbSet) tbSet.addEventListener('click', () => activateTab('set', true));
    [tbFav, tbSet].forEach(t => {
      if (!t) return;
      t.addEventListener('keydown', ev => {
        if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
        ev.preventDefault();
        const next = activeTab === 'fav' ? 'set' : 'fav';
        activateTab(next, true);
      });
    });

    const q = $('favQuery');
    if (q) {
      q.addEventListener('input', () => {
        if (favSearchTimer) clearTimeout(favSearchTimer);
        favSearchTimer = setTimeout(() => setFavQuery(q.value), FAV_SEARCH_DEBOUNCE);
      });
      q.addEventListener('keydown', ev => {
        if (ev.key === 'Escape') { q.value = ''; setFavQuery(''); }
      });
    }
    const sg = $('scopeGroup'), sa = $('scopeAll');
    if (sg) sg.addEventListener('click', () => setFavScope('group'));
    if (sa) sa.addEventListener('click', () => setFavScope('all'));

    const menuBtn = $('favGroupMenuBtn');
    if (menuBtn) menuBtn.addEventListener('click', () => openFavGroupMenu());
    document.addEventListener('click', ev => {
      const menu = $('favMenu');
      if (!menu || menu.hidden) return;
      if (menu.contains(ev.target)) return;
      if (menuBtn && menuBtn.contains && menuBtn.contains(ev.target)) return;
      openFavGroupMenu(false);
    });
    document.addEventListener('keydown', ev => { if (ev.key === 'Escape') openFavGroupMenu(false); });

    if ($('favNewGroup')) $('favNewGroup').addEventListener('click', () => { openFavGroupMenu(false); showFavForm('new', true); });
    if ($('favRenameGroup')) $('favRenameGroup').addEventListener('click', () => {
      const g = currentGroupObj();
      if (g && g.system) { showFavHint('warn', 'system-group', { groupName: g.name }); return; }
      openFavGroupMenu(false); showFavForm('rename', true);
    });
    if ($('favDeleteGroup')) $('favDeleteGroup').addEventListener('click', () => {
      const g = currentGroupObj();
      if (g && g.system) { showFavHint('warn', 'system-group', { groupName: g.name }); return; }
      openFavGroupMenu(false); deleteCurrentGroup();
    });
    if ($('favNewOk')) $('favNewOk').addEventListener('click', () => submitFavGroup('new'));
    if ($('favNewCancel')) $('favNewCancel').addEventListener('click', () => showFavForm('new', false));
    if ($('favRenameOk')) $('favRenameOk').addEventListener('click', () => submitFavGroup('rename'));
    if ($('favRenameCancel')) $('favRenameCancel').addEventListener('click', () => showFavForm('rename', false));
    [['favNewName', 'new'], ['favRenameName', 'rename']].forEach(pair => {
      const el = $(pair[0]);
      if (!el) return;
      el.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') { ev.preventDefault(); submitFavGroup(pair[1]); }
        if (ev.key === 'Escape') showFavForm(pair[1], false);
      });
    });

    if ($('favUndoBtn')) $('favUndoBtn').addEventListener('click', undoFavRemove);
    if ($('favExport')) $('favExport').addEventListener('click', exportFavorites);
    if ($('favEmptyGo')) $('favEmptyGo').addEventListener('click', () => {
      if (!favQuery.trim() && favScope === 'group' && $('favEmptyGo').textContent === '查看全部收藏') setFavScope('all');
      else activateTab('set', true);
    });
    if ($('favEmptyClear')) $('favEmptyClear').addEventListener('click', () => setFavQuery(''));

    activateTab('fav', false);
  }

  // #36 P2-2(b)：弹窗常驻，卡片侧收藏/取消收藏后列表要立刻跟上。
  // 只认收藏键、只认 local 区；无 onChanged（测试桩/旧环境）时静默跳过。
  function bindFavoritesStorageSync() {
    const oc = window.chrome && window.chrome.storage && window.chrome.storage.onChanged;
    if (!oc || typeof oc.addListener !== 'function') return;
    const store = favStore();
    const key = (store && store.KEY) || 'hmp:favorites:v1';
    oc.addListener((changes, area) => {
      if (area && area !== 'local') return;
      if (!changes || !changes[key]) return;
      renderFavorites();
    });
  }

  // #46：弹窗内「弹出到新窗口」。已有小窗则聚焦，否则新建 440×640 常驻小窗；
  // 成功后关闭当前弹窗，看起来就是「弹窗变窗口」。失败保持弹窗，不报错。
  const PANEL_WINDOW_KEY = 'hmp:panelWindowId';
  function popPanelOut() {
    const stays = () => { /* 保持弹窗 */ };
    const closePopup = () => { try { window.close(); } catch (e) { /* 忽略 */ } };
    const createPanel = () => {
      try {
        if (!chrome || !chrome.windows || typeof chrome.windows.create !== 'function') { stays(); return; }
        const url = chrome.runtime.getURL('popup/popup.html') + '?window=1';
        const after = win => {
          const id = win && win.id;
          try {
            if (id != null && chrome.storage && chrome.storage.session) {
              chrome.storage.session.set({ [PANEL_WINDOW_KEY]: id });
            }
          } catch (e) { /* 忽略 */ }
          closePopup();
        };
        const ret = chrome.windows.create({ url, type: 'popup', width: 440, height: 640 }, after);
        if (ret && typeof ret.then === 'function') ret.then(after, stays);
        else if (ret && typeof ret.id !== 'undefined') after(ret);
        // 回调形态下 after 由 chrome 调用；若既无回调也无 Promise，保持弹窗。
      } catch (e) { stays(); }
    };
    const focusOrCreate = id => {
      if (id == null) { createPanel(); return; }
      let handled = false;
      const fail = () => { if (handled) return; handled = true; createPanel(); };
      const onGet = win => {
        if (handled) return;
        const err = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) || null;
        if (err || !win) { fail(); return; }
        handled = true;
        try {
          if (!chrome.windows || typeof chrome.windows.update !== 'function') { createPanel(); return; }
          chrome.windows.update(id, { focused: true });
          closePopup();
        } catch (e) { handled = false; fail(); }
      };
      try {
        const ret = chrome.windows.get(id, onGet);
        if (ret && typeof ret.then === 'function') ret.then(onGet, fail);
      } catch (e) { fail(); }
    };
    try {
      const session = (chrome && chrome.storage && chrome.storage.session) || null;
      if (session && typeof session.get === 'function') {
        const got = items => {
          try { focusOrCreate(items && items[PANEL_WINDOW_KEY] != null ? items[PANEL_WINDOW_KEY] : null); }
          catch (e) { createPanel(); }
        };
        const ret = session.get([PANEL_WINDOW_KEY], got);
        if (ret && typeof ret.then === 'function') ret.then(got, createPanel);
      } else focusOrCreate(null);
    } catch (e) { createPanel(); }
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

    bindFavorites();
    bindFavoritesStorageSync();
    if ($('favSyncCfg')) $('favSyncCfg').addEventListener('click', () => toggleSyncConfig());
    if ($('syncRun')) $('syncRun').addEventListener('click', () => runSync());
    if ($('syncSave')) $('syncSave').addEventListener('click', () => saveSyncConfig());
    if ($('syncTest')) $('syncTest').addEventListener('click', () => testSyncConnection());
    if ($('syncUrl')) $('syncUrl').addEventListener('input', updateSyncHttpWarn);
    if ($('popoutBtn')) $('popoutBtn').addEventListener('click', popPanelOut);

    if (!savedSnapshot) resetRes();
  }

  // 供测试与截图 harness 使用的钩子（不改产品行为）
  window.HMP = window.HMP || {};
  window.HMP.popup = {
    theme: { get: getTheme, set: applyTheme, normalize: normalizeTheme, KEY: THEME_KEY, default: DEFAULT_THEME },
    state: { get: () => currentState, render: renderState, compute: computeState },
    version: { get: getVersion, compare: compareVersions, parse: parseUpdate, asset: DOWNLOAD_ASSET, page: RELEASE_PAGE },
    update: { check: checkUpdate, set: setUpd, decide: decideUpdate, restore: restoreUpdateCache, cacheKey: UPDATE_CACHE_KEY, repo: UPDATE_REPO, api: UPDATE_API, mirror: UPDATE_MIRROR, ttl: UPDATE_TTL_MS, sources: UPDATE_SOURCES, pick: pickNewer, giteeApi: GITEE_API, giteePage: GITEE_PAGE },
    test: {
      one: testOne, all: testKeys, classify: classifyError, providers: PROVIDERS, reset: resetRes,
      keyTest: {
        KEY: KEY_TEST_KEY, format: formatTestTime, all: () => keyTest, record: keyTestRecord,
        restore: restoreResStates, prune: pruneKeyTest
      }
    },
    form: { read: readForm, isDirty, save },
    favorites: {
      activateTab, render: renderFavorites, setQuery: setFavQuery, setScope: setFavScope,
      filter: filterFavorites, groupCounts, buildDeepLink, buildSearchLink,
      setGroup: id => { favActiveGroup = id || FAV_GROUP_DEFAULT; return renderFavorites(); },
      groupMenuState: renderFavGroupMenuState,
      undoAlive, undoText, openMenu: openFavGroupMenu, showForm: showFavForm, showHint: showFavHint, clearHint: clearFavHint,
      errorText: favErrorText, deleteGroupConfirmText,
      resetUi: () => { favMovingId = null; favHint = null; openFavGroupMenu(false); showFavForm('new', false); showFavForm('rename', false); },
      state: () => ({ activeTab, group: favActiveGroup, scope: favScope, query: favQuery }),
      __undo: () => favUndo
    },
    refreshCacheInfo,
    sync: {
      KEY: 'hmp:webdav', read: readSyncForm, save: saveSyncConfig, test: testSyncConnection,
      run: runSync, errorText: (r, st) => (syncModule() ? syncModule().syncErrorText(r, st) : ''),
      status: () => { const el = $('syncStatus'); return el ? el.textContent : ''; },
      busy: () => syncBusy
    }
  };

  // #43：工具栏图标打开的是独立小窗（service worker 加 ?window=1）。
  // 只有该模式铺满窗口宽度；普通扩展弹窗（若以后恢复 default_popup）仍走 400 固定宽。
  // #46：窗口模式下「弹出到新窗口」按钮无意义，隐藏（CSS 兜底 + JS 置 hidden）。
  function applyWindowMode() {
    try {
      const q = (window.location && window.location.search) || '';
      if (/(?:^|[?&])window=1(?:&|$)/.test(q) && document.documentElement) {
        document.documentElement.dataset.hmpWindow = '1';
        const btn = document.getElementById('popoutBtn');
        if (btn) btn.hidden = true;
      }
    } catch (e) { /* 忽略 */ }
  }

  applyWindowMode();
  initTheme();
  document.addEventListener('DOMContentLoaded', () => { bind(); load(); });
})();
