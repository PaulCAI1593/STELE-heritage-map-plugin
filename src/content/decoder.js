// decoder.js
// 解密 STELE 站点接口返回的 b.so() 混淆字符串。
//
// 算法（逆向自站点前端 /dist/app.js，用于互操作性）：
//   首字符 = 密钥长度 N；之后 N 个字符 = 密钥；剩余字符为密文
//   解密：密文字符码点 - 密钥字符码点（循环），结果再 JSON.parse
//
// 说明：这段代码只是把**用户自己浏览器里已经收到的**公开数据进行解码，
// 不绕过任何鉴权，也不额外请求站点。STELE 由 @pkkj 独立维护，
// 本项目对其只有感谢（见 README 致谢一节）。
// 若作者对本用法有异议，请提 issue，我会立即调整。

(function () {
  'use strict';
  window.HMP = window.HMP || {};

  window.HMP.decoder = {
    /**
     * 解密 b.so 混淆字符串
     * @param {string} s 原始混淆字符串（已剥 JSON 包装引号）
     * @returns {object|null} 解密后的 JSON 对象；解密失败返回 null
     */
    bso(s) {
      if (typeof s !== 'string' || s.length < 2) return null;
      const n = s.charCodeAt(0);
      if (s.length < 1 + n) return null;
      const key = s.substring(1, 1 + n);
      const cipher = s.substring(n + 1);
      let plain = '';
      for (let i = 0; i < cipher.length; i++) {
        plain += String.fromCharCode(
          cipher.charCodeAt(i) - key.charCodeAt(i % key.length)
        );
      }
      try {
        return JSON.parse(plain);
      } catch (_) {
        return null;
      }
    },

    /**
     * 自动识别：传入 fetch 响应的 JSON.parse 结果
     * - 如果是字符串（b.so 格式），尝试解密
     * - 如果是对象/数组，直接返回
     * @param {*} parsed
     */
    normalize(parsed) {
      if (typeof parsed === 'string') return this.bso(parsed);
      return parsed;
    }
  };
})();