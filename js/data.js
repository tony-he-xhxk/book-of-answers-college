/*
 * 数据加载层 —— 方案 c：先 fetch answers.txt，失败自动回落到 answers.js
 *
 * - 用 http 打开（本地服务器 / 部署上线）时，读的是 answers.txt 本身，
 *   改完条目刷新即可生效，无需编译。
 * - 用 file:// 双击打开时，浏览器会以 CORS 为由拦截 fetch，
 *   此时自动回落到 build_data.py 生成的 js/answers.js。
 *
 * 两种路径对上层完全透明，统一通过 window.AnswersSource.ready 取数据。
 */
(function (global) {
  'use strict';

  function parse(text) {
    return text
      .split(/\r?\n/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s && s.charAt(0) !== '#'; });
  }

  function fetchTxt() {
    return new Promise(function (resolve, reject) {
      if (typeof global.fetch !== 'function') {
        reject(new Error('fetch unavailable'));
        return;
      }
      fetch('answers.txt?v=' + Date.now(), { cache: 'no-store' })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.text();
        })
        .then(function (text) {
          var list = parse(text);
          if (!list.length) throw new Error('answers.txt is empty');
          resolve(list);
        })
        .catch(reject);
    });
  }

  var inline = (global.ANSWERS && global.ANSWERS.length) ? global.ANSWERS.slice() : [];

  global.AnswersSource = {
    list: inline,
    source: inline.length ? 'inline' : 'none',
    ready: null
  };

  global.AnswersSource.ready = fetchTxt()
    .then(function (list) {
      global.AnswersSource.list = list;
      global.AnswersSource.source = 'txt';
      return global.AnswersSource;
    })
    .catch(function () {
      /* file:// 下被 CORS 拦截属于预期情况，静默回落 */
      return global.AnswersSource;
    });
})(window);
