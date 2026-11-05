// tests/http_timeout_tests.js
// 条目 1：请求超时 + 单次重试；并把「超时」与「未搜到」「有候选但未通过校验」分开。
// 运行: node tests/http_timeout_tests.js
'use strict';
const env = require('./_env');
const { check, finish } = env.makeChecker('http');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async function () {
  // ── A. 直连路径（无 chrome，走 fetch）──
  env.setup({ chrome: false });
  env.load('content/http.js');
  const H = global.window.HMP.http;

  check('导出的单次超时 = 2500ms', H.TIMEOUT_MS === 2500, String(H.TIMEOUT_MS));
  check('额外重试次数 = 1', H.RETRY_MAX === 1, String(H.RETRY_MAX));

  // 负例①：fetch 永不 resolve → 5.0–5.5s 内返回超时，且只重试 1 次（共 2 次请求）
  {
    let calls = 0;
    global.fetch = () => { calls++; return new Promise(() => {}); };
    const t0 = Date.now();
    let err = null;
    try { await H.fetchText('https://restapi.amap.com/x'); } catch (e) { err = e; }
    const dt = Date.now() - t0;
    check('永不 resolve → 抛超时错误', !!err && err.code === 'HMP_TIMEOUT', err && (err.code + ' ' + err.message));
    check('超时在 5.0–5.6s 内返回', dt >= 4900 && dt <= 5600, dt + 'ms');
    check('重试 1 次（共 2 次请求）', calls === 2, 'calls=' + calls);
  }

  // 负例②：第一次 reject、第二次成功 → 判成功，且请求次数 = 2
  {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls === 1) throw new Error('network down');
      return { ok: true, status: 200, text: async () => '{"status":"1"}' };
    };
    const text = await H.fetchText('https://restapi.amap.com/y');
    check('首次失败第二次成功 → 返回文本', text === '{"status":"1"}', text);
    check('成功前只重试 1 次（共 2 次请求）', calls === 2, 'calls=' + calls);
  }

  // 负例③：HTTP 404 属业务错误 → 不重试
  {
    let calls = 0;
    global.fetch = async () => { calls++; return { ok: false, status: 404, text: async () => '' }; };
    let err = null;
    try { await H.fetchText('https://restapi.amap.com/404'); } catch (e) { err = e; }
    check('HTTP 404 抛 HMP_HTTP', !!err && err.code === 'HMP_HTTP' && err.status === 404,
      err && (err.code + ' ' + err.status));
    check('HTTP 业务错误不重试（仅 1 次请求）', calls === 1, 'calls=' + calls);
  }

  // ── B. SW 路径 ──
  // 负例④：SW 消息永不回调 → 受 2.5s 超时约束；重试后第二次成功
  {
    env.setup({}); // 带 chrome
    env.load('content/http.js');
    const H2 = global.window.HMP.http;
    let n = 0;
    global.fetch = async () => { throw new Error('直连不应被调用'); };
    global.chrome.runtime = {
      sendMessage(msg, cb) {
        n++;
        if (n === 1) return;                 // 永不回调 → 只能靠超时结束
        setTimeout(() => cb({ ok: true, text: 'SW_OK' }), 10);
      },
      lastError: null,
    };
    const t0 = Date.now();
    const text = await H2.fetchText('https://api.map.baidu.com/x');
    const dt = Date.now() - t0;
    check('SW 消息挂住 → 超时后重试并成功', text === 'SW_OK', text);
    check('SW 超时受 2500ms 约束（2.5–3.2s）', dt >= 2400 && dt <= 3200, dt + 'ms');
    check('SW 重试次数 = 1（共 2 次消息）', n === 2, 'n=' + n);
  }

  // SW 明确失败（无 host 权限）→ 退回直连，不额外重试
  {
    env.setup({});
    env.load('content/http.js');
    const H3 = global.window.HMP.http;
    let msgs = 0, fetches = 0;
    global.chrome.runtime = {
      sendMessage(msg, cb) { msgs++; setTimeout(() => cb({ ok: false, error: 'no permission' }), 5); },
      lastError: null,
    };
    global.fetch = async () => { fetches++; return { ok: true, status: 200, text: async () => 'DIRECT' }; };
    const text = await H3.fetchText('https://api.map.baidu.com/z');
    check('SW 失败 → 退回直连成功', text === 'DIRECT', text);
    check('SW 失败不计入重试（消息 1 次、直连 1 次）', msgs === 1 && fetches === 1,
      'msgs=' + msgs + ' fetches=' + fetches);
  }

  // ── C. 卡片文案：超时 ≠ 未收录 ≠ 有候选但未通过校验 ──
  env.setup({});
  env.loadContentScripts();
  const C = global.window.HMP.card;

  check('分类：超时 → timeout', C.classifyFailure({ timeouts: { amap: true } }, 'amap') === 'timeout',
    String(C.classifyFailure({ timeouts: { amap: true } }, 'amap')));
  check('分类：有候选但未通过校验 → rejected',
    C.classifyFailure({ providerNotes: { amap: '有名称/地址候选但未通过校验' } }, 'amap') === 'rejected');
  check('分类：三路无候选 → no-candidates',
    C.classifyFailure({ providerNotes: { amap: '三路均未搜到候选' } }, 'amap') === 'no-candidates');

  const tNote = C.missingNote('timeout');
  // 产品 §5 定稿文案：正文「地图接口超时（已重试 1 次）」（#03 起统一）
  check('超时文案含「地图接口超时（已重试 1 次）」', tNote.indexOf('地图接口超时（已重试 1 次）') >= 0, tNote);
  check('超时文案**不含**「未搜到」「未收录」',
    tNote.indexOf('未搜到') < 0 && tNote.indexOf('未收录') < 0, tNote);
  const rNote = C.missingNote('rejected');
  check('未通过校验文案含「没有通过校验」', rNote.indexOf('没有通过校验') >= 0, rNote);
  check('未通过校验文案不含「未收录」', rNote.indexOf('未收录') < 0, rNote);

  // 端到端：not-found 卡片渲染出超时文案（不是默认"未找到"）
  C.renderState({
    card: 'single', kind: 'not-found', provider: 'amap', providerLabel: '高德地图',
    failureKind: 'timeout', amapSearchUrl: 'https://x', baiduSearchUrl: 'https://y',
  });
  await sleep(10);
  const rendered = env.textOf(global.__hmpBasicEl.parentNode);
  check('卡片渲染超时文案', rendered.indexOf('地图接口超时（已重试 1 次）') >= 0, rendered.slice(0, 160));
  const tCard = global.document.getElementById(C.CARD_ID);
  check('超时态 data-hmp-state=timeout（与 not-found 可区分）',
    tCard && tCard.attrs['data-hmp-state'] === 'timeout', tCard && tCard.attrs['data-hmp-state']);
  check('超时态状态词为「超时」', rendered.indexOf('超时') >= 0, rendered.slice(0, 60));
  check('超时态有「重试查询」按钮', !!(tCard && tCard.querySelector('.hmp-btn')) && rendered.indexOf('重试查询') >= 0,
    tCard && !!tCard.querySelector('.hmp-btn'));
  check('超时态含补充说明', rendered.indexOf('可能是网络慢或地图服务暂时不可用') >= 0, rendered.slice(0, 160));
  check('卡片不再显示默认「未收录」文案', rendered.indexOf('未被收录') < 0, rendered.slice(0, 120));

  finish();
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
