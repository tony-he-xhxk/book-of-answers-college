/*
 * book.js —— 翻页引擎
 *
 * 核心抽象是一张「叶片」(leaf)：它贴在右半页，绕中缝（left center）旋转 -180°，
 * 正面是即将被翻走的那一页，背面是翻过去之后左页将显示的内容。
 *
 * 每次翻页新建一个 leaf，动画结束即移除，并把状态固化到底层页面（pageLeft /
 * pageRight）。这样避免了持久化的 3D 状态互相打架，连翻几十次也不会累积 DOM。
 *
 * 时序推进只认 animationend，setTimeout 仅作为「标签页切到后台时动画事件丢失」
 * 的兜底，绝不用它去猜动画时长。
 */
(function (global) {
  'use strict';

  /* 确定性伪随机，保证同一 seed 生成的假文字页可复现 */
  function rng(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  var FAKE_LINE_TARGET = 21;
  var FAKE_VARIANTS = 5;

  var Book = {
    el: null,
    spread: null,
    leafLayer: null,
    cover: null,
    pageLeft: null,
    pageRight: null,
    folioLeft: null,
    folioRight: null,
    halfLeft: null,

    state: 'closed',
    busy: false,

    _fakeCache: [],
    _fakeIdx: 0,

    /* ---------------------------------------------------------------- 装配 */

    init: function () {
      this.el = document.getElementById('book');
      this.spread = document.getElementById('spread');
      this.leafLayer = document.getElementById('leafLayer');
      this.cover = document.getElementById('cover');
      this.pageLeft = document.getElementById('pageLeft');
      this.pageRight = document.getElementById('pageRight');
      this.folioLeft = document.getElementById('folioLeft');
      this.folioRight = document.getElementById('folioRight');
      this.halfLeft = document.getElementById('halfLeft');
      return this;
    },

    setState: function (s) {
      this.state = s;
      this.el.setAttribute('data-state', s);
    },

    /* ------------------------------------------------------ 开书 / 合书 */

    open: function () {
      var self = this;
      if (this.state !== 'closed') return Promise.resolve();

      this.busy = true;
      void this.el.offsetWidth;
      this.setState('open');

      return new Promise(function (resolve) {
        var done = false;
        function finish() {
          if (done) return;
          done = true;
          self.cover.removeEventListener('transitionend', onEnd);
          self.busy = false;
          self.setState('idle');
          resolve();
        }
        function onEnd(e) {
          if (e.target !== self.cover || e.propertyName !== 'transform') return;
          finish();
        }
        self.cover.addEventListener('transitionend', onEnd);
        setTimeout(finish, 1500);
      });
    },

    close: function () {
      var self = this;
      if (this.state === 'closed') return Promise.resolve();

      this.busy = true;
      this.setState('closing');

      return new Promise(function (resolve) {
        var done = false;
        function finish() {
          if (done) return;
          done = true;
          self.cover.removeEventListener('transitionend', onEnd);
          self.busy = false;
          self.clearLeafs();
          self.setState('closed');
          resolve();
        }
        function onEnd(e) {
          if (e.target !== self.cover || e.propertyName !== 'transform') return;
          finish();
        }
        self.cover.addEventListener('transitionend', onEnd);
        setTimeout(finish, 1500);
      });
    },

    /* ------------------------------------------------------------ 翻一页 */

    /*
     * opt = {
     *   front      : string  —— 叶片正面 HTML（即将被翻走的那页）
     *   back       : string  —— 叶片背面 HTML（翻过去后左页显示的内容）
     *   under      : string? —— 底层右页在翻页期间就替换成下一页内容
     *   dur        : number  —— 动画时长 ms
     *   onSettled  : fn?     —— 落页后回调（用于触发墨迹浮现）
     * }
     */
    flip: function (opt) {
      var self = this;
      var dur = opt.dur || 420;

      return new Promise(function (resolve) {
        var leaf = document.createElement('div');
        leaf.className = 'leaf';
        leaf.style.setProperty('--dur', dur + 'ms');

        var front = document.createElement('div');
        front.className = 'leaf-face leaf-front';
        front.innerHTML = opt.front || '';

        var back = document.createElement('div');
        back.className = 'leaf-face leaf-back';
        back.innerHTML = opt.back || '';

        leaf.appendChild(front);
        leaf.appendChild(back);
        self.leafLayer.appendChild(leaf);

        /* 强制重排：确保动画从 0deg 起步，而不是从上一帧的终态续上 */
        void leaf.offsetWidth;

        /* 底层右页此刻被叶片完全遮住，可以先换成下一页，落页即见 */
        if (opt.under !== undefined) self.setPage('right', opt.under);

        var settled = false;
        function onEnd(e) {
          if (e && e.target !== leaf) return;
          if (settled) return;
          settled = true;
          leaf.removeEventListener('animationend', onEnd);
          leaf.remove();

          /* 叶片消失后，左页需接管它背面的内容，否则会闪回空白 */
          if (opt.back !== undefined) self.setPage('left', opt.back);
          if (typeof opt.onSettled === 'function') opt.onSettled();
          resolve();
        }

        leaf.addEventListener('animationend', onEnd);
        leaf.classList.add('is-flipping');

        /* 兜底：页面隐藏时 animationend 可能不触发 */
        setTimeout(function () { onEnd(null); }, dur + 260);
      });
    },

    clearLeafs: function () {
      if (this.leafLayer) this.leafLayer.innerHTML = '';
    },

    /* ---------------------------------------------------------- 内容渲染 */

    setPage: function (side, html) {
      var el = (side === 'left') ? this.pageLeft : this.pageRight;
      if (el) el.innerHTML = html || '';
    },

    setFolio: function (n) {
      if (!this.folioLeft) return;
      if (n == null) {
        this.folioLeft.textContent = '';
        this.folioRight.textContent = '';
        this.folioLeft.classList.remove('is-on');
        this.folioRight.classList.remove('is-on');
        return;
      }
      this.folioLeft.textContent = String(n - 1);
      this.folioRight.textContent = '— ' + n + ' —';
      this.folioLeft.classList.add('is-on');
      this.folioRight.classList.add('is-on');
    },

    /* 答案页：按字数分级字号，避免长句撑破版面 */
    buildAnswerPage: function (text) {
      var len = text.length;
      var size;
      if (len <= 6) size = 'xs';
      else if (len <= 10) size = 's';
      else if (len <= 15) size = 'm';
      else size = 'l';

      return '<div class="answer-mark"></div>' +
             '<p class="answer-text" data-len="' + size + '">' +
             escapeHtml(text) + '</p>';
    },

    /* 假文字页：快速翻页时掠过的"字迹"，让纸看起来有内容 */
    nextFakePage: function () {
      if (!this._fakeCache.length) {
        for (var i = 0; i < FAKE_VARIANTS; i++) {
          this._fakeCache.push(this._buildFakePage(0x9e37 + i * 7919));
        }
      }
      var html = this._fakeCache[this._fakeIdx % this._fakeCache.length];
      this._fakeIdx++;
      return html;
    },

    _buildFakePage: function (seed) {
      var r = rng(seed);
      var out = '<div class="fake-lines">';
      var count = 0;

      while (count < FAKE_LINE_TARGET) {
        var paraLen = 3 + Math.floor(r() * 5);
        for (var i = 0; i < paraLen && count < FAKE_LINE_TARGET; i++) {
          var w;
          if (i === paraLen - 1) {
            w = 26 + r() * 38;              /* 段末短行 */
          } else {
            w = 86 + r() * 14;              /* 齐行 */
          }
          if (r() < 0.06) w = 40 + r() * 40; /* 偶尔一个意外短行 */
          out += '<div class="fake-line" style="width:' +
                 w.toFixed(1) + '%"></div>';
          count++;
        }
        if (count < FAKE_LINE_TARGET) out += '<div class="fake-gap"></div>';
      }

      out += '</div>';
      return out;
    },

    /* 墨圈扩散元素 */
    makeBloom: function () {
      var b = document.createElement('div');
      b.className = 'ink-bloom';
      return b;
    },

    reset: function () {
      this.clearLeafs();
      this.setPage('left', '');
      this.setPage('right', '');
      this.setFolio(null);
      this._fakeIdx = 0;
    }
  };

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  global.Book = Book;
})(window);
