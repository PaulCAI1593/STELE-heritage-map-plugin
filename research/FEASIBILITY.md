# 遗产地图插件 — 可行性研究笔记

本笔记记录在 `http://stele.geogv.org/zhcn/` 站点上叠加"开放信息/开放时间"功能的技术调研结果，供后续讨论与开发参考。

---

## 1. 目标站点技术画像

站点首页加载的脚本与样式：

| 资源 | 用途 |
| --- | --- |
| `main.css` / `main.zhcn.css` | 全站样式 |
| `mapbox-gl.js` (v1.7.0) | 地图引擎（不是百度/高德，是 Mapbox GL） |
| `react.production.min.js` (18.3.1) + `react-dom` | UI 框架 |
| `react-bootstrap` / `react-router-dom` / `react-bootstrap-typeahead` | UI 套件与路由 |
| `/js/zhcn.js` | 本地化文案（108 行 i18n 字典） |
| `/dist/app.js` | 业务应用（≈120 KB，minified） |
| `window["mapserviceEndpoint"] = "http://143.198.141.10:8080/"` | 瓦片/样式服务器（仅用于加载 `styles/.../style.json`，不是后端） |

路由（来自 `app.js` 的 React Router 配置）：

```
/               地图主界面
/search         关键字搜索
/about          关于
/geo/:id        点位详情（按 id 跳转）
/detail/:id     详情变体
/info/:id       信息面板
/static/:id     静态页
/dialogstatic/:id
/poigallery/:id
/rail/:id       世界交通（铁路）专题
```

i18n 字段（来自 `/js/zhcn.js`）暴露的 POI 信息区块键名：
`poiIntro` / `generalInfo` / `wikipediaInfo` / `wikidataInfo` / `partOfRelation` / `containSubitems` / `imageSource` —— **没有"开放时间/开放情况"字段**。这印证了用户的痛点。

---

## 2. 后端 API（站点自身）

全部走同源 `https://stele.geogv.org/api/v1/...`（前端用相对路径 `../api/v1/...`）。

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/feature/{eid}?locale=zhcn` | POI 详情。响应是混淆字符串，需用 `b.so` 解密（见 §3） |
| GET | `/api/v1/query/{eid}` | 同上，备选 |
| GET | `/api/v1/search/?keyword={k}&region=&locale=zhcn` | 关键字搜索，返回 `[{"id","name","feature_type","admin","html_name:en"}]` |
| GET | `/api/v1/searchadmin?keyword=` | 行政区联想 |
| GET | `/api/v1/featureinfo/{eid}` | 简略信息 |
| GET | `/api/v1/wiki/{eid}?locale=` | 维基百科渲染 HTML |
| GET | `/api/v1/htmlpage/{eid}?locale=` | 静态 HTML 页面 |
| GET/POST | `/api/v1/poiprofile/{eid}` | 用户提交的资料 |
| GET/POST | `/api/v1/poimediadetail/{eid}` | 媒体 |
| GET | `/api/v1/poimedialist/{eid}` | 媒体列表 |
| GET/POST | `/api/v1/poitweet/{eid}` | 评论 |
| GET/POST | `/api/v1/tweet/{tweetId}` | 评论 |
| GET | `/api/v1/wtr/cn7extpoi/{eid}?locale=` | 铁路专题 |
| GET | `/api/v1/wtr/route/{eid}?locale=` | 路线 |
| GET | `/api/v1/wtr/cn7extdeparture/{eid}?locale=` | 班次 |

**响应加密**：`feature` 端点返回的不是明文 JSON，而是一个混淆字符串，前端使用 `b.so()` 解密（详见 §3）。

---

## 3. 关键解密算法（`b.so`）

从 `app.js` 中提取：

```js
class b {
  static so(e) {
    let t = "";
    const n = e.charCodeAt(0);                 // 首字符 = 密钥长度
    const i = e.substring(1, 1 + n);           // 接下来的 n 字符 = 密钥
    let a = e.substring(n + 1);                // 剩余 = 密文
    for (let e = 0; e < a.length; e++)
      t += String.fromCharCode(
        a.charCodeAt(e) - i.charCodeAt(e % i.length)
      );
    return JSON.parse(t);
  }
}
```

**算法性质**：循环异或/减法密码，不防篡改；本质是压缩。密钥在每次响应里不同。**插件不需要硬编码密钥**——可以直接复用 `app.js` 中的 `b.so` 类，或者直接调用站点的 `fetch`，让浏览器返回解析后的数据。

**实测**：用莫高窟的 POI id `44da25126b084ac2a5297b537ef73565` 调用 `/api/v1/feature/{id}?locale=zhcn`，解密后得到明文 JSON（节选）：

```json
{
  "name": "莫高窟",
  "feature_type": "文物组",
  "minzoom": 15,
  "admin": ["酒泉市 敦煌市"],
  "geom": { "type": "Point", "coordinates": [91.20275, 41.63518] },
  "members": [
    { "kid": "c55e8eec240049f7ba2afb95c712dd34", "geom": {"type":"Point","coordinates":[91.20275,41.63518]}, "name": "莫高窟" },
    { "kid": "867187a7532044909a2f8569ab70f2e8", "geom": {"type":"Point","coordinates":[90.75448,41.56996]}, "name": "西千佛洞" }
  ],
  "basic": {},
  "category": [{
    "category": { "name": "全国重点文物保护单位", "backgroundColor": "#EC7063", "foreColor": "white" },
    "tags": [
      { "keyName": "编号", "value": "1-35" },
      { "keyName": "名称", "value": "莫高窟" },
      { "keyName": "类型", "value": "石窟寺" },
      { "keyName": "时代", "value": "北魏至元" },
      { "keyName": "登录", "value": "1961年第一批" }
    ]
  }],
  "images": [ ... ],
  "secname": "Mogao Caves",
  "useMemberGeom": true,
  "subitemView": [ ... ]
}
```

**关键字段总结（每个 POI 都具备）**：
- `name`：名称（如"莫高窟"）
- `feature_type`：类别（"文物组"/"博物馆"/"风景区"/"5A景区"/"地铁站"/"历史建筑"等）
- `geom.coordinates`：[lon, lat]（WGS84 或 GCJ02，待确认）
- `admin`：行政区路径（"酒泉市 敦煌市"）
- `category[].tags`：文保属性（编号、名称、类型、时代、登录批次）
- `members[]`：若为文保组，包含子项目，每个都有自己的 `kid` 和 `geom`

---

## 4. 百度 / 高德地图 API 调研

### 4.1 百度地图 Place API v2（推荐国内首选）

| 接口 | URL | 说明 |
| --- | --- | --- |
| 行政区划检索 | `https://api.map.baidu.com/place/v2/search?query=...&region=...&output=json&ak=...&scope=2&ret_coordtype=gcj02ll&coord_type=2` | 按城市+关键字查 POI；返回 `uid` 用于详情 |
| 圆形区域检索 | `https://api.map.baidu.com/place/v2/search?query=...&location=lat,lng&radius=2000&ak=...&scope=2` | 给定坐标附近 POI；适合把 STELE 坐标丢进去找最近的同名 POI |
| **地点详情** | `https://api.map.baidu.com/place/v2/detail?uid={uid}&output=json&scope=2&ak=...&ret_coordtype=gcj02ll` | 查 POI 详情，关键返回字段见下 |

`detail_info`（仅当 `scope=2` 返回）字段：

| 字段 | 含义 |
| --- | --- |
| `shop_hours` | **营业时间**（如 "8:30-17:30"） |
| `status` | 营业状态（空=正常营业 / 暂停营业 / 已关闭 / 推算位置等） |
| `price` | 价格 |
| `overall_rating` / `taste_rating` / `service_rating` / `environment_rating` | 各类评分 |
| `telephone` | 电话 |
| `brand` | 品牌 |
| `content_tag` | 标签 |
| `photos` | 图片（高级付费） |

坐标系：
- 输入：`coord_type` = 1 (WGS84), 2 (GCJ02), 3 (BD09), 4 (BD09 mc)
- 输出：用 `ret_coordtype=gcj02ll` 可让百度返回 GCJ02 坐标，方便我们比对

### 4.2 高德地图 Web API v5（备选）

| 接口 | URL | 说明 |
| --- | --- | --- |
| 关键字搜索 | `https://restapi.amap.com/v5/place/text?key=...&keywords=...&location=lon,lat&radius=...` | 支持"在坐标附近用关键字搜索" |
| 周边搜索 | `https://restapi.amap.com/v5/place/around?key=...&keywords=...&location=lon,lat&radius=...` | 与上面类似，更纯粹 |
| ID 查询 | `https://restapi.amap.com/v5/place/detail?id=...&key=...` | 已知 POI id 时直接查 |

高德 POI 扩展字段（`business` 扩展字段）：
- `opentimeToday`：今日营业时间，如 `08:30-17:30 08:30-09:00 12:00-13:30`
- `opentimeWeek`：一周营业时间描述，如 `周一至周五:08:30-17:30...；周六...；周日...`
- `tel`：电话
- `rating`：评分（景点/酒店/餐饮/影院类）
- `cost`：人均消费
- `alias`：别名
- `tag`：特色
- `parkingType`：停车场类型

坐标系：高德采用 GCJ02（也叫火星坐标），与 STELE 的 `geom.coordinates` 一致概率高；返回坐标也默认 GCJ02。

---

## 5. 关键可行性结论

✅ **整体可行**：
- STELE 给每个 POI 都提供了 `name`、`geom.coordinates`、`admin`，足够做"按坐标+名称"的反查。
- 百度/高德地图都提供 POI 详情接口，里面都包含营业时间字段。
- 站点是普通 SPA，浏览器扩展可以通过 `content_scripts` 注入到页面，读取 React 渲染的 DOM/状态，或者直接读 `window.__REDUX_DEVTOOLS_EXTENSION__` 之类的内部状态，再叠加 UI。

⚠️ **需要处理的难点**：

1. **坐标系对齐**
   - STELE 的 `geom.coordinates` 是哪种坐标系？实测莫高窟 `91.20275, 41.63518`，而真实地理坐标大约 `94.66E, 40.14N`，差距很大（3.5°），可能是 WGS84 直接给的，也可能是手输的近似值。需要做一个对照实验：用其他几个 POI 比对真实位置，确认后再决定是否需要转换。
   - 百度默认 BD09，高德默认 GCJ02 —— 都要正确声明 `coord_type`/`ret_coordtype`，否则坐标偏差几百米到几公里，会导致圆形区域检索找不到正确 POI。

2. **匹配命中率**
   - 不是所有文保点位都在百度/高德数据库里有收录，特别是"未定级文物"、"省/市/县级文保"。
   - 解决：组合策略 — 用 name + admin + radius 周边搜索，按名称相似度+距离排序，挑 Top1；若 Top1 距离超过阈值（如 500m），判定未匹配。

3. **CORS / 调用方式**
   - 百度/高德 Web 服务 API 通常允许 CORS（GET 请求），但 AK 暴露在浏览器端有泄漏风险。需要：
     - 选项 A：插件直接在 content script 里 fetch，AK 存在用户本地（chrome.storage.local），要求用户自己申请 AK。
     - 选项 B：插件弹一个 popup 让用户输入 AK，存 storage。
     - 选项 C：让用户填 AK 后，由 background service worker 转发（fetch 不带 cookie，所以基本同 A，只是 AK 不进页面上下文）。
   - 百度对未认证开发者每日有较低配额（典型 6000 次/日），对个人用户基本够用但要提示。

4. **扩展可观测的页面状态**
   - STELE 是 React 应用，DOM 频繁重渲染。监听 POI 切换有两种方式：
     - 监听 React Router 的 `popstate` + URL 变化（`/geo/:id`）
     - 用 `MutationObserver` 监视左侧详情面板 DOM
     - 更稳的：劫持 `window.fetch`，过滤 `/api/v1/feature/...` 请求，从响应里直接拿到 POI id 和 name —— **这是最可靠的**。

5. **数据陈旧**
   - 百度/高德的营业时间数据有滞后，不能 100% 反映景区当下公告。需要在 UI 上明确写"信息来源于百度/高德地图，仅供参考，请以现场公告为准"，并附"在百度/高德地图中打开" 跳转链接作为 fallback。

6. **站点协议**
   - STELE 后端 `143.198.141.10:8080` 走 HTTP，API 也走 HTTP。
   - 插件不应请求任何非本站 cookie；content script 只读公开资源即可。

---

## 6. 形态建议（待用户确认）

### 形态 A：纯展示型（最轻量）
- 在 `/geo/:id` 详情面板底部注入一张"开放信息"卡片，显示：
  - 今日营业时间
  - 一周营业时间
  - 营业状态（正常/暂停/关闭）
  - 电话（可点击拨号）
  - 来源（百度/高德）+ "在百度地图中打开" 跳转链接
- 优点：实现简单，无副作用。
- 缺点：只显示用户当前选中的 POI。

### 形态 B：侧边栏汇总型
- 在地图右侧加一个固定侧栏，列出当前视口内所有 POI 的开放状态（颜色标签：开放/闭馆/即将闭馆）。
- 优点：访古规划时一眼看到多家博物馆哪个还开门。
- 缺点：视口 POI 数量大时调用次数多（需要节流 + 缓存）。

### 形态 C：聚合查询 + 收藏夹
- 在 POI 卡片上加"加入访古清单"按钮，清单页批量展示各家开放时间、当前是否可参观、距离等。
- 优点：行程规划利器。
- 缺点：需要本地数据库（IndexedDB），工程量更大。

---

## 7. 与用户讨论的问题（关键决策）

1. **API 提供方**：百度 vs 高德？两者都支持，但字段格式、配额、价格不同。倾向哪个？还是做成两家都支持、用户自选？
2. **覆盖策略**：只查询 POI 详情（覆盖率高但偶尔失败）？还是降级到"在百度地图中搜索该名称"跳转（永远可用）？
3. **展示位置**：只注入到 `/geo/:id` 详情页（最小侵入）？还是全站所有 POI 弹窗都加？
4. **数据缓存**：是否需要本地缓存结果（同一 POI 不重复查询，节省配额）？
5. **数据反馈**：当用户发现信息过期时，是否提供"上报修正"按钮？
6. **坐标系**：能否给一个对照测试？比如 "请告诉我您在地图上看到 POI 的 WGS84 坐标 vs 网站显示坐标" 的偏差？

---

## 附：实测资源

- `/workspace/heritage-map-plugin/research/stele_home.html` — 首页 HTML（待下载）
- `/workspace/heritage-map-plugin/research/zhcn.js` — i18n
- `/workspace/heritage-map-plugin/research/app.js` — 主应用（minified）
- `/workspace/heritage-map-plugin/research/feature_mogao.json` — 莫高窟原始混淆响应
- `/workspace/heritage-map-plugin/research/feature_mogao.plain.txt` — 解密后明文 JSON