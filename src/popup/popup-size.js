// src/popup/popup-size.js
// #12：按屏幕分辨率选一档弹窗宽度，写到 CSS 变量 --hmp-popup-w。
// 只算宽度、只碰 documentElement.style，不碰 DOM 内容，不读 cookie、不发网络请求。
'use strict';
(function () {
  // 屏幕宽度 → 弹窗宽度。分档而不是占满屏幕：弹窗里是单列表单，一行拉太长反而难读。
  var STEPS = [[2560, 560], [1920, 520], [1536, 480], [1280, 440]];
  var BASE = 400;   // 最小档
  var MIN_W = 400;  // 下限 400（任务书 §五：上限 560、下限 400）
  var EDGE = 40;    // 左右各让 20px，避免顶到屏幕边

  // 纯函数：screenW 决定档位；availW（可选，缺省取 screen.availWidth）做上限收敛。
  function pickPopupWidth(screenW, availW) {
    var w = BASE;
    if (typeof screenW === 'number' && isFinite(screenW)) {
      for (var i = 0; i < STEPS.length; i++) {
        if (screenW >= STEPS[i][0]) { w = STEPS[i][1]; break; }
      }
    }
    if (typeof availW !== 'number' || !isFinite(availW)) {
      if (typeof screen !== 'undefined' && screen && typeof screen.availWidth === 'number') {
        availW = screen.availWidth;
      }
    }
    if (typeof availW === 'number' && isFinite(availW)) {
      var cap = Math.max(MIN_W, availW - EDGE);
      if (cap < w) w = cap;
    }
    return w;
  }

  function apply() {
    if (typeof document === 'undefined' || !document.documentElement) return 0;
    var sw, aw;
    if (typeof screen !== 'undefined' && screen) { sw = screen.width; aw = screen.availWidth; }
    var w = pickPopupWidth(sw, aw);
    document.documentElement.style.setProperty('--hmp-popup-w', w + 'px');
    return w;
  }

  var api = { pickPopupWidth: pickPopupWidth, apply: apply };
  if (typeof window !== 'undefined') {
    window.HMP = window.HMP || {};
    window.HMP.popupSize = api;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  // 弹窗每次打开重新算；系统缩放变化不监听（弹窗生命周期短，监听只增加状态）。
  if (typeof document !== 'undefined' && document.documentElement) apply();
})();
