// popup/popup.js
// 配置面板逻辑：加载/保存 chrome.storage.local 中的 Key。

(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  // "已保存"的快照。用来判断输入框里有没有改了但没点保存的内容——
  // 这是"我填了百度 Key、测试也通过了，怎么还是高德的结果"的常见原因：
  // 「测试 Key」测的是输入框里的值，只有点「保存」才会写进 chrome.storage。
  let savedSnapshot = null;

  function load() {
    chrome.storage.local.get(
      ['amapKey', 'baiduAk', 'defaultProvider', 'strategyMode', 'enabled'],
      items => {
        $('amapKey').value = items.amapKey || '';
        $('baiduAk').value = items.baiduAk || '';
        $('defaultProvider').value = items.defaultProvider || 'amap';
        $('strategyMode').value = items.strategyMode || 'combine';
        $('enabled').checked = items.enabled !== false;
        savedSnapshot = readForm();
        updateDirtyHint();
      }
    );
    refreshCacheInfo();
  }

  /** 读取当前表单值（与 save() 写入的结构一致） */
  function readForm() {
    return {
      amapKey: $('amapKey').value.trim(),
      baiduAk: $('baiduAk').value.trim(),
      defaultProvider: $('defaultProvider').value,
      strategyMode: $('strategyMode').value,
      enabled: $('enabled').checked
    };
  }

  function isDirty() {
    if (!savedSnapshot) return false;
    const now = readForm();
    return Object.keys(now).some(k => now[k] !== savedSnapshot[k]);
  }

  function updateDirtyHint() {
    const el = $('dirtyHint');
    if (el) el.style.display = isDirty() ? 'block' : 'none';
  }

  /** 保存并返回 Promise（测试前需要先落盘，所以得能 await） */
  function save(opts) {
    const payload = readForm();
    return new Promise(resolve => {
      chrome.storage.local.set(payload, () => {
        savedSnapshot = payload;
        updateDirtyHint();
        if (!opts || !opts.silent) {
          showStatus('success', '已保存。刷新遗产地图详情页即可生效。');
        }
        resolve();
      });
    });
  }

  function clearCache() {
    chrome.storage.local.get(null, items => {
      const keys = Object.keys(items).filter(k => k.startsWith('hmp:cache:'));
      if (keys.length === 0) {
        showStatus('success', '缓存已为空。');
        return;
      }
      chrome.storage.local.remove(keys, () => {
        showStatus('success', `已清除 ${keys.length} 条缓存，刷新页面后生效。`);
        refreshCacheInfo();
      });
    });
  }

  /** 显示缓存条数与数据版本，便于判断"是不是旧缓存" */
  function refreshCacheInfo() {
    chrome.storage.local.get(null, items => {
      const all = Object.keys(items).filter(k => k.startsWith('hmp:cache:'));
      const el = $('cacheInfo');
      if (!el) return;
      el.textContent = all.length
        ? `当前缓存 ${all.length} 条（插件更新后建议清一次）`
        : '当前无缓存';
    });
  }

  function showStatus(type, msg) {
    const el = $('status');
    el.className = 'status ' + type;
    el.textContent = msg;
    if (type === 'success') {
      setTimeout(() => { el.className = 'status'; }, 3000);
    }
  }

  // ---------------- 测试 Key ----------------
  // 用一个最简请求验证 Key 是否可用，省得先跑去网站才发现配错。
  function row(ok, label, detail) {
    const d = document.createElement('div');
    d.className = 'tr-row ' + (ok ? 'tr-ok' : 'tr-fail');
    d.textContent = (ok ? '✅ ' : '❌ ') + label + (detail ? '：' + detail : '');
    return d;
  }

  // 复用 content/apis/*.js 里的封装：测试走的就是真实请求路径与真实报错提示，
  // 避免"测试通过但实际查询失败"这种不一致。
  async function testAmap(key) {
    const pois = await window.HMP.apis.amap.search({ key, name: '故宫', region: '北京市' });
    if (!pois.length) return '可用（未返回结果，但 Key 有效）';
    const p = pois[0];
    const hasBiz = (p.opentimeToday || p.opentimeWeek) ? '，已返回开放时间字段' : '';
    return `可用，返回 ${pois.length} 条结果${hasBiz}`;
  }

  async function testBaidu(ak) {
    const rs = await window.HMP.apis.baidu.search({ ak, name: '故宫', region: '北京市' });
    if (!rs.length) return '可用（未返回结果，但 API Key 有效）';
    const r = rs[0];
    const hasBiz = (r.shopHours || r.price) ? '，已返回营业时间/价格字段' : '';
    return `可用，返回 ${rs.length} 条结果${hasBiz}`;
  }

  async function testKeys() {
    const box = $('testResult');
    box.innerHTML = '';

    // 关键：先把当前填写的内容落盘，再测试。
    // 否则会出现"测试通过、但插件里根本没生效"——因为测试读的是输入框，
    // 而插件读的是 chrome.storage。
    const wasDirty = isDirty();
    await save({ silent: true });
    if (wasDirty) {
      const note = document.createElement('div');
      note.className = 'tr-row tr-ok';
      note.textContent = '💾 已先保存当前填写的 Key（否则测试通过也不会生效）';
      box.appendChild(note);
    }

    const amapKey = $('amapKey').value.trim();
    const baiduAk = $('baiduAk').value.trim();

    if (!amapKey && !baiduAk) {
      box.appendChild(row(false, '没有可测试的 Key', '请先填写至少一个'));
      return;
    }

    if (amapKey) {
      try {
        const msg = await testAmap(amapKey);
        box.appendChild(row(true, '高德地图', msg));
      } catch (e) {
        box.appendChild(row(false, '高德地图', e.message));
      }
    }
    if (baiduAk) {
      try {
        const msg = await testBaidu(baiduAk);
        box.appendChild(row(true, '百度地图', msg));
      } catch (e) {
        box.appendChild(row(false, '百度地图', e.message));
      }
    }
    if (!amapKey) box.appendChild(row(false, '高德地图', '未填写'));
    if (!baiduAk) box.appendChild(row(false, '百度地图', '未填写'));
  }

  $('save').addEventListener('click', () => save());
  // 任何输入变化都刷新"未保存"提示
  ['amapKey', 'baiduAk', 'defaultProvider', 'strategyMode', 'enabled'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('change', updateDirtyHint);
    if (el && el.tagName === 'INPUT') el.addEventListener('input', updateDirtyHint);
  });
  $('testKey').addEventListener('click', () => {
    const btn = $('testKey');
    btn.disabled = true;
    btn.textContent = '测试中…';
    testKeys().finally(() => {
      btn.disabled = false;
      btn.textContent = '测试 Key';
    });
  });
  $('clearCache').addEventListener('click', clearCache);

  document.addEventListener('DOMContentLoaded', load);
})();