// card.js
// 监听 POI 加载事件、查询地图 API、把"开放信息"卡片注入到站点详情面板底部。
//
// 形态分流：
//   - 单个 POI（feature_type 是"博物馆" / "风景区" / "5A景区" 等，或 useMemberGeom=false）：
//     直接查高德/百度，显示该 POI 的开放信息。
//   - 文物组（feature_type 是"文物组"，且有 members）：
//     不查当前 POI 自身（聚合级没有"开放时间"概念）。
//     改为列出子项目（members）逐一查询开放信息。
//
// STELE 详情面板的 DOM 结构（来自逆向 /dist/app.js）：
//   modal-root
//   └─ div.modal.fade.show
//      └─ div.modal-dialog
//         └─ div.modal-content
//            └─ div.modal-body
//               ├─ div.poi-section-content-padding#poi-basic-info-section
//               ├─ div.poi-section-content-padding   ← "简介"
//               ├─ div.poi-section-content-padding   ← "基本信息"
//               ├─ div.poi-section-content-padding   ← "子项目"
//               ├─ div.poi-section-content-padding   ← "所属项目"
//               ├─ div.poi-section-content-padding   ← "维基百科信息"
//               ├─ Footprints (评论)
//               └─ Stack.horizontal                 ← "返回"按钮
//
// 注入点：modal-body 内、最后一个 poi-section-content-padding 之后、返回按钮之前。

(function () {
  'use strict';
  window.HMP = window.HMP || {};

  const CARD_ID = 'hmp-opening-card';
  // ========== 工具 ==========

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function el(tag, attrs = {}, children = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') e.className = v;
      else if (k === 'style') e.setAttribute('style', v);
      else if (k.startsWith('on') && typeof v === 'function') {
        e.addEventListener(k.substring(2).toLowerCase(), v);
      } else if (v === false || v == null) {
        // 跳过
      } else {
        e.setAttribute(k, v);
      }
    }
    for (const c of [].concat(children)) {
      if (c == null) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }

  // ========== 卡片渲染 ==========
  //
  // 结构刻意完全套用站点自己的写法，保证视觉一致：
  //   <hr class="poi-section-hr">
  //   <div class="poi-section-content-padding">
  //     <h6 class="poi-section-title">开放信息</h6>
  //     <table class="table-no-border attribute-table" style="...">
  //   </div>
  // 这些类与内联样式都取自 /main.css 与站点渲染代码（app.js）。

  const EL_TABLE_STYLE =
    'margin-bottom:12px;padding-top:4px;border-spacing:0;border-color:#dee2e6;border-collapse:unset';
  const EL_TD_KEY_STYLE = 'min-width:100px';
  const EL_TD_VAL_STYLE = 'white-space:pre-wrap';

  /** 站点同款「两列信息表」 */
  function buildTable(rows) {
    const table = el('table', {
      className: 'table-no-border attribute-table',
      style: EL_TABLE_STYLE
    });
    const tbody = el('tbody');
    for (const r of rows) {
      if (!r || r.value == null || r.value === '') continue;
      const tr = el('tr');
      tr.appendChild(el('td', { style: EL_TD_KEY_STYLE }, r.label));
      const td = el('td', { style: EL_TD_VAL_STYLE });
      if (r.html) td.innerHTML = r.value;
      else td.textContent = String(r.value);
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    return table;
  }

  /** 组装成站点同款 section（hr + content-padding + 蓝色标题） */
  function buildSection(state, bodyChildren) {
    const root = el('div', {
      id: CARD_ID,
      className: 'hmp-card',
      'data-hmp-state': state.kind,
      'data-hmp-feature-type': state.featureType || '',
    });

    root.appendChild(el('hr', { className: 'poi-section-hr' }));

    const body = el('div', { className: 'poi-section-content-padding' });
    body.appendChild(el('h6', { className: 'poi-section-title' }, '开放信息'));
    for (const c of bodyChildren) if (c) body.appendChild(c);
    root.appendChild(body);
    return root;
  }

  /** 查询中 / 无配置 / 出错 / 未匹配 —— 统一的轻量提示块 */
  function buildNote(text) {
    return el('div', { className: 'hmp-note' }, text);
  }

  /**
   * 这个 cost 值像不像"门票价"？
   * 地图的 cost 字段语义不统一，不加判断会出现
   * 「票价 81569.00」（楼盘均价，元/㎡）这种明显荒谬的值。
   */
  function plausiblePrice(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return false;
    if (/免费/.test(s)) return true;                       // "免费" 是有效信息
    // 带面积/时间单位的一律不是门票
    if (/[㎡²]|元\s*\/\s*(平|㎡|m2|月|年|晚|天)|每平|均价/.test(s)) return false;
    const n = parseFloat(s.replace(/[^\d.]/g, ''));
    if (!Number.isFinite(n)) return false;
    return n <= 999;                                       // 门票/人均不可能上千
  }

  /** 页脚：数据来源 + 免责说明（用站点常见的灰色小字） */
  function buildFoot(state) {
    const parts = [];
    if (state.providerLabel) parts.push('来源：' + state.providerLabel);
    parts.push('仅供参考，请以现场公告为准');
    return el('div', { className: 'hmp-foot' }, parts.join(' · '));
  }

  function buildFallbackLinks(amapSearchUrl, baiduSearchUrl) {
    const links = el('div', { className: 'hmp-links' });
    links.appendChild(el('a', { href: amapSearchUrl, target: '_blank', rel: 'noopener noreferrer' },
      '在高德地图中搜索 →'));
    links.appendChild(el('a', { href: baiduSearchUrl, target: '_blank', rel: 'noopener noreferrer' },
      '在百度地图中搜索 →'));
    return links;
  }

  /**
   * 单点位卡片。
   * state.kind: 'loading' | 'no-config' | 'error' | 'not-found' | 'found'
   *
   * 只展示用户要的三类信息：开放时间、票价、地址。
   */
  function buildSingleCard(state) {
    // —— 非结果态：一句提示即可 ——
    if (state.kind === 'loading') {
      return buildSection(state, [buildNote('正在查询开放信息…')]);
    }
    if (state.kind === 'no-config') {
      return buildSection(state, [buildNote('尚未配置地图 API Key，请点击浏览器工具栏图标进行配置。')]);
    }
    if (state.kind === 'error') {
      return buildSection(state, [buildNote('查询出错：' + (state.message || '未知错误'))]);
    }
    if (state.kind === 'not-found') {
      return buildSection(state, [
        buildNote('暂未在地图数据中找到该点位，可能是县区级或未定级文物未被收录。'),
        buildFallbackLinks(state.amapSearchUrl, state.baiduSearchUrl),
      ]);
    }

    // —— 命中 ——
    const info = state.info || {};
    const rows = [];

    // 开放时间：优先用较完整的「一周描述」，没有则退回「今日」
    const hours = info.opentimeWeek || info.opentimeToday || null;
    if (hours) rows.push({ label: '开放时间', value: hours });

    // 票价/费用（地图数据里常有缺失，有才显示）
    // 票价：只在**像门票价**时才显示。
    // 高德的 cost 字段语义并不统一——景点是门票价、餐饮是人均消费，
    // 而匹配到楼盘/小区时会是**房价单价（元/㎡）**：
    // 实测「兆丰花园遗址」显示「81569.00」，就是长宁路780号同名住宅小区的均价。
    if (plausiblePrice(info.cost)) rows.push({ label: '票价', value: info.cost });
    else if (info.cost) console.log('[HMP] 票价字段不可信，已隐藏：' + info.cost);

    // 地址（也用于确认匹配是否找对了点位）
    if (info.address) rows.push({ label: '地址', value: info.address });

    const children = [];

    // 数据源兜底说明：用户首选的那家没用上时，讲清楚为什么
    // （否则表现为"我在设置里切了百度，怎么还是高德的结果"）
    if (state.fallbackNote) {
      children.push(el('div', { className: 'hmp-note' }, 'ℹ ' + state.fallbackNote));
    }
    // 字段级互补说明：开放时间来自另一家地图时注明，避免"来源标签对不上"
    if (state.supplementedBy && state.supplementedFields && state.supplementedFields.length) {
      const src = state.supplementedBy === 'baidu' ? '百度地图' : '高德地图';
      children.push(el('div', { className: 'hmp-note' },
        'ℹ ' + state.supplementedFields.join('、') + '由' + src + '补充'));
    }

    // 「暂停开放 / 已关闭 / 维修中」等状态提醒 —— 放在最前面，避免白跑一趟
    const hint = closureHint(info);
    const probe = state.closureProbe;
    if (hint) {
      children.push(el('div', { className: 'hmp-alert' },
        '⚠ 地图信息显示该点位可能不开放（含「' + hint + '」），建议先电话确认再前往。'));
    } else if (probe) {
      // 状态来自"另一家"：如实写明是哪一家标的，不笼统说"地图信息显示"。
      children.push(el('div', { className: 'hmp-alert' },
        '⚠ ' + label(probe.provider) + '标记该点位可能不开放（含「' + probe.hint +
        '」），建议先电话确认再前往。'));
    }

    // 匹配方式提示：让用户能核对自己看到的是哪个地图 POI。
    // 名称完全一致时以前不提示，结果"开放时间是哪来的"无从判断；
    // 名字一样也仍可能匹配到外地同名点位，所以一律给出"名称 + 直线距离"。
    const d = state.matchDist;
    const distTxt = Number.isFinite(d) ? '（直线约 ' + d + ' 米）' : '';
    const matchedName = info.name || '';
    if (state.matchType === 'location') {
      children.push(el('div', { className: 'hmp-note' },
        '该点位现用名与文保名称不同，已按位置匹配到：' + matchedName + distTxt));
    } else if (matchedName && matchedName !== state.siteName) {
      children.push(el('div', { className: 'hmp-note' },
        '匹配到地图上的：' + matchedName + distTxt));
    } else if (matchedName) {
      children.push(el('div', { className: 'hmp-note' },
        '地图上同名点位：' + matchedName + distTxt));
    }

    if (rows.length) {
      children.push(buildTable(rows));
    } else {
      children.push(buildNote('该点位在地图数据中没有开放时间与票价记录。'));
    }

    children.push(buildFallbackLinks(state.amapSearchUrl, state.baiduSearchUrl));
    children.push(buildFoot(state));
    return buildSection(state, children);
  }

  /**
   * 文物组卡片：逐个子项目列出开放时间。
   * state.kind: 'group-loading' | 'group-no-config' | 'group-error' | 'group-done'
   */
  // ========== 注入 ==========

  /**
   * 找详情面板容器。
   *   1) #poi-basic-info-section 的父节点（站点自己的稳定 id，其父就是 Modal.Body）
   *   2) 任意 .modal-body
   *
   * ⚠️ 绝不回退到 #left-content-container 这类**常驻页面元素**。
   *    它不随详情面板关闭而消失；一旦把卡片插到那里，用户关掉面板后
   *    卡片会一直挂在地图左侧（曾出现过这个 bug）。找不到面板时就应该
   *    什么都不做，并清掉可能残留的卡片。
   */
  function findContainer() {
    const basic = document.getElementById('poi-basic-info-section');
    if (basic && basic.parentNode) return basic.parentNode;
    const modalBody = document.querySelector('.modal-body');
    if (modalBody) return modalBody;
    return null;
  }

  /** 详情面板是否已从 DOM 中消失（关闭/卸载） */
  function panelGone() {
    return !findContainer();
  }

  /** 移除卡片 */
  function removeCard() {
    const card = document.getElementById(CARD_ID);
    if (card && card.parentNode) card.parentNode.removeChild(card);
    // 兜底：万一挂在别处有同名节点
    const others = document.querySelectorAll ? document.querySelectorAll('#' + CARD_ID) : [];
    for (const o of others) if (o.parentNode) o.parentNode.removeChild(o);
  }

  /** 真正插入；返回是否成功 */
  function doInsert(cardEl) {
    const container = findContainer();
    if (!container) return false;

    // 清掉可能存在的旧卡片（可能挂在别处）
    const stale = document.getElementById(CARD_ID);
    if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
    const also = container.querySelector('#' + CARD_ID);
    if (also && also.parentNode) also.parentNode.removeChild(also);

    // 站点详情面板的末尾是「返回」按钮，它本身也带 .poi-section-content-padding 类。
    // 若直接追加，卡片会落到按钮下方；这里优先插到该按钮之前，保持"内容 → 卡片 → 返回"。
    const kids = Array.from(container.children || []);
    let backSection = null;
    for (let i = kids.length - 1; i >= 0; i--) {
      const s = kids[i];
      if (s === cardEl) continue;
      const isSection = s.classList && s.classList.contains('poi-section-content-padding');
      if (!isSection) continue;
      // 返回按钮那段：含 button 且没有小节标题 h6
      const hasBtn = !!(s.querySelector && s.querySelector('button'));
      const hasTitle = !!(s.querySelector && s.querySelector('h6'));
      if (hasBtn && !hasTitle) { backSection = s; break; }
      break;   // 末尾不是按钮段，就不再往前找了
    }

    if (backSection) container.insertBefore(cardEl, backSection);
    else container.appendChild(cardEl);
    return true;
  }

  // 最近一次渲染状态，供"弹窗重建后重新插入"与诊断使用
  let lastState = null;
  // 最近一次打开的文物组：{name, addrQuery, kids:Set, memberNames:Set}。
  //
  // 子项目（如圣约翰大学近代建筑下的「白宫」）在站点数据里**没有门牌号**，
  // 名称又常常是泛词。实测：单搜「白宫」+ 坐标兜底，匹配到了
  // 「中共上海市长宁区委员会」——完全无关。
  // 所以打开组时先把组信息记下来，随后点进来的子项目用它补全：
  //   地址 → 项目组的地址（万航渡路1575号）
  //   检索名 → 「圣约翰大学近代建筑 白宫」打头
  let activeGroupCtx = null;
  // 父项目组上下文缓存（父组 kid → context），避免重复拉取
  const parentCtxCache = new Map();

  // 渲染代次：面板关闭或新渲染发起时自增，让在途的重试循环自行退出
  let renderEpoch = 0;

  /** 取消在途的渲染重试（面板已关闭时调用） */
  function cancelRender() { renderEpoch++; }

  /**
   * 渲染卡片（带重试）。
   *
   * 站点时序是「先拉数据 → 再渲染弹窗」，事件到达时弹窗往往还不存在；
   * 且 `.modal` 上的 `show` 类是后加的（属性变更，childList 观察器看不见）。
   * 所以这里主动轮询等待容器出现，而不是查不到就放弃。
   *
   * @param {object} state 需带 card: 'single' | 'group'
   */
  function renderState(state) {
    lastState = state;
    const epoch = ++renderEpoch;
    let tries = 0;
    const MAX_TRIES = 25;      // 25 × 200ms = 5s
    const attempt = () => {
      if (epoch !== renderEpoch) return;   // 已被新渲染取代，或面板已关闭
      const cardEl = buildSingleCard(state);
      if (doInsert(cardEl)) {
        console.log('[HMP] 卡片已注入 (kind=' + state.kind + ', 第 ' + (tries + 1) + ' 次尝试)');
        return;
      }
      if (tries++ < MAX_TRIES) { setTimeout(attempt, 200); return; }
      console.warn('[HMP] 等待详情面板超时，卡片未插入。请在控制台执行 HMP.debug.inspect() 查看现场。');
    };
    attempt();
  }

  // ========== POI 数据抽取 ==========

  /**
   * 判断是否是"文物组/聚合"POI
   */
  function isGroup(feature) {
    if (!feature) return false;
    if (feature.feature_type === '文物组') return true;
    if (Array.isArray(feature.members) && feature.members.length > 0) return true;
    return false;
  }

  /**
   * 这个点位有没有"保护身份"？只有有身份的才去查开放信息。
   *
   * 遗产地图的底图上还铺了一层普通 POI，它们不是文保也不是世遗：
   *   西郊乡 / 大厦村 / 新天地公园 / 地铁站…  → category = []
   * 而站点正是用 category 表达保护身份的：
   *   息焉堂     → [上海市文物保护单位, 上海市优秀历史建筑]（类型却是"教堂"）
   *   马迭尔宾馆  → [全国重点文物保护单位]                （类型却是"宾馆酒店"）
   * 所以**不能按 feature_type 判断**——宾馆、教堂、公园里都有国保单位。
   *
   * category 字段整个缺失时（站点改字段名）按"有保护身份"处理：
   * 宁可多显示一点，也不要因为字段改名让插件整体失效。
   */
  function isDesignated(feature) {
    if (!feature) return false;
    const c = feature.category;
    if (c === undefined || c === null) return true;   // 字段缺失 → 失败开放
    if (!Array.isArray(c)) return true;
    return c.length > 0;
  }

  /**
   * 抽取单个 POI 字段（博物馆/风景区等）
   */
  function extractPoi(feature) {
    if (!feature || !feature.name) return null;
    let lon = null, lat = null;
    if (feature.geom && Array.isArray(feature.geom.coordinates)) {
      // 单个 POI：直接取顶层 geom
      lon = feature.geom.coordinates[0];
      lat = feature.geom.coordinates[1];
    } else if (feature.members && feature.members.length > 0) {
      // 文物组/聚合POI：取第一个成员的坐标
      const m = feature.members[0];
      if (m.geom && Array.isArray(m.geom.coordinates)) {
        lon = m.geom.coordinates[0];
        lat = m.geom.coordinates[1];
      }
    }
    const admin = Array.isArray(feature.admin) ? feature.admin : [];
    const adminLast = admin[admin.length - 1] || '';
    const naming = window.HMP.naming;
    const geo = window.HMP.geo;

    // 市级名（用于 region 参数）
    const city = naming ? naming.extractCity(admin) : adminLast;

    // ── 检索名 ──
    // 文保名称常与现用名无关（真觉寺金刚宝座 → 北京石刻艺术博物馆），
    // 因此优先用 address/intro 里挖出的「现用名」，再退回文保名及其变体。
    const modernNames = (naming && naming.extractModernNames)
      ? naming.extractModernNames(feature.address, feature.intro && feature.intro.html)
      : [];
    const ownNames = naming ? naming.searchNames(feature.name) : [feature.name];
    const modernVariants = [];
    for (const mn of modernNames) {
      for (const v of (naming ? naming.searchNames(mn) : [mn])) {
        if (!modernVariants.includes(v)) modernVariants.push(v);
      }
    }
    // nameVariants: 全量，用于匹配打分（不截断）
    const nameVariants = [...modernVariants, ...ownNames]
      .filter((v, i, a) => v && a.indexOf(v) === i);
    // searchTerms: 实际发起请求的（截断，控制配额）
    const searchTerms = nameVariants.slice(0, MAX_NAME_VARIANTS);

    // ── 坐标 ──
    // 站点坐标有仿射畸变，必须校正（见 geo.js）；校正后误差约 150 m，
    // 足以支撑「周边搜索」→ 这是解决改名问题的关键。
    let wgs = null, gcj = null, bd09 = null;
    if (geo && Number.isFinite(lon) && Number.isFinite(lat)) {
      wgs = geo.steleToWgs84(lon, lat);
      if (geo.isPlausible(wgs[0], wgs[1])) {
        gcj = geo.wgs84ToGcj02(wgs[0], wgs[1]);
        bd09 = geo.gcj02ToBd09(gcj[0], gcj[1]);
      } else { wgs = null; }
    }

    // 检索地址：admin + address 拼起来就是详情页上显示的那一行，
    // 例如 "上海市 静安区 陕西南路30号"。地址不随改名变化，是最稳定的标识。
    //
    // ⚠️ 必须有真实门牌号才拼。很多子项目/点位**只有行政区没有几号**，
    //    若退化成 "上海市 长宁区" 这种串去当地址搜，会捞回一堆毫不相干的 POI
    //    （实测：「白宫」→「中共上海市长宁区委员会」就是这么来的），
    //    而且地址路径的优先级很高（规则④），错误结果会直接压过名称匹配。
    //    没有门牌号就留空，让地址路径自然跳过。
    const hasAddr = !!(feature.address && String(feature.address).trim());
    const addrQuery = (hasAddr && naming && naming.addressQuery)
      ? naming.addressQuery(admin, feature.address)
      : '';

    return {
      name: feature.name,
      lon, lat, admin, adminLast, city,
      address: feature.address || '',
      addrQuery,
      nameVariants, searchTerms, modernNames,
      wgs, gcj, bd09,
      featureType: feature.feature_type
    };
  }

  // ========== 用户配置 ==========

  function getConfig() {
    return new Promise(resolve => {
      chrome.storage.local.get(
        ['amapKey', 'baiduAk', 'defaultProvider', 'strategyMode', 'enabled'],
        items => {
          resolve({
            amapKey: items.amapKey || '',
            baiduAk: items.baiduAk || '',
            defaultProvider: items.defaultProvider || 'amap',
            // 搜索模式：combine（三路组合，默认）| name | address | geo
            strategyMode: items.strategyMode || 'combine',
            enabled: items.enabled !== false
          });
        }
      );
    });
  }

  /**
   * 决定用哪个数据源、按什么顺序试。
   *
   *   首选的那家排第一，另一家作为**兜底**排第二；没配 Key 的那家不放进列表。
   *
   * 旧实现在「选了百度但没填百度 Key」时会产出 ["amap","amap"] ——
   * 同一家被查两遍，白耗配额，而且用户看到的仍是高德结果却不知道为什么。
   *
   * @returns {{order: string[], missing: string|null}}
   *   order   依次尝试的 provider
   *   missing 用户首选了、但没配 Key 的那家（用于在卡片上说明原因）
   */
  function pickProviders(cfg) {
    const has = { amap: !!cfg.amapKey, baidu: !!cfg.baiduAk };
    const pref = cfg.defaultProvider === 'baidu' ? 'baidu' : 'amap';
    const other = pref === 'amap' ? 'baidu' : 'amap';

    const order = [];
    if (has[pref]) order.push(pref);
    if (has[other]) order.push(other);

    return { order, missing: (!has[pref] && has[other]) ? pref : null };
  }

  // ========== 核心查询逻辑 ==========

  /**
   * 查询单个 POI（可以是文物组的子项目）。
   * 返回 {ok, info?, provider?, error?, candidates?}。
   */
  // 单次查询最多尝试的名称变体数（控制 API 调用量/配额）
  const MAX_NAME_VARIANTS = 3;
  // 达到该相似度即认为足够可信，提前结束变体尝试
  const EARLY_ACCEPT_SIM = 0.95;
  // 名称相似度达到该值即认为"强名称证据"，优先于位置匹配
  const NAME_STRONG_SIM = 0.85;
  // 周边搜索半径（米）。校正后坐标误差约 150 m，1 km 足够留出余量。
  // 候选打分权重（类型 / 距离 / 名称）与"门牌一致"加成。
  // 抽成常量是为了能拿真实案例回归对比不同权重的准确率（见 tools/weight_sweep.js）。
  const W_TYPE = 0.45, W_DIST = 0.20, W_NAME = 0.35;
  const HOUSE_NO_BONUS = 1.5;
  // 门牌号**不一致**时的惩罚。原来只有"一致加成"、没有反向惩罚，
  // 于是"文保在 336 号、候选在 338 号"这种隔壁楼只要名字像就能赢。
  // 用户的要求是：门牌号这个证据要压过名称，所以反向必须罚得动。
  const HOUSE_NO_MISMATCH_PENALTY = 0.85;
  const NEARBY_RADIUS = 1000;
  // 借用项目组地址的子项目（poi.groupName 有值），名称命中必须落在本体附近才算数。
  // 子项目名多是泛词——「白宫」在上海能搜出好几个同名地点，相似度都是 1.0，
  // 若不看距离，决策顺序里的「名称强命中」会直接把远处那个拿走，
  // 项目组地址那一路根本没机会被考虑。
  const GROUP_NAME_MAX_DIST = 1500;
  // 名称命中超过这个距离就不再采信（**对所有点位生效**，不限于子项目）。
  // 站点坐标经仿射校正后误差约 150m，同名地点却在几公里甚至几十公里外，
  // 必然是另一个东西——实测「白宫」这个名字能命中 40 公里外的「白宫民宿(南汇大学城店)」，
  // 而高德的模糊匹配让它的名称相似度依然很高，不卡距离就会被当成"名称强命中"直接采用。
  const NAME_MAX_DIST = 3000;

  // ── 候选分类 ──
  // 关键：**以「类型」字段为准**，不要把名称混进来判断。
  // 曾经踩过的坑：把 type+name 拼在一起且先判"像文物"，导致
  // 「故宫公交站」因为名字里有"宫"被判成文物类，进而被选中。
  //
  // rank: 2=像文物/景点（可参观）, 1=未知, 0=设施/商业类（直接排除）
  // 类型判定：像文物/景点的 POI 才允许在"只有坐标支持"时被采用。
  // 除景点本身外，还包含文保建筑**被征用后的现用身份**——学校、宗教场所、机关办公等。
  // 例：天主教大修院（漕溪北路336号）现在就在徐汇区政府院内，按实写成"徐汇区人民政府"
  //     才是正确结果，不能因为"不是景点"就丢掉。
  // ⚠️ 不能写裸词「政府」：高德把「上海三山会馆管理委」这类社会团体也归在
  //    「政府机构;社会团体」下，写裸词会把该被压下去的管理委抬上来。
  //    只认真正的机关子类。
  const HERITAGE_TYPE_RE = /(博物馆|展览馆|纪念馆|风景名胜|公园|寺庙|文物|古迹|遗址|宗教|美术馆|故居|陵园|文管所|游客中心|文化|古建|塔|宫|寺|观|教堂|影剧院|音乐厅|剧场|剧院|学校|大学|学院|区政府|市政府|省政府|县政府|人民政府|乡镇级政府|其他政府机构|党委|区委|机关|事业单位|管理局|委员会|办事处|街道办)/;
  // 设施类：公交站/地铁站/停车场/打卡点… 都不是"可参观的点位"
  const FACILITY_TYPE_RE = /(公交|地铁|轨道交通|轻轨|车站|停车场|停车楼|加油|充电站|公共厕所|卫生间|出入口|收费站|服务区|通道|天桥|轮渡|码头|打卡|拍照|摄影|门址)/;
  // ⚠️ 这里**刻意不再按"商业类型"排除任何东西**。
  //
  // 判定标准是「这个地方能不能进去、是不是该点位本身」，而不是"是不是商业"。
  // 大量文保建筑现在的身份就是商业设施：
  //   马勒住宅   → 上海马勒别墅饭店（住宿）
  //   上海国际饭店 → 仍是饭店
  //   外滩一批大楼 → 银行/公司/写字楼
  //   永安公司   → 百货商场
  //   圣约翰大学 → 华东政法大学（学校）
  // 按"商业"一刀切会把正确答案一起丢掉。
  //
  // 真正该排除的只有**设施类**（车站/停车场/大门/厕所/打卡点）——
  // 它们是"点位的一部分或配套"，而不是点位本身。这由 FACILITY_* 负责。
  // 若将来需要收紧，应基于"能否入内/是否即点位"来判断，而不是品类。

  // 名称里"一眼就是设施/无关商户"的词。用于类型缺失（百度常返回英文分类）时的兜底。
  // 刻意只收无歧义的词，避免误伤"老火车站旧址"这类文保名称。
  // 「打卡」用裸词：实测存在「XX打卡地」「XX网红打卡」等写法，只写"打卡点"会漏。
  const FACILITY_NAME_RE = /(公交站|公交车站|地铁站|轨道交通站|停车场|停车楼|打卡|拍照点|摄影点|取景地|公共厕所|集散中心|换乘中心)/;
  // 文保点位周围的无关商户（类型字段在百度侧常缺失，只能看名字）
  const COMMERCIAL_NAME_RE = /(按摩|推拿|足疗|足浴|汗蒸|养生馆|美甲|美睫|理发店|美容院|宠物|网咖|棋牌室|便利店|超市|药房)/;
  // 纯门牌号型的 POI：名字就是「路名 + 门牌号」，本身不是一处能去的地方。
  // 实测（真实接口）：地址检索会稳定返回这类条目 ——
  //   商船会馆   → 百度返回「会馆街38号」
  //   上海音乐厅  → 百度返回「延安东路523号」
  // 它们没有开放时间，地址还常是「黄浦区」这种残缺值，
  // 采纳了等于给用户一张空卡片，比"未匹配"更糟（看起来像查到了）。
  const ADDRESS_ONLY_NAME_RE = /^[\u4e00-\u9fa5]{2,10}(?:路|街|道|大街|大道|弄|巷|村|镇)\d{1,5}(?:号|弄|支弄)?$/;

  // 大门/出入口：如「马勒别墅(东门)」。只在**括号内**或**结尾**出现才算，
  // 避免误伤「天安门」「东门老街」这类真实地名。
  const GATE_NAME_RE = /(?:[（(](?:东门|南门|西门|北门|正门|大门|后门|侧门|小门|入口|出口|门口)[）)]|(?:东门|南门|西门|北门|正门|大门|后门|侧门|入口|出口)$)/;

  // 地址里带楼层/房间号的，说明它是楼内的一个单元而非整栋建筑：
  //   上海国际饭店       → 南京西路170号
  //   上海国际饭店-会议中心 → 南京西路170号3层     ← 降权
  // 同样适用于「2号楼」「B1」「东座」这类写法。
  // 注意不要误伤门牌号：24号「甲31号」都不含 层/楼/室/F，不会命中。
  const SUBUNIT_ADDR_RE = /(?:\d+\s*(?:层|楼|室|F)|[Bb]\s*\d+\s*(?:层|室)?|地下\s*\d*|负\s*\d+|[A-Da-d]\s*座)/;
  const SUBUNIT_ADDR_PENALTY = 0.6;

  /**
   * 候选级惩罚系数（三路检索共用一个口径）。
   *   1) 高德标了 parent          → 它是挂在别的 POI 下面的子单元
   *   2) 地址里带楼层/房间号      → 楼内的一个单元，不是整栋建筑
   */
  function structuralPenalty(c) {
    let p = 1;
    if (c && c.parent) p *= 0.7;
    if (c && c.address && SUBUNIT_ADDR_RE.test(String(c.address))) p *= SUBUNIT_ADDR_PENALTY;
    return p;
  }

  /**
   * 完整候选惩罚 = 结构惩罚 × 名称形态惩罚。
   * 名称形态（本体-子单元）由 matcher.subUnitPenalty 判定。
   * 名称检索路径只用 structuralPenalty —— 因为 matcher.pick 内部已经罚过名称形态，
   * 这里再罚会重复。
   */
  // 住宅/商务住宅类：能"借用"文保名，但本身不是可参观的点位。
  // 注意不能一刀切排除——文保本身也可能是小区
  // （站点里就有 feature_type=文物古迹 的「汾阳路152-158号小区」），
  // 所以只在"借名形态"下才降权。
  const RESIDENTIAL_TYPE_RE = /(住宅区|住宅小区|商务住宅|宿舍|别墅区|公寓)/;

  /** 取地址里的门牌号（"长宁路780号" → "780"） */
  function houseNoOf(s) {
    const m = String(s == null ? '' : s).match(/(\d+)\s*号/);
    return m ? m[1] : '';
  }

  /**
   * 门牌号是否一致 —— 地址证据里最硬的一条。
   *   一致   → 这里不给加成（searchByAddress 另有 HOUSE_NO_BONUS）
   *   不一致 → ×0.6，让"名字像但门牌不同"的隔壁楼压不过"门牌对得上"的本体
   * 候选没写地址时不下手（缺数据不等于不同楼）。
   */
  function houseNoPenalty(poi, c) {
    const want = houseNoOf(poi && (poi.addrQuery || poi.address));
    if (!want) return 1;
    const got = houseNoOf(c && c.address);
    if (!got) return 1;
    return got === want ? 1 : HOUSE_NO_MISMATCH_PENALTY;
  }

  /**
   * 小区"借用"文保名 —— 怎么认出来？
   *
   * 实测：「兆丰花园遗址」其实在**中山公园**内（长宁路780号就是中山公园的地址），
   * 而附近一个住宅小区叫「兆丰花园」，借用了这个旧名（中山公园旧称兆丰公园）。
   * 只看名称相似度，小区赢得很轻松（「兆丰花园」⊂「兆丰花园遗址」）。
   *
   * 判据是两个条件同时成立：
   *   ① 候选名正好是文保名的**前缀**（文保名更长）：兆丰花园 ⊂ 兆丰花园遗址
   *   ② 候选类型是**住宅/商务住宅**
   * 这正是"借用旧名卖房子"的典型形态。
   *
   * 反过来，文保本身是小区的（「汾阳路152-158号小区」），候选名与文保名等长，
   * 条件①不成立，不受影响。
   */
  function borrowedNamePenalty(targetName, c) {
    const t = String(targetName || '');
    const n = String((c && c.name) || '');
    if (!t || !n || n.length >= t.length) return 1;      // 名字不比文保名短
    if (t.indexOf(n) !== 0) return 1;                    // 不是前缀
    if (!RESIDENTIAL_TYPE_RE.test(String(c.type || ''))) return 1;   // 不是住宅
    return 0.6;
  }

  function candidatePenalty(c, targetVariants, fullName, poi) {
    const m = window.HMP.matcher;
    const namePen = (m && m.subUnitPenalty)
      ? m.subUnitPenalty(targetVariants || [], c && c.name, fullName) : 1;
    return structuralPenalty(c) * namePen *
      borrowedNamePenalty(fullName, c) * houseNoPenalty(poi, c);
  }

  /** 判断候选 POI 可参观性：2=像文物/景点, 1=未知, 0=设施/商业类（不采用） */
  function heritageRank(poi) {
    const type = String(poi.type || '');
    const name = String(poi.name || '');

    // 名称里明写"公交站/打卡点/东门/按摩店"的，无论类型如何都排除
    if (FACILITY_NAME_RE.test(name)) return 0;
    if (COMMERCIAL_NAME_RE.test(name)) return 0;
    if (GATE_NAME_RE.test(name)) return 0;
    // 纯门牌号（「延安东路523号」「会馆街38号」）——地址条目，不是点位
    if (ADDRESS_ONLY_NAME_RE.test(name)) return 0;

    if (type) {
      // 只按设施类排除；商业/服务类型一律保留（见上面注释）
      if (FACILITY_TYPE_RE.test(type)) return 0;
      if (HERITAGE_TYPE_RE.test(type)) return 2;
      return 1;
    }

    // 类型缺失（百度常见）时才退回看名称
    if (FACILITY_TYPE_RE.test(name)) return 0;
    if (HERITAGE_TYPE_RE.test(name)) return 2;
    return 1;
  }

  // "可能不开放"的信号词。地图数据有时把状态直接写进 POI 名称，
  // 例如高德的「董家渡天主堂（暂停开放）」；百度则放在 status 字段里。
  const CLOSED_RE = /暂停|停业|歇业|关闭|闭馆|闭园|停办|暂不开放|不对外开放|未开放|维修|整修|装修|施工|改造|修缮|废弃|已拆除|拆除/;

  /**
   * 从匹配结果里找出"可能不开放"的信号。
   * @returns {string|null} 命中的关键词，例如 "暂停"
   */
  function closureHint(info) {
    if (!info) return null;
    // 两家把"可能不开放"的信号放在不同位置，都要看：
    //   · 名称本身    —— 「董家渡天主堂（暂停开放）」
    //   · status      —— 百度顶层 status
    //   · tag         —— 百度的 detail_info.tag / 高德的 business.tag
    //   · 开放时间本身 —— 高德 business.opentime_today / _week、
    //                    百度 detail_info.shop_hours
    // 最后这一类最容易被漏掉，偏偏又是最常见的：暂停营业的点位，
    // 两家的"营业时间"字段里写的直接就是「暂停开放」「暂停营业」。
    // 只扫前三个字段时，卡片会把这个串当开放时间显示出来，却不给任何提醒。
    const hay = [info.name, info.status, info.tag,
      info.opentimeToday, info.opentimeWeek].filter(Boolean).join(' ');
    const m = hay.match(CLOSED_RE);
    if (m) return m[0];
    // 很短的 description 常是状态说明（"暂停营业"）；
    // 长段落是介绍文字，里面出现"修缮/拆除"多半是历史叙述，不能当关闭信号。
    const desc = String(info.description || '');
    if (desc && desc.length <= 30) {
      const md = desc.match(CLOSED_RE);
      if (md) return md[0];
    }
    return null;
  }

  /**
   * 路径一：在某个数据源上，用若干「名称变体」做关键字检索。
   * 变体按"从具体到宽泛"逐个尝试；达到 EARLY_ACCEPT_SIM 提前结束。
   * @returns {Promise<{matched, info, provider}|null>}
   */
  async function searchByName(cfg, provider, poi) {
    const api = window.HMP.apis[provider];
    const region = poi.city || '';
    const variants = (poi.searchTerms && poi.searchTerms.length
      ? poi.searchTerms
      : [poi.name]);

    const args = { name: '', region };
    if (provider === 'amap') args.key = cfg.amapKey;
    else args.ak = cfg.baiduAk;

    // 匹配打分用的目标坐标：必须与候选同系（高德 GCJ02 / 百度 BD09），
    // 否则距离会整体偏 ~340 km 而失去意义。
    // 没有可用坐标时退回 Infinity，距离项自动中性（见 matcher.passes）。
    const ref = provider === 'amap' ? poi.gcj : poi.bd09;
    const target = ref
      ? { ...poi, lon: ref[0], lat: ref[1] }
      : { ...poi, lon: null, lat: null };

    const seen = new Set();
    // 子项反查出来的"父 POI" uid 集合（百度专用，见下方 resolveParents）
    const parentIds = new Set();
    let best = null;
    // 统计请求失败：如果**每个**变体都失败（例如跨域被拦），
    // 不能静默返回 null —— 那会被上层记成"未搜到候选"，
    // 掩盖真正的失败原因（这正是百度侧长期被误判的原因）。
    let tried = 0, errored = 0, lastErr = null;

    for (const variant of variants) {
      let candidates;
      tried++;
      try {
        candidates = await api.search({ ...args, name: variant });
      } catch (e) {
        errored++; lastErr = e;
        console.warn('[HMP]', provider, '名称检索失败(变体:"' + variant + '")：', e.message);
        continue;
      }
      const fresh = [];
      const dropped = [];
      for (const c of candidates) {
        // ⚠ 必须在设施类过滤**之前**收集 parent_id：
        // 百度把"本体"藏在子项后面（门 / 停车场），而子项本身会被当设施丢掉。
        if (c.parentId) parentIds.add(c.parentId);
        const k = c.id || c.uid || c.name;
        if (!k || seen.has(k)) continue;
        seen.add(k);
        // 设施类/商业类直接丢弃：公交站、地铁站、停车场、打卡点…
        // 宁可显示"未匹配"，也不要把公交站的信息当成文保点位的开放信息。
        if (heritageRank(c) === 0) { dropped.push(c); continue; }
        fresh.push(c);
      }
      console.log('[HMP]', provider, '名称检索 "' + variant + '" → ' +
        candidates.length + ' 条候选' +
        (dropped.length ? '（已排除 ' + dropped.length + ' 个设施/商业类：' +
          dropped.slice(0, 3).map(c => c.name).join(' / ') + '）' : '') +
        (fresh.length ? '：' + fresh.slice(0, 3).map(c => c.name).join(' / ') : ''));
      if (!fresh.length) continue;

      // 传入类型偏好：同名候选中优先可参观的（博物馆/景点），
      // 例如「上海三山会馆」（博物馆）胜过「上海三山会馆管理委」（办事机构）
      const cand = [];
      const matched = window.HMP.matcher.pick(target, fresh, {
        rank: heritageRank,
        // 结构惩罚 + 住宅"借用文保名"的惩罚
        penalty: (c) => structuralPenalty(c) * borrowedNamePenalty(poi.name, c) *
          houseNoPenalty(poi, c),
        dump: cand,
      });
      // 选中的是「本体-子单元」时，把候选次序抄一份出来：
      // 这能直接回答"本体到底在不在候选里、排第几、为什么输"。
      if (matched && matched.isSub) {
        console.log('[HMP]', provider, '候选次序（sim/score/是否子单元/距离）：' +
          cand.slice(0, 6).map(x => x.name + '(' + x.sim.toFixed(2) + '/' +
            x.score.toFixed(2) + (x.isSub ? '/子' : '') +
            (x.dist == null ? '' : '/' + x.dist + 'm') + ')').join('  '));
      }
      if (matched && (!best || matched.sim > best.sim)) best = matched;
      if (best && best.sim >= EARLY_ACCEPT_SIM) break;
    }

    // ── 子项反查父 POI（百度）──
    // 实测：搜「上海音乐厅」，百度只返回
    // 「凯迪拉克·上海音乐厅-正门 / -东门 / -地下停车场」——它们全被当设施丢掉，
    // 于是名称路径一无所获，最后落到坐标兜底，误配到 451 m 外的另一个馆。
    // 而这些子项带 parent_id，反查 place/v2/detail 就能拿到本体
    // 「凯迪拉克·上海音乐厅」（tag=休闲娱乐;剧院，shop_hours=09:00-20:00）。
    if ((!best || best.isSub) && parentIds.size &&
        typeof api.detail === 'function' && provider === 'baidu') {
      for (const uid of parentIds) {
        let parent = null;
        try {
          parent = await api.detail({ ak: cfg.baiduAk, uid });
        } catch (e) {
          console.warn('[HMP]', provider, '父 POI 反查失败(' + uid + ')：' + e.message);
          continue;
        }
        if (!parent) continue;
        if (heritageRank(parent) === 0) {
          console.log('[HMP]', provider, '父 POI「' + parent.name + '」属设施类，不采用');
          continue;
        }
        const m = window.HMP.matcher.pick(target, [parent], {
          rank: heritageRank,
          penalty: (c) => structuralPenalty(c) * borrowedNamePenalty(poi.name, c) *
            houseNoPenalty(poi, c),
        });
        if (!m) {
          console.log('[HMP]', provider, '父 POI「' + parent.name +
            '」与本点位名称不符（sim ' + window.HMP.matcher.nameScore(poi.name, parent.name).toFixed(2) + '）');
          continue;
        }
        console.log('[HMP]', provider, '✅ 由子项的 parent_id 反查到本体「' +
          parent.name + '」（sim ' + m.sim.toFixed(2) + '）');
        // ⚠ 不能写成 m.sim > best.sim：子单元的相似度**同样是 1.00**。
        //   nameScore 会把候选名按连接号拆成变体——"商船会馆-音乐剧《耋戏生》"
        //   拆出"商船会馆"，与目标逐字相同 → sim 1.00。
        //   于是"严格大于"永远换不掉它，反查白做（实测踩过：
        //   商船会馆 仍被子单元/坐标兜底顶掉）。
        //   反查出来的**本体**优先于任何"本体-子单元"形态。
        if (!best || best.isSub || m.sim > best.sim) best = m;
      }
    }

    if (!best) {
      if (tried > 0 && errored === tried) throw lastErr;   // 全是请求失败
      console.log('[HMP]', provider, '名称检索无可用匹配');
      return null;
    }
    console.log('[HMP]', provider, '名称命中："' + best.poi.name +
      '"，相似度 ' + best.sim.toFixed(3) +
      (Number.isFinite(best.dist) ? '，直线 ' + Math.round(best.dist) + 'm' : ''));
    // 带上距离：名称相同时卡片也要能显示"离这个点位多远"，
    // 否则匹配到外地/另一个同名点位时用户无从察觉。
    return {
      matched: best, info: api.extract(best.poi), provider, matchType: 'name',
      dist: best.dist
    };
  }

  /**
   * 路径二：用**校正后**的坐标做周边搜索，找回该位置上的 POI。
   *
   * 这是解决「文保名称 ≠ 现用名」的关键：
   *   真觉寺金刚宝座  →（同位置）→ 北京石刻艺术博物馆
   * 名称毫无关联，但位置相同，所以只能靠坐标。
   *
   * @returns {Promise<{poi, dist, info, provider, matchType}|null>}
   */
  async function searchNearby(cfg, provider, poi) {
    const api = window.HMP.apis[provider];
    const geo = window.HMP.geo;
    if (!geo || !poi.gcj) return null;

    // 高德用 GCJ02；百度用 BD09 传入、GCJ02 返回
    const location = provider === 'amap' ? poi.gcj : poi.bd09;
    if (!location) return null;

    const args = { location, radius: NEARBY_RADIUS };
    if (provider === 'amap') args.key = cfg.amapKey;
    else args.ak = cfg.baiduAk;

    let candidates;
    let lastErr = null;
    try {
      candidates = await api.searchAround(args);
      // 类目串无果时，用点位自己的名称在**同一位置**重试一次。
      //
      // 这是通用策略，不按数据源分叉——两家都是"宽泛类目词可能匹配不到"，
      // 而单个名称词一定合法（不依赖任何分隔符语义，比如百度侧的 '$'）。
      // 覆盖"名字略有差异、但就在附近"的情形。
      if ((!candidates || !candidates.length) && poi.name) {
        console.log('[HMP]', provider, '类目检索无候选 → 改用点位名称重试');
        candidates = await api.searchAround(Object.assign({}, args, { query: poi.name }));
      }
    } catch (e) {
      console.warn('[HMP]', provider, '周边检索失败：', e.message);
      throw e;      // 请求失败 ≠ 没搜到，必须让上层区分开
    }
    if (!candidates || !candidates.length) {
      console.log('[HMP]', provider, '周边检索（半径 ' + NEARBY_RADIUS + 'm）无候选');
      return null;
    }
    console.log('[HMP]', provider, '周边检索 → ' + candidates.length + ' 条候选');

    // 设施/门址一律不采用：公交站、停车场、厕所，以及「圆明园（东门）」这类大门。
    // 名称路径与地址路径早就过滤了，坐标路径此前漏了 ——
    // 结果大型场地（圆明园这类多门场地）会被"最近的大门"抢走，
    // 最终指向「圆明园（东门）」而不是「圆明园」本身。
    const usable = [];
    const dropped = [];
    for (const c of candidates) {
      if (heritageRank(c) === 0) dropped.push(c); else usable.push(c);
    }
    if (dropped.length) {
      console.log('[HMP]', provider, '周边检索已排除 ' + dropped.length +
        ' 个设施/门址：' + dropped.slice(0, 3).map(c => c.name).join(' / '));
    }
    if (!usable.length) return null;

    // 参考点必须与候选坐标系一致：
    //   高德 → 恒为 GCJ02，故用 poi.gcj
    //   百度 → 不传 ret_coordtype，返回原生 BD09，故用 poi.bd09
    const ref = provider === 'amap' ? poi.gcj : poi.bd09;
    if (!ref) return null;
    // 目标名变体（含从 address/intro 挖出的「现用名」），用于衡量候选名像不像
    const targetVariants = (Array.isArray(poi.nameVariants) && poi.nameVariants.length)
      ? poi.nameVariants : [poi.name];
    const bestNameSim = (candName) => {
      let best = 0;
      for (const v of targetVariants) {
        const s = window.HMP.matcher.nameScore(v, candName || '');
        if (s > best) best = s;
        if (best >= 1) break;
      }
      return best;
    };

    const scored = [];
    for (const c of candidates) {
      const dist = geo.distance(ref[0], ref[1], c.lon, c.lat);
      if (!Number.isFinite(dist) || dist > NEARBY_RADIUS) continue;
      const rank = heritageRank(c);
      // 明显无关的商业 POI 直接丢弃
      if (rank === 0) continue;

      const distScore = 1 - dist / NEARBY_RADIUS;      // 0..1
      const typeScore = rank === 2 ? 1 : 0.35;
      const nameSim = bestNameSim(c.name);

      // 名称权重提到 0.35：改名场景下「现用名」也在 variants 里，
      // 所以提高权重不会伤害改名匹配，却能显著压住无关的近距离 POI。
      let score = typeScore * W_TYPE + distScore * W_DIST + nameSim * W_NAME;

      // 候选级惩罚：高德 parent 标注 + 地址含楼层（统一口径，见 candidatePenalty）
      const pen = candidatePenalty(c, targetVariants, poi.name, poi);
      score *= pen;

      scored.push({ poi: c, dist, rank, nameSim, isSub: pen < 1, score });
    }
    if (!scored.length) {
      console.log('[HMP]', provider, '周边候选全部被过滤（超半径或属商业 POI）');
      return null;
    }

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    console.log('[HMP]', provider, '位置命中："' + best.poi.name +
      '"，直线 ' + Math.round(best.dist) + 'm，名称相似度 ' + best.nameSim.toFixed(3) +
      (best.isSub ? '（子单元，已降权）' : ''));
    return {
      matched: { poi: best.poi, sim: best.nameSim, dist: best.dist },
      info: api.extract(best.poi),
      provider,
      matchType: 'location',
      dist: best.dist
    };
  }

  /**
   * 路径三：按「行政区 + 门牌」检索。
   *
   * 地址是**最稳定**的标识——文保单位改名完全不影响门牌号：
   *   真觉寺金刚宝座 → 北京石刻艺术博物馆（五塔寺村24号）
   *   马勒住宅       → 马勒别墅饭店（陕西南路30号）
   * 拿到的候选再按「类型像不像文物景点 + 离校正坐标的距离」排序，
   * 避免选到同一条街上的商户。
   *
   * @returns {Promise<{matched, info, provider, matchType}|null>}
   */
  async function searchByAddress(cfg, provider, poi) {
    let q = poi.addrQuery;
    if (!q) return null;

    const api = window.HMP.apis[provider];
    const geo = window.HMP.geo;
    // ⚠️ 必须带 region（城市）——这是**百度强制要求**的：
    //    place/v2/search 必须提供 region（行政区划）、location+radius（圆形）
    //    或 bounds（矩形）三者之一，全空会直接返回 status=2 Parameter Invalid。
    //    旧实现传 region:''（"关键字本身已是完整地址，不必再拼"）是高德视角的推理——
    //    高德的 city 只是可选过滤器，百度却是必填项之一。
    //    对高德来说多带一个 city 也无害（只是把范围收窄到该市）。
    const args = { region: poi.city || '' };
    if (provider === 'amap') args.key = cfg.amapKey;
    else args.ak = cfg.baiduAk;

    // 关键字放宽序列：完整「市 区 门牌」→「区 门牌」→ 裸门牌。
    // 高德的 place/text 对过长或带市名的关键字有时直接返回空，
    // 放宽一级往往就能命中——这正是"子项目单开能匹配、进表格却未匹配"的主因之一。
    const forms = [];
    const addForm = (s) => {
      const t = String(s || '').trim();
      if (t && !forms.includes(t)) forms.push(t);
    };
    addForm(poi.addrQuery);
    addForm(String(poi.addrQuery || '').replace(/^\S*?市\s*/, ''));   // 去掉最前面的市名
    addForm(poi.address);                                             // 裸门牌

    let candidates = null;
    let usedQ = poi.addrQuery;
    let tried = 0, errored = 0, lastErr = null;
    for (const form of forms) {
      tried++;
      try {
        candidates = await api.search({ ...args, name: form });
      } catch (e) {
        errored++; lastErr = e;
        console.warn('[HMP]', provider, '地址检索失败（"' + form + '"）：', e.message);
        candidates = null;
      }
      usedQ = form;
      if (candidates && candidates.length) break;
      console.log('[HMP]', provider, '地址检索 "' + form + '" → 无候选' +
        (forms.indexOf(form) < forms.length - 1 ? '，放宽关键字再试' : ''));
    }
    q = usedQ;                              // 后面日志/打分都用实际生效的关键字
    if (!candidates || !candidates.length) {
      if (tried > 0 && errored === tried) throw lastErr;   // 全是请求失败
      return null;
    }
    const usable = [];
    const dropped = [];
    for (const c of candidates) {
      if (heritageRank(c) === 0) dropped.push(c); else usable.push(c);
    }
    console.log('[HMP]', provider, '地址检索 "' + q + '" → ' + candidates.length + ' 条候选' +
      (dropped.length ? '（已排除 ' + dropped.length + ' 个设施/商业类：' +
        dropped.slice(0, 2).map(c => c.name).join(' / ') + '）' : '') +
      (usable.length ? '：' + usable.slice(0, 3).map(c => c.name).join(' / ') : ''));
    if (!usable.length) return null;

    // 与周边检索同一套打分：类型 + 距离 + 名称变体相似度。
    // 地址取自项目组时改用**组的中心与组名**，好让同组所有子项落到同一个点位上。
    const fromGroup = !!poi.addrFromGroup;
    const groupRef = fromGroup && poi.groupRef
      ? (provider === 'amap' ? poi.groupRef.amap : poi.groupRef.baidu) : null;
    const ref = (groupRef && Number.isFinite(groupRef[0])) ? groupRef
      : (provider === 'amap' ? poi.gcj : poi.bd09);
    const baseVariants = (Array.isArray(poi.nameVariants) && poi.nameVariants.length)
      ? poi.nameVariants : [poi.name];
    const targetVariants = (fromGroup && Array.isArray(poi.groupVariants) && poi.groupVariants.length)
      ? poi.groupVariants.concat(baseVariants) : baseVariants;
    const bestNameSim = (n) => {
      let b = 0;
      for (const v of targetVariants) {
        const s = window.HMP.matcher.nameScore(v, n || '');
        if (s > b) b = s;
        if (b >= 1) break;
      }
      return b;
    };

    // 地址检索的关键是「同一个门牌」。隔壁大楼（如大华汇智大厦）经常也出现在候选里，
    // 只有门牌号一致的才真的是这个地址上的本体，给它一点加成。
    const wantNo = houseNoOf(poi.addrQuery) || houseNoOf(poi.address);

    // 地址来自项目组时，优先"整体性"点位，而不是组内的某一栋楼。
    // 实测：万航渡路1575号下的候选里，圣约翰大学旧址 与 圣约翰大学校长故居
    // 对组名的相似度是**并列**的，只靠距离分胜负就会选中某一栋楼；
    // 而子项目本身查不到名字时，用户想看的是"整组落在哪"。
    const CONTAINER_NAME_RE = /(旧址|校区|校园|园区|大院|大学|学院|景区|公园|建筑群)$/;
    const isContainer = (n) => CONTAINER_NAME_RE.test(
      String(n || "").replace(/[（(][^）)]*[）)]s*$$/, ""));

    const scored = usable.map(c => {
      const dist = (geo && ref && Number.isFinite(ref[0]) && Number.isFinite(c.lon))
        ? geo.distance(ref[0], ref[1], c.lon, c.lat)
        : Infinity;
      const rank = heritageRank(c);
      const typeScore = rank === 2 ? 1 : 0.35;
      const distScore = !Number.isFinite(dist) ? 0.4
        : Math.max(0, 1 - dist / NEARBY_RADIUS);
      const nameSim = bestNameSim(c.name);
      const noBonus = (wantNo && houseNoOf(c.address) === wantNo) ? HOUSE_NO_BONUS : 1;
      const containerBonus = (fromGroup && isContainer(c.name)) ? 1.15 : 1;
      const score = (typeScore * W_TYPE + distScore * W_DIST + nameSim * W_NAME) *
        candidatePenalty(c, targetVariants, poi.name) * noBonus * containerBonus;
      return { poi: c, dist, rank, nameSim, score };
    });
    scored.sort((a, b) => (b.score - a.score) || (a.dist - b.dist));
    const best = scored[0];
    console.log('[HMP]', provider, '地址命中："' + best.poi.name + '"' +
      (Number.isFinite(best.dist) ? '，直线 ' + Math.round(best.dist) + 'm' : '') +
      '，名称相似度 ' + best.nameSim.toFixed(3));

    return {
      matched: { poi: best.poi, sim: best.nameSim, dist: best.dist },
      info: api.extract(best.poi),
      provider,
      matchType: 'address'
    };
  }

  /**
   * 查询单个 POI（也可以是文物组的子项目）。
   *
   * 依次尝试三种手段（主策略优先）：
   *   1) 名称检索——命中且 sim ≥ 0.85 视为强证据，直接采用
   *   2) 地址检索——基于"在同一条街上"，命中即采用
   *   3) 坐标周边——基于"就在那儿"，命中即采用
   *   都只有弱名称命中时，才退回弱结果。
   *
   * @returns {Promise<{ok:boolean, info?:object, provider?:string, matchType?:string}>}
   */
  /**
   * 跑**一家**数据源的三路检索，返回该家的结论（ok:true 或 null）。
   * 抽出来是为了让 queryOnePoi 能在拿到结果后再做"字段级互补"。
   */
  async function runProvider(cfg, poi, provider, diag, order, pass) {
    // ⚠️ 只写 providerNotes，不碰 usedProvider/fallbackFrom。
    // "谁在兜底"由 queryOnePoi 的主循环决定；补充查询（pass='supplement'）
    // 复用了同一个函数，若在这里写就会把 main pass 的结论覆盖掉
    // （实测：补充一次之后 fallbackFrom 被误写成 'baidu'）。
    {
      // ── 组合优于切换：三路都跑，用交叉印证来取舍 ──
      // 三种手段的弱点是互补的：名称怕改名、地址怕旧门牌、坐标怕隔壁商户。
      // 只跑一路时，"仅被坐标支持"的隔壁商户就会胜出（实测踩过按摩店/打卡点）。
      const mode = cfg.strategyMode || 'combine';
      // 「状态探针」：只跑名称检索这一路。
      // 目的不是取开放时间/票价，而是看另一家的**状态字段**（tag / shop_hours）。
      // 首选那家已有开放时间时，supplementFields 不会再问另一家，
      // 于是"暂停开放"若恰好在另一家身上就永远拿不到（实测：董家渡天主堂）。
      // 这里只花 1 次请求，而不是三路各一次。
      const probeOnly = pass === 'status-probe';
      const useName = probeOnly || (mode === 'combine' || mode === 'name');
      const useAddr = !probeOnly && (mode === 'combine' || mode === 'address');
      // 文物组子项目不做坐标兜底：否则每栋楼都会套上外圈大学/景区的信息
      const useGeo = !probeOnly && (mode === 'combine' || mode === 'geo') && !poi.noGeoFallback;

      let byName = null, byAddr = null, byGeo = null;
      // 记录这一家失败/无果的**具体**原因，供卡片上说明"为什么回退"。
      // 否则只能笼统说"未返回结果"，无法区分"请求报错""没搜到""搜到但没通过校验"。
      const why = [];
      if (useName) { try { byName = await searchByName(cfg, provider, poi); } catch (e) {
        why.push('名称检索失败：' + e.message);
        console.warn('[HMP]', provider, '名称检索异常：', e.message);
      } }
      if (useAddr) { try { byAddr = await searchByAddress(cfg, provider, poi); } catch (e) {
        why.push('地址检索失败：' + e.message);
        console.warn('[HMP]', provider, '地址检索异常：', e.message);
      } }
      if (useGeo) { try { byGeo = await searchNearby(cfg, provider, poi); } catch (e) {
        why.push('坐标检索失败：' + e.message);
        console.warn('[HMP]', provider, '坐标检索异常：', e.message);
      } }
      if (diag) {
        const got = [byName && '名称', byAddr && '地址', byGeo && '坐标'].filter(Boolean);
        diag.providerNotes = diag.providerNotes || {};
        diag.providerNotes[provider] = why.length
          ? why.join('；')
          : (got.length ? '有' + got.join('/') + '候选但未通过校验' : '三路均未搜到候选');
      }

      const idOf = r => r && r.matched && r.matched.poi &&
        (r.matched.poi.id || r.matched.poi.uid || r.matched.poi.name);
      const same = (a, b) => { const x = idOf(a), y = idOf(b); return !!x && x === y; };
      // 借用项目组地址的子项目：名称太远就不认（见 GROUP_NAME_MAX_DIST 注释）
      const nameDist = (byName && Number.isFinite(byName.matched.dist))
        ? byName.matched.dist : Infinity;
      // 两种闸门取严的那个：
      //   · 任何点位：名称命中不得远于 NAME_MAX_DIST
      //   · 借用项目组地址的子项目：更严，用 GROUP_NAME_MAX_DIST
      const distLimit = poi.groupName ? GROUP_NAME_MAX_DIST : NAME_MAX_DIST;
      const nameTooFar = !!(byName && nameDist > distLimit);
      // 命中的是"借用文保名"的住宅/小区？（如「兆丰花园遗址」→「兆丰花园」小区）
      // 这类候选名字长得像，只是因为**借用了这个名字**，不是本体。
      // borrowedNamePenalty 此前只参与排序，不影响"强命中"判定——
      // 于是相似度 1.0 的借用名会直接命中规则②，轮不到后面
      // "地址+坐标双重印证"的正确结果（实测：兆丰花园遗址 应为中山公园）。
      const nameBorrowed = !!(byName && borrowedNamePenalty(poi.name, byName.matched.poi) < 1);
      // 命中「本体-子单元」形态？（如「商船会馆-音乐剧《耋戏生》」）
      // 与借用名同型的问题：subUnitPenalty 只参与**排序**，不影响"强命中"**判定**，
      // 于是包含关系带来的 sim≈1.0 会直接命中规则②，轮不到坐标准确的"本体"。
      const nameSubUnit = !!(byName && window.HMP.matcher.subUnitPenalty &&
        window.HMP.matcher.subUnitPenalty(
          (Array.isArray(poi.nameVariants) && poi.nameVariants.length) ? poi.nameVariants : [poi.name],
          byName.matched.poi.name, poi.name) < 1);
      if (nameSubUnit) {
        console.log('[HMP]', provider, '名称命中「' + byName.matched.poi.name +
          '」属「本体-子单元」形态 → 不作强命中，交给其它证据');
      }
      const strongName = byName && byName.matched.sim >= NAME_STRONG_SIM &&
        !nameTooFar && !nameBorrowed && !nameSubUnit;
      if (nameBorrowed) {
        console.log('[HMP]', provider, '名称强命中「' + byName.matched.poi.name +
          '」但属借用文保名的住宅类 → 不作强命中，交给地址/坐标印证');
      }
      if (nameTooFar) {
        console.log("[HMP]", provider, "名称命中「" + byName.matched.poi.name +
          "」距本体 " + Math.round(nameDist) + "m，超过 " + distLimit + "m → 不采用");
      }
      const geoIsHeritage = byGeo && heritageRank(byGeo.matched.poi) === 2;

      console.log('[HMP]', provider, '三路结果：' +
        '名称=' + (byName ? byName.matched.poi.name + '(' +
          byName.matched.sim.toFixed(2) + (strongName ? ',强)' : ',弱)') : '无') +
        ' 地址=' + (byAddr ? byAddr.matched.poi.name : '无') +
        ' 坐标=' + (byGeo ? byGeo.matched.poi.name : '无'));

      // 诊断出口：把三路各自找到了什么交给调用方（文物组用它逐行汇总）。
      // 排查"为什么这一行未匹配"时，靠的就是这三格。
      if (poi.diagSink) {
        poi.diagSink.push({
          名称: byName ? byName.matched.poi.name + '(' + byName.matched.sim.toFixed(2) + ')' : null,
          地址: byAddr ? byAddr.matched.poi.name : null,
          坐标: byGeo ? byGeo.matched.poi.name : null,
        });
      }

      // ── 决策原则：**任何单一证据都不直接拍板**，优先采用多路互相印证的结果 ──
      //
      // 起因：「名称强命中」曾被当作独立充分的证据直接返回，但"名字像"恰恰是
      // 最容易被骗的一路——同名外地点位、同景区子单元、以及**借用文保名**的小区
      // （兆丰花园遗址 → 同名住宅小区「兆丰花园」，名称相似度 1.0）都栽在这里。
      // 而地址（门牌号不随改名变化）与坐标（就在那儿）能互相兜住。
      //
      // 印证强度分三级，同一处点位的证据越多越可信：
      //   三重印证：名称 = 地址 = 坐标
      //   两两印证：任意两路指向同一点位（含名称的优先，名称定位最精确）
      //   单一证据：只有一路有结果 —— 仍可采用，但标注"未经印证"，可信度最低
      const addrBorrowed = !!(byAddr && borrowedNamePenalty(poi.name, byAddr.matched.poi) < 1);
      const nA = same(byName, byAddr);
      const nG = same(byName, byGeo);
      const aG = same(byAddr, byGeo);

      const adopt = (hit, level) => {
        console.log('[HMP] ✅ ' + level + '：' + hit.matched.poi.name);
        return { ok: true, ...hit, verifiedBy: level };
      };

      // 印证成立时采纳哪一路的**名义**？
      // 名称一路若命中「本体-子单元」（"商船会馆-音乐剧《耋戏生》"），
      // 子单元的名字不是这个点位本身的名字，采纳它等于把用户带到隔壁去；
      // 既然地址/坐标那一路印证了同一处地方，就用那一路的名义（通常正是本体）。
      const nameSide = () => {
        if (!nameSubUnit) return byName;
        const alt = byAddr || byGeo;
        if (alt) {
          console.log('[HMP]', provider, '印证成立，但名称一路是子单元 → 改用「' +
            alt.matched.poi.name + '」的名义');
        }
        return alt || byName;
      };

      // ① 三重印证 —— 最强，不需要任何附加条件
      if (nA && nG) return adopt(nameSide(), '三重印证（名称+地址+坐标）');
      // ② 两两印证（含名称的优先：名称能精确到具体 POI）
      if (nA) return adopt(nameSide(), '两路印证（名称+地址）');
      if (nG) return adopt(nameSide(), '两路印证（名称+坐标）');
      if (aG) return adopt(byAddr, '两路印证（地址+坐标）');

      // ③ 以下都是"只有一路有结果"。仍然采用（有结果总比空着强），
      //    但标注清楚未经印证，让用户自己判断。
      if (strongName) {
        return adopt(byName, '仅名称（sim ' + byName.matched.sim.toFixed(2) + '，未经地址/坐标印证）');
      }
      // 地址命中 —— 门牌号不随改名变化，可靠性高于纯坐标。
      // 但若命中的是"借用文保名"的住宅/小区，这条就不成立：
      // 「兆丰花园遗址」其实在中山公园内（长宁路780号就是中山公园的地址），
      // 而 780 号上还有个同名住宅小区「兆丰花园」。
      const addrStrong = !!(byAddr && !addrBorrowed && byAddr.matched.sim >= NAME_STRONG_SIM);
      if (addrStrong) return adopt(byAddr, '仅地址（未经名称/坐标印证）');
      if (addrBorrowed) {
        console.log('[HMP]', provider, '地址命中「' + byAddr.matched.poi.name +
          '」是借用文保名的住宅类 → 让位给坐标路径');
      }
      // 坐标命中 —— 只有类型确实像文物/景点才采用。
      // 否则就是"只被坐标支持的隔壁商户"，可信度最低，宁可不匹配。
      //
      // ⚠ 这一步要排在"名字对不上的地址命中"之前。地址检索是在一段**地址串**上
      //   找 POI，同一地址上有消防队、居委会、商铺……名字可以毫不相干，
      //   但坐标就在原地。实测：上海马桥遗址 → 地址命中相似度 0.182 的
      //   「闵行区马桥镇专职消防队」(1090 m)，而坐标路径就在 218 m 外
      //   找到了正确的「马桥古文化遗址公园」。
      if (geoIsHeritage) return adopt(byGeo, '仅坐标（类型像文物景点，未经名称/地址印证）');
      if (byGeo) {
        console.log('[HMP]', provider, '坐标命中但类型不像文物景点，不采用：' +
          byGeo.matched.poi.name);
      }
      // 名称命中即使不够"强"，只要**类型确实像文物/景点**，也比"名字毫不相干的
      // 地址命中"可信 —— 后者只是"同一个地址上的另一个单位"。
      // 实测：崧泽遗址 → 名称命中「崧泽古文化遗址」(sim 0.57，类型=风景名胜)
      // 被"仅地址"的「崧泽村村委会」(sim 0.33) 顶掉，用户看到的是村委会。
      // 仍排除远处同名、借用文保名的住宅、以及"本体-子单元"形态。
      if (byName && !nameTooFar && !nameBorrowed && !nameSubUnit &&
          heritageRank(byName.matched.poi) === 2) {
        return adopt(byName, '仅名称（sim ' + byName.matched.sim.toFixed(2) +
          '，类型像文物景点，未经地址/坐标印证）');
      }
      if (byAddr && !addrBorrowed) return adopt(byAddr, '仅地址（未经名称/坐标印证）');
      // 坐标没有更好的，退回地址命中（有结果总比空着强）
      if (addrBorrowed) return adopt(byAddr, '仅地址（命中为借名住宅，可信度最低）');
      // 弱名称兜底（同样不能用远方的同名地点、也不能用借名的住宅）
      if (byName && !nameTooFar && !nameBorrowed) {
        return adopt(byName, nameSubUnit
          ? '仅名称（命中为「本体-子单元」，可信度最低）'
          : '仅名称（弱命中，未经印证）');
      }
    }
    return null;
  }

  /** provider → 中文名。模块级：supplementFields 等模块级函数也要用 */
  function label(pr) {
    return pr === 'baidu' ? '百度地图' : '高德地图';
  }

  /** 取开放时间（整周优先，退化为今日） */
  function hoursOf(info) {
    return (info && (info.opentimeWeek || info.opentimeToday)) || '';
  }

  /**
   * 两家的匹配结果是不是"同一个地方"？
   * 只有在确认是同一处时，才能把 A 的开放时间贴到 B 上——否则就是张冠李戴。
   *   ① 名称够像（nameScore ≥ 0.7），或
   *   ② 两个匹配点相距 ≤ 300m（跨家的坐标先统一到 GCJ02 再比）
   */
  /** 把某家的匹配点折算到 GCJ02，便于跨家比较 */
  function matchGcj(r) {
    const geo = window.HMP.geo;
    const pa = r && r.matched && r.matched.poi;
    if (!geo || !pa || !Number.isFinite(pa.lon) || !Number.isFinite(pa.lat)) return null;
    return r.provider === 'baidu' ? geo.bd09ToGcj02(pa.lon, pa.lat) : [pa.lon, pa.lat];
  }

  /**
   * 两家的匹配结果是不是"同一个地方"？只有确认是同一处，才能把 A 的开放时间贴到 B 上。
   *
   * 判定依据（满足其一即可）：
   *   ① 名称够像（nameScore ≥ 0.7）
   *   ② 两家匹配点相距 ≤ 300m
   *   ③ 另一家的匹配点落在**文保本体坐标**附近 ≤ 500m
   *      —— 文保坐标经仿射校正后误差约 150m，所以 500m 内基本可认作同一处。
   *      这一条很关键：首选那家可能匹配到了旁边一栋楼（例如「百空间四行仓库光三分库」），
   *      与另一家匹配到的本体（「上海四行仓库抗战纪念馆」）名字不像、也可能离得稍远，
   *      但后者确实就在文保坐标上。
   */
  function samePlace(a, b, poi) {
    if (!a || !b || !a.info || !b.info) return false;
    const m = window.HMP.matcher;
    const na = a.info.name || '', nb = b.info.name || '';
    if (m && na && nb && m.nameScore(na, nb) >= 0.7) return true;

    const geo = window.HMP.geo;
    if (!geo) return false;
    const ga = matchGcj(a), gb = matchGcj(b);

    // ② 两家匹配点相距很近
    if (ga && gb && geo.distance(ga[0], ga[1], gb[0], gb[1]) <= 300) return true;

    // ③ 另一家的匹配点就落在文保本体上
    if (gb && poi && Array.isArray(poi.gcj) &&
        Number.isFinite(poi.gcj[0]) && Number.isFinite(poi.gcj[1])) {
      if (geo.distance(poi.gcj[0], poi.gcj[1], gb[0], gb[1]) <= 500) return true;
    }
    return false;
  }

  /**
   * 字段级互补：首选那家缺了开放时间/票价/地址时，去问另一家补上。
   *
   * 用户的实际诉求是"能用就行"：高德没给开放时间、百度有，就该显示百度的；
   * 反过来也一样。这与"整条结果二选一"不同——匹配仍以首选那家为准，
   * 只把**它缺的字段**从另一家补进来，并在卡片上注明来源。
   */
  async function supplementFields(cfg, poi, result, diag, order) {
    if (!result || !result.ok || order.length < 2) return result;
    const other = order.find(x => x !== result.provider);
    if (!other) return result;

    const info = result.info || {};
    // 只在**缺开放时间**时才去问另一家——那才是用户真正需要的信息。
    // 若开放时间已有，就不再为票价/地址额外翻倍请求（配额有限）。
    // 真去补时，票价/地址一并从同一份结果里顺带补上，不额外发请求。
    if (hoursOf(info)) return result;

    const need = ['开放时间'];
    if (!info.cost) need.push('票价');
    if (!info.address) need.push('地址');
    console.log('[HMP]', result.provider, '缺 ' + need.join('/') + '，尝试用 ' + other + ' 补充');
    let alt = null;
    try {
      alt = await runProvider(cfg, poi, other, diag, order, 'supplement');
    } catch (e) {
      console.log('[HMP]', other, '补充查询失败：' + e.message);
    }
    if (!alt || !alt.ok || !alt.info) {
      console.log('[HMP]', other, '无可用于补充的结果');
      return result;
    }
    if (!samePlace(result, alt, poi)) {
      // 说清"为什么判定不是同一处"——否则这条日志等于没说，无从定位
      const m = window.HMP.matcher, geo = window.HMP.geo;
      const sim = (m && result.info.name && alt.info.name)
        ? m.nameScore(result.info.name, alt.info.name).toFixed(2) : '-';
      const ga = matchGcj(result), gb = matchGcj(alt);
      const dist = (geo && ga && gb) ? Math.round(geo.distance(ga[0], ga[1], gb[0], gb[1])) + 'm' : '未知';
      const toPoi = (geo && gb && Array.isArray(poi.gcj) && Number.isFinite(poi.gcj[0]))
        ? Math.round(geo.distance(poi.gcj[0], poi.gcj[1], gb[0], gb[1])) + 'm' : '未知';
      console.log('[HMP]', other, '匹配到「' + (alt.info.name || '') +
        '」，判定与当前结果不是同一处 → 不补充' +
        '（名称相似度 ' + sim + '，两家相距 ' + dist + '，距文保本体 ' + toPoi + '）');
      // 说明见上：日志里带上了相似度与两个距离，足以定位，不必再往卡片上堆文案。
      //
      // ⚠ 这里必须真的返回。此前只有这句日志、没有 return，
      //   于是"判定不是同一处"之后照样把另一家的开放时间贴了上来 ——
      //   日志说谎，且与该函数的设计前提（只有同一处才能互相贴字段）相反。
      //   这条分支极难触发（能过 passes 的候选彼此多半也像），所以一直没暴露。
      return result;
    }

    const merged = Object.assign({}, info);
    const filled = [];
    if (!hoursOf(merged) && hoursOf(alt.info)) {
      merged.opentimeWeek = alt.info.opentimeWeek;
      merged.opentimeToday = alt.info.opentimeToday;
      filled.push('开放时间');
    }
    if (!merged.cost && alt.info.cost) { merged.cost = alt.info.cost; filled.push('票价'); }
    if (!merged.address && alt.info.address) { merged.address = alt.info.address; filled.push('地址'); }
    if (!filled.length) return result;

    console.log('[HMP] ✅ 已用 ' + other + ' 补充：' + filled.join('/'));
    return Object.assign({}, result, {
      info: merged,
      supplementedBy: other,
      supplementedFields: filled,
    });
  }

  /**
   * 查询单个 POI：先依次尝试各数据源取一家结论，再对缺失字段做跨家互补。
   */
  async function queryOnePoi(cfg, poi, diag) {
    const pick = pickProviders(cfg);
    if (diag) { diag.preferMissing = pick.missing; diag.tried = pick.order.slice(); }
    if (!pick.order.length) return { ok: false };

    let result = null;
    for (let pi = 0; pi < pick.order.length; pi++) {
      const provider = pick.order[pi];
      // "实际用了哪家、是不是兜底"只在主循环里记
      if (diag) {
        diag.usedProvider = provider;
        diag.fallbackFrom = pi > 0 ? pick.order[0] : null;
      }
      result = await runProvider(cfg, poi, provider, diag, pick.order, 'main');
      if (result && result.ok) break;
    }
    if (!result || !result.ok) return { ok: false };

    // 结果回来时确认用户还在看这个点位（补充查询也是 await，同样要校验）
    const key = poi.__activeKey;
    if (key && key !== '__skip__' && typeof activeKey !== 'undefined' && key !== activeKey) {
      return { ok: false };
    }

    const filled = await supplementFields(cfg, poi, result, diag, pick.order);
    return await probeClosure(cfg, poi, filled, diag, pick.order);
  }

  /**
   * 「关闭状态」探针 —— 问另一家：这个地方关了吗？
   *
   * 起因（实测）：上海董家渡天主堂。首选那家给了正常营业时间
   * 「08:00-11:00,13:00-17:00」，卡片上一切正常；但另一家地图上
   * 明确标着「暂停开放」。supplementFields 只在**缺开放时间**时才去问另一家，
   * 所以这个状态永远拿不到。
   *
   * 只补一次**名称检索**（1 次请求，不是三路各一次），拿到就挂到结果上，
   * 卡片照实说明是哪一家标的 —— 不冒充成"两家都说"。
   */
  async function probeClosure(cfg, poi, result, diag, order) {
    if (!result || !result.ok) return result;
    if (closureHint(result.info)) return result;   // 首选那家自己就给了，不必再问
    if (order.length < 2) return result;           // 只配了一家，没得问
    const other = order.find(x => x !== result.provider);
    if (!other) return result;

    let alt = null;
    try {
      alt = await runProvider(cfg, poi, other, diag, order, 'status-probe');
    } catch (e) {
      console.log('[HMP]', other, '状态探针失败：' + e.message);
      return result;
    }
    if (!alt || !alt.ok || !alt.info) {
      console.log('[HMP]', other, '状态探针：无可判定的结果');
      return result;
    }
    const hint = closureHint(alt.info);
    if (!hint) {
      console.log('[HMP]', other, '状态探针：未发现关闭类标记');
      return result;
    }
    // 只有确认是同一处，才敢把"暂停开放"贴到这个点位头上；
    // 否则就成了"另一家某个关着的点位"张冠李戴。
    if (!samePlace(result, alt, poi)) {
      console.log('[HMP]', other, '状态探针命中「' + (alt.info.name || '') +
        '」，但判定与当前结果不是同一处 → 不采用其状态');
      return result;
    }
    console.log('[HMP] ⚠ ' + other + ' 标记该点位可能不开放（含「' + hint + '」）');
    return Object.assign({}, result, { closureProbe: { provider: other, hint } });
  }

  /**
   * 处理单个 POI（博物馆/风景区/5A景区 等）
   */
  async function processSingle(feature) {
    // 先记下本次查询对应的点位。必须在任何 await 之前取——
    // 否则 await 期间用户切走，这里会取到**新**点位的 key，过期判据就失效了。
    const myKey = currentPoiKey;

    const poi = extractPoi(feature);
    if (!poi) return;
    // 找到父项目组（优先读点位自己的 relationinfo）→ 用组地址 +「组名 子项名」补全
    const g = await resolveGroupCtx(feature);
    applyGroupContext(poi, feature, g.ctx, g.fromRelation);
    if (myKey !== activeKey) return;   // 解析父组期间用户已切走

    const cfg = await getConfig();
    if (!cfg.enabled) {
      renderState({
        card: 'single',
        kind: 'no-config', provider: 'none', providerLabel: '已停用',
        featureType: feature.feature_type
      });
      return;
    }
    const hasAnyKey = cfg.amapKey || cfg.baiduAk;
    if (!hasAnyKey) {
      renderState({
        card: 'single',
        kind: 'no-config', provider: 'none', providerLabel: '未配置 Key',
        featureType: feature.feature_type
      });
      return;
    }

    renderState({
      card: 'single',
      kind: 'loading', provider: 'querying', providerLabel: '查询中…',
      featureType: feature.feature_type
    });

    const cached = await window.HMP.cache.get(
      cfg.defaultProvider, poi.name, poi.adminLast || ''
    );
    if (myKey !== activeKey) return;      // 已切走，丢弃
    if (cached) {
      console.log('[HMP] cache hit:', poi.name);
      renderResult(poi, cached.data);
      return;
    }

    // 记录"实际用了哪家、是不是兜底"，好在卡片上说明为什么不是首选那家
    const diag = {};
    const result = await queryOnePoi(cfg, poi, diag);

    // 用户首选的那家没能用上时，给出可读原因（否则表现为"切换没生效"）
    let fallbackNote = '';
    if (diag.preferMissing) {
      fallbackNote = '已在设置里首选' + label(diag.preferMissing) + '，但没有填写它的 Key，暂用' + label(diag.usedProvider);
    } else if (diag.fallbackFrom) {
      const why = (diag.providerNotes && diag.providerNotes[diag.fallbackFrom]) || '';
      fallbackNote = label(diag.fallbackFrom) + '没能给出结果' +
        (why ? '（' + why + '）' : '') + '，已回退到' + label(diag.usedProvider);
    }

    // 关键：结果回来时确认用户还在看这个点位
    if (myKey !== activeKey) {
      console.log('[HMP] 点位已切换，丢弃过期结果：' + poi.name);
      return;
    }

    if (result.ok) {
      const payload = {
        matched: result.info,
        provider: result.provider,
        matchType: result.matchType || 'name',
        dist: Number.isFinite(result.dist) ? Math.round(result.dist) : null,
        fallbackNote,
        verifiedBy: result.verifiedBy || null,
        supplementedBy: result.supplementedBy || null,
        supplementedFields: result.supplementedFields || null,
        closureProbe: result.closureProbe || null
      };
      // 缓存键用**实际作答的那家**，而不是"首选那家"。
      // 否则百度临时失败、高德兜底的结果会被写进 baidu 键——
      // 之后即使百度恢复正常，7 天内读到的仍是那条高德兜底结果，
      // 表现为"我把百度 Key 填好了，怎么还是高德"。
      // 写成 amap 键后，下次仍会按用户首选重新试百度，能自愈。
      const cacheProvider = result.provider || diag.usedProvider || cfg.defaultProvider;
      await window.HMP.cache.set(
        cacheProvider, poi.name, poi.adminLast || '', payload
      );
      renderResult(poi, payload);
    } else {
      const missProvider = diag.usedProvider || cfg.defaultProvider;
      await window.HMP.cache.set(
        missProvider, poi.name, poi.adminLast || '',
        { matched: null, provider: missProvider, fallbackNote }
      );
      renderResult(poi, { matched: null, provider: missProvider, fallbackNote });
    }
  }

  function renderResult(poi, cacheData) {
    // 降级跳转链接：高德走官方 URI API 的 keyword，
    // 百度走 place/search 的 query + region（城市单独传，不堆进关键词）。
    const amapPhrase = poi.city ? `${poi.city} ${poi.name}` : poi.name;
    const amapSearchUrl = window.HMP.apis.amap.searchUrl(amapPhrase);
    const baiduSearchUrl = window.HMP.apis.baidu.searchUrl(poi.name, poi.city, poi.bd09);

    if (cacheData.matched) {
      const provider = cacheData.provider;
      renderState({
        card: 'single',
        kind: 'found',
        info: cacheData.matched,
        provider,
        providerLabel: provider === 'amap' ? '高德地图' : '百度地图',
        matchType: cacheData.matchType || 'name',
        matchDist: cacheData.dist || null,
        fallbackNote: cacheData.fallbackNote || '',
        verifiedBy: cacheData.verifiedBy || null,
        supplementedBy: cacheData.supplementedBy || null,
        supplementedFields: cacheData.supplementedFields || null,
        closureProbe: cacheData.closureProbe || null,
        siteName: poi.name,
        amapSearchUrl, baiduSearchUrl,
        featureType: poi.featureType
      });
    } else {
      renderState({
        card: 'single',
        kind: 'not-found',
        provider: cacheData.provider,
        providerLabel: cacheData.provider === 'amap' ? '高德地图' : '百度地图',
        fallbackNote: cacheData.fallbackNote || '',
        amapSearchUrl, baiduSearchUrl,
        featureType: poi.featureType
      });
    }
  }

  /**
   * 处理文物组：列出子项目开放信息
   */
  /**
   * 文物组表格 —— **当前未接入入口**（见 processFeature：文物组一律不显示卡片）。
   *
   * 保留这段实现是因为它把"子项目怎么在地图上定位"这件事的坑趟清楚了
   * （kid 拉自身地址、独立文保才允许坐标兜底、地址关键字逐级放宽），
   * 将来若要重新启用，直接接回 processFeature 即可。相关行为仍由 group_tests 覆盖。
   *
   * @param {object} feature 文物组点位
   * @param {string} [focusKid] 用户刚点开的子项目 kid —— 在表格里高亮这一行
   */
  // ========== 入口 ==========

  /** 从文物组点位提取"供子项目借用"的上下文 */
  function buildGroupContext(feature) {
    if (!feature) return null;
    const naming = window.HMP.naming;
    const admin = Array.isArray(feature.admin) ? feature.admin : [];
    const members = Array.isArray(feature.members) ? feature.members : [];
    // 组的中心坐标（站点坐标 → 各坐标系）。
    // 子项目查不到自己名字时，要统一落到"组所在的那个地图点位"，
    // 所以打分必须用组的中心，而不是各子项目自己的位置。
    let gLon = null, gLat = null;
    if (feature.geom && Array.isArray(feature.geom.coordinates)) {
      gLon = feature.geom.coordinates[0]; gLat = feature.geom.coordinates[1];
    } else if (members.length && members[0].geom && Array.isArray(members[0].geom.coordinates)) {
      gLon = members[0].geom.coordinates[0]; gLat = members[0].geom.coordinates[1];
    }
    const geo = window.HMP.geo;
    let gcj = null, bd09 = null;
    if (geo && Number.isFinite(gLon) && Number.isFinite(gLat)) {
      const w = geo.steleToWgs84(gLon, gLat);
      if (geo.isPlausible(w[0], w[1])) {
        gcj = geo.wgs84ToGcj02(w[0], w[1]);
        bd09 = geo.gcj02ToBd09(gcj[0], gcj[1]);
      }
    }
    return {
      name: feature.name,
      admin,
      addrQuery: (feature.address && naming && naming.addressQuery)
        ? naming.addressQuery(admin, feature.address) : '',
      kids: new Set(members.filter(m => m && m.kid).map(m => m.kid)),
      memberNames: new Set(members.filter(m => m && m.name).map(m => m.name)),
      gcj, bd09,
      variants: naming ? naming.searchNames(feature.name) : [feature.name],
    };
  }

  /** 这个点位是不是某个组上下文里的成员 */
  function isMemberOf(feature, ctx) {
    if (!feature || !ctx) return false;
    if (feature.kid && ctx.kids.has(feature.kid)) return true;
    return !!(feature.name && ctx.memberNames.has(feature.name));
  }

  /**
   * 找出这个点位的"父项目组"上下文。
   *
   * 两条来源，可靠性从高到低：
   *   ① **点位自己的 feature.relationinfo** —— 子项里直接写着父组
   *      （实测「白宫」→ { kid, name: '圣约翰大学近代建筑' }）。
   *      这条不依赖"用户先打开组"，也不依赖点击顺序。
   *   ② 之前打开过的组（activeGroupCtx）
   *
   * 有了父组，才能拿到组地址（万航渡路1575号）——子项目自己只有行政区，没有门牌号。
   */
  async function resolveGroupCtx(feature) {
    const rel = Array.isArray(feature && feature.relationinfo)
      ? feature.relationinfo.find(r => r && r.kid && r.name) : null;
    if (!rel) return { ctx: activeGroupCtx, fromRelation: false };
    if (parentCtxCache.has(rel.kid)) {
      const c = parentCtxCache.get(rel.kid);
      return { ctx: c || activeGroupCtx, fromRelation: !!c };
    }
    const api = window.HMP.featureApi;
    if (!api || !api.fetchById) return { ctx: activeGroupCtx, fromRelation: false };
    let c = null;
    try {
      const pf = await api.fetchById(rel.kid);
      if (pf && pf.name) c = buildGroupContext(pf);
    } catch (e) {
      console.log('[HMP] 父项目组「' + rel.name + '」拉取失败：' + e.message);
    }
    parentCtxCache.set(rel.kid, c);
    return { ctx: c || activeGroupCtx, fromRelation: !!c };
  }

  /**
   * 子项目若属于刚才那个组，就用组信息补全它的检索条件。
   * 站点在组面板里点开子项目时，派发上来的是子项目自己的 feature ——
   * 它没有地址、名字也可能是泛词，不补全就必然乱匹配。
   */
  function applyGroupContext(poi, feature, group, fromRelation) {
    if (!poi || !group || !feature) return;
    // 来自 relationinfo 的父组是**明确声明**的，不需要再做成员校验
    // （成员名偶有出入，不该因此丢掉父组地址）
    if (!fromRelation && !isMemberOf(feature, group)) return;

    const naming = window.HMP.naming;
    const terms = [];
    const push = (t) => { if (t && !terms.includes(t)) terms.push(t); };
    // 「组名 + 子项名」打头，避免「白宫」这类泛词单搜
    if (naming && naming.memberSearchNames) {
      for (const x of naming.memberSearchNames(feature.name, group.name)) push(x);
    } else {
      push(feature.name);
    }
    // 再去掉「旧址/旧居」等后缀试一次
    const base = String(feature.name || '').replace(
      /(旧址群|旧址|旧居|故居|原址|遗存|遗址群|纪念地|建筑群|建筑)$/, '');
    if (base && base !== feature.name && base.length >= 3) {
      if (naming && naming.memberSearchNames) {
        for (const x of naming.memberSearchNames(base, group.name)) push(x);
      } else {
        push(base);
      }
    }
    // 子项目自身的现用名（若有）也带上
    for (const v of (poi.nameVariants || [])) push(v);

    // 检索词**只保留带项目组名前缀的**：
    //   ✅「圣约翰大学近代建筑 白宫」
    //   ❌「白宫」——泛词单搜，全上海的同名地点都会被搜出来（实测匹配到 8 公里外的一个「白宫」）
    // 裸名仍留在 nameVariants 里用于打分，但不作为检索词发出去。
    const prefixed = terms.filter(t => t && group.name && t.indexOf(group.name) !== -1);
    poi.nameVariants = terms;
    poi.searchTerms = (prefixed.length ? prefixed : terms).slice(0, MAX_NAME_VARIANTS);
    // 子项目自己没有门牌号（只精确到区县）→ 用项目组的地址
    const ownAddr = !!(feature.address && String(feature.address).trim());
    if (!ownAddr && group.addrQuery) {
      poi.addrQuery = group.addrQuery;
      // 地址取自项目组 → 打分也要按"组"来。
      // 否则同一组的子项会因为各自坐标不同，在同一个地址下各挑各的楼：
      // 实测「白宫」→ 圣约翰大学校长故居，而「顾斐德纪念体育室」→ 圣约翰大学旧址，
      // 同组两个子项给出两个不同答案，看起来自相矛盾。
      poi.addrFromGroup = true;
      poi.groupVariants = group.variants || [];
      poi.groupRef = { amap: group.gcj, baidu: group.bd09 };
    }
    poi.groupName = group.name;
    console.log('[HMP] 子项目「' + feature.name + '」按项目组「' + group.name +
      '」补全：检索名=' + JSON.stringify(poi.searchTerms) +
      '，地址=' + (poi.addrQuery || '(组也没有地址)'));
  }

  function processFeature(feature) {
    if (isGroup(feature)) {
      activeGroupCtx = buildGroupContext(feature);
      console.log('[HMP] 「' + feature.name + '」是文物组 → 记下上下文，不显示卡片');
      // 清掉当前卡片（从子项目切回组时必须收掉子项目的卡片）
      lastState = null;
      cancelRender();
      removeCard();
      return;
    }
    processSingle(feature);
  }

  let currentPoiKey = null;
  let pendingFeature = null;
  // 当前用户正在看的点位；异步结果返回时用它校验是否已过期
  let activeKey = null;

  window.addEventListener('hmp:poi-loaded', e => {
    const feature = e.detail;
    if (!feature || !feature.name) return;
    const key = feature.name + '|' + (feature.kid || '');
    const cardPresent = !!document.getElementById(CARD_ID);

    if (key === currentPoiKey && cardPresent) return;   // 同一 POI 且卡片还在 → 忽略

    // 遗产地图的底图上还铺了一层普通 POI（行政区、地铁站、公园、国宾馆…），
    // 它们不是文保也不是世遗，点开只想看"这是什么"，不需要开放信息。
    // 站点用 category 表达保护身份：文保/世遗/优秀历史建筑都有值，
    // 普通 POI 是空数组。空数组 → 直接不介入（并把上一个点位的卡片收掉）。
    if (!isDesignated(feature)) {
      console.log('[HMP] 「' + feature.name + '」没有保护身份（category 为空，' +
        '类型 ' + (feature.feature_type || '未知') + '），不显示开放信息');
      currentPoiKey = key;
      activeKey = key;
      lastState = null;
      cancelRender();
      removeCard();
      return;
    }

    if (key === currentPoiKey && !cardPresent && lastState) {
      // 面板被关掉后又重新打开同一个点位：直接用上次结果重绘，不重复查询
      console.log('[HMP] 同一 点位重新打开，复用上次结果重绘卡片');
      renderState(lastState);
      return;
    }

    currentPoiKey = key;
    activeKey = key;
    pendingFeature = feature;

    // 站点每次加载一个点位（含子项目）都会走 URL 兜底，把它的完整数据留下来。
    // 用户"点进去"看过的子项目，之后组表格就不用再拉一次了。

    console.log('[HMP] 识别到点位：' + feature.name +
      '（' + (feature.feature_type || '未知类型') + '）→ ' +
      (isGroup(feature) ? '走文物组流程' : '走单点位流程'));
    processFeature(feature);
  });

  // 监听详情面板的增删：
  //   - 面板重建（React 重渲染冲掉了卡片）→ 按上次状态重新插入
  //   - 面板关闭（DOM 里没了）→ 移除卡片，绝不让它残留在页面上
  // 同时观察 class 变化：`.modal` 的 `show` 类是后加的。
  let reinjectTimer = null;
  const observer = new MutationObserver(() => {
    if (reinjectTimer) return;
    reinjectTimer = setTimeout(() => {
      reinjectTimer = null;
      const card = document.getElementById(CARD_ID);

      if (panelGone()) {
        // 详情面板已关闭 —— 卡片必须一起消失，并取消在途的重试
        cancelRender();
        if (card) {
          removeCard();
          console.log('[HMP] 详情面板已关闭，移除卡片');
        }
        return;
      }

      // 面板在，但卡片没了 → 重新插入（不重新查询，省配额）
      if (!card && lastState) {
        const ok = doInsert(buildSingleCard(lastState));
        if (ok) console.log('[HMP] 详情面板重建，重新插入卡片');
      }
    }, 60);
  });
  observer.observe(document.body, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['class']
  });

  /** 诊断：在控制台执行 HMP.debug.inspect() */
  function inspect() {
    const basic = document.getElementById('poi-basic-info-section');
    const card = document.getElementById(CARD_ID);
    return {
      页面: location.href,
      'fetch 已劫持': !!window.__HMP_FETCH_HOOK_INSTALLED__,
      详情面板: {
        'div.modal': !!document.querySelector('.modal'),
        'div.modal.show': !!document.querySelector('.modal.show'),
        'div.modal-body': !!document.querySelector('.modal-body'),
        '#poi-basic-info-section': !!basic,
        找到可用容器: !!findContainer(),
        容器来源: basic ? '#poi-basic-info-section.parentNode'
          : document.querySelector('.modal-body') ? '.modal-body'
          : '（无：面板未打开或已关闭）',
        面板已关闭: panelGone(),
      },
      卡片: {
        已插入: !!card,
        父容器: card && card.parentNode ? (card.parentNode.id || card.parentNode.className) : null,
      },
      最近一次渲染: lastState
        ? { kind: lastState.kind, provider: lastState.provider, matchType: lastState.matchType || null }
        : null,
      已识别的点位: pendingFeature ? pendingFeature.name : null,
    };
  }

  window.HMP.card = {
    CARD_ID,
    processFeature,
    processSingle,
    extractPoi,
    isGroup,
    isDesignated,
    renderState,
    inspect,
    // 以下暴露用于调试与测试
    queryOnePoi,
    probeClosure,
    searchByName,
    searchByAddress,
    searchNearby,
    heritageRank,
    plausiblePrice,
    closureHint,
    pickProviders,
    borrowedNamePenalty,
    houseNoPenalty,
    findContainer,
    panelGone,
    removeCard,
    cancelRender,
    NEARBY_RADIUS,
    NAME_STRONG_SIM
  };
})();