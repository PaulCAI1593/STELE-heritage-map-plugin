// geo.js
// 坐标校正 + 坐标系转换。
//
// ─────────────────────────────────────────────────────────────
// 一、为什么需要坐标校正
//
// STELE 站点的坐标并非 WGS84 实测值，而是相对真实位置发生了
// 「仿射畸变」（既有平移也有约 1.5% 的缩放）。用 16 个不同类型
// 文保单位拟合得到：
//
//     lon_real = 0.98431778 * lon_stele + 5.03246552
//     lat_real = 0.98833425 * lat_stele - 1.11021542
//
// 拟合残差 RMS ≈ 0.008°（≈1 km）；在 5 个**未参与拟合**的留出点位
// （真觉寺金刚宝座/觉生寺/智化寺/先农坛/保国寺）上平均误差仅 0.15 km。
//
// 若不校正，直接拿站点坐标去查，会偏 320–390 km（之前的"常量偏移"
// 只是这个仿射变换在小范围内的近似）。
//
// ─────────────────────────────────────────────────────────────
// 二、为什么需要坐标系转换
//
//   高德 = GCJ02（火星坐标）
//   百度 = BD09（百度坐标）
//   本站 = 校正后即 WGS84
// 必须各按各的坐标系传参，否则会有几百米偏差。
//
// 校正后精度 ~150 m，足以支撑 1 km 半径的「周边搜索」——
// 这正是解决「文保名称 ≠ 现用名」的关键（如 真觉寺金刚宝座 →
// 现为北京石刻艺术博物馆，名称完全无关，但位置相同）。

(function () {
  'use strict';
  window.HMP = window.HMP || {};

  // ---- 仿射系数（16 点位最小二乘拟合）----
  const AFFINE = {
    lonA: 0.98431778, lonB: 5.03246552,
    latA: 0.98833425, latB: -1.11021542,
  };

  /**
   * 站点坐标 → 真实 WGS84 坐标。
   * @param {number} lon 站点经度
   * @param {number} lat 站点纬度
   * @returns {[number, number]} [lon, lat] WGS84
   */
  function steleToWgs84(lon, lat) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return [lon, lat];
    return [AFFINE.lonA * lon + AFFINE.lonB, AFFINE.latA * lat + AFFINE.latB];
  }

  // ---- WGS84 → GCJ02（火星坐标）----
  const PI = 3.1415926535897932384626;
  const A_EARTH = 6378245.0;
  const EE = 0.00669342162296594323;

  function outOfChina(lon, lat) {
    return !(lon > 72.004 && lon < 137.8347 && lat > 0.8293 && lat < 55.8271);
  }

  function transformLat(x, y) {
    let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y +
      0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * PI) + 320 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
    return ret;
  }

  function transformLon(x, y) {
    let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y +
      0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
    return ret;
  }

  /** WGS84 → GCJ02。境外原样返回。 */
  function wgs84ToGcj02(lon, lat) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return [lon, lat];
    if (outOfChina(lon, lat)) return [lon, lat];
    let dLat = transformLat(lon - 105.0, lat - 35.0);
    let dLon = transformLon(lon - 105.0, lat - 35.0);
    const radLat = lat / 180.0 * PI;
    let magic = Math.sin(radLat);
    magic = 1 - EE * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((A_EARTH * (1 - EE)) / (magic * sqrtMagic) * PI);
    dLon = (dLon * 180.0) / (A_EARTH / sqrtMagic * Math.cos(radLat) * PI);
    return [lon + dLon, lat + dLat];
  }

  /** GCJ02 → BD09（百度坐标） */
  function gcj02ToBd09(lon, lat) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return [lon, lat];
    const x = lon, y = lat;
    const z = Math.sqrt(x * x + y * y) + 0.00002 * Math.sin(y * PI * 3000.0 / 180.0);
    const theta = Math.atan2(y, x) + 0.000003 * Math.cos(x * PI * 3000.0 / 180.0);
    return [z * Math.cos(theta) + 0.0065, z * Math.sin(theta) + 0.006];
  }

  /** BD09 → GCJ02（gcj02ToBd09 的逆运算，用于校验与反向换算） */
  function bd09ToGcj02(lon, lat) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return [lon, lat];
    const x = lon - 0.0065, y = lat - 0.006;
    const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * PI * 3000.0 / 180.0);
    const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * PI * 3000.0 / 180.0);
    return [z * Math.cos(theta), z * Math.sin(theta)];
  }

  /**
   * GCJ02 → WGS84（迭代逼近）。
   * 公开算法只是 GCJ02 的近似，没有闭式逆；迭代几次即可收敛到亚米级。
   */
  function gcj02ToWgs84(lon, lat) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return [lon, lat];
    if (outOfChina(lon, lat)) return [lon, lat];
    let wlon = lon, wlat = lat;
    for (let i = 0; i < 5; i++) {
      const [glon, glat] = wgs84ToGcj02(wlon, wlat);
      wlon += lon - glon;
      wlat += lat - glat;
    }
    return [wlon, wlat];
  }

  // ---- 便捷组合 ----

  /** 站点坐标 → 高德(GCJ02)，用于 v5/place/around 的 location 参数 */
  function steleToGcj02(lon, lat) {
    const [wlon, wlat] = steleToWgs84(lon, lat);
    return wgs84ToGcj02(wlon, wlat);
  }

  /** 站点坐标 → 百度(BD09) */
  function steleToBd09(lon, lat) {
    const [glon, glat] = steleToGcj02(lon, lat);
    return gcj02ToBd09(glon, glat);
  }

  /** 校验校正结果是否落在中国境内（防止站点日后修正数据导致双重偏移） */
  function isPlausible(lon, lat) {
    return Number.isFinite(lon) && Number.isFinite(lat) && !outOfChina(lon, lat);
  }

  window.HMP.geo = {
    AFFINE,
    steleToWgs84,
    wgs84ToGcj02,
    gcj02ToWgs84,
    gcj02ToBd09,
    bd09ToGcj02,
    steleToGcj02,
    steleToBd09,
    isPlausible,
    outOfChina,
    /** 便捷：两点间距离（米） */
    distance(lon1, lat1, lon2, lat2) {
      if (![lon1, lat1, lon2, lat2].every(Number.isFinite)) return Infinity;
      const R = 6371000, toRad = d => d * Math.PI / 180;
      const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
      const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
      return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
  };
})();