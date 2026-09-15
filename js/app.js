/*
 * app.js —— 状态机与界面主控
 *
 * 状态流转：
 *   closed ──点封面──▶ idle ──抽取──▶ drawing ──落页──▶ showing
 *      ▲                                                    │
 *      └──────────── 点左侧书页合上 ◀──────────────────────┘
 *                     （showing 下点「再抽一次」则回到 drawing）
 *
 * 按钮显隐由条目类别决定（见 draw.js 的 SPECIAL_RULES）：
 *   normal     → 「再抽一次」+「复制结果」
 *   redrawOnly → 只有「再抽一次」（抽到的正是"再抽一次"）
 *   copyOnly   → 只有「复制结果」（抽到的正是"再抽一次也没用"）
 */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------ 复制兜底 */

  function copyText(text) {
    if (navigator.clipboard && global.isSecureContext) {
      return navigator.clipboard.writeText(text)
        .then(function () { return true; })
        .catch(function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.left = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  /* ---------------------------------------------------------------- 工具 */

  function showBtn(el) {
    if (!el.classList.contains('is-hidden')) return;
    el.classList.remove('is-hidden');
    el.classList.add('is-entering');
    setTimeout(function () { el.classList.remove('is-entering'); }, 420);
  }

  function hideBtn(el) {
    el.classList.add('is-hidden');
  }

  /* -------------------------------------------------------------- 主控 */

  var App = {
    els: {},
    drawing: false,
    current: null,
    _toastTimer: null,
    _count: 0,

    start: function () {
      var self = this;

      this.els = {
        cover: document.getElementById('cover'),
        halfLeft: document.getElementById('halfLeft'),
        btnDraw: document.getElementById('btnDraw'),
        btnRedraw: document.getElementById('btnRedraw'),
        btnCopy: document.getElementById('btnCopy'),
        btnSound: document.getElementById('btnSound'),
        soundLabel: document.getElementById('soundLabel'),
        toast: document.getElementById('toast'),
        footHint: document.getElementById('footHint')
      };

      global.Book.init();
      this.bind();
      /* 书还合着，先把抽取/复制按钮收起来 */
      this.syncButtons();

      global.AnswersSource.ready.then(function (src) {
        if (!src.list || !src.list.length) {
          self.fatal();
          return;
        }
        global.Draw.init(src.list);
        self._count = src.list.length;

        if (self.els.footHint) {
          self.els.footHint.textContent = self._hintText();
        }
        /* 页脚文字加了「共 N 条」，窄屏上可能因此多折一行、顶掉书的高度，
           所以文字改完要重量一次 */
        if (global.Fit) global.Fit.apply();
        console.log('[答案之书] 已载入 ' + src.list.length +
                    ' 条答案，数据来源：' + src.source);
      });
    },

    /* 窄屏下左侧书页是隐藏的，合书入口改由页脚提示承担 */
    _isNarrow: function () {
      return global.matchMedia('(max-width: 760px)').matches;
    },

    _hintText: function () {
      var base = '轻触封面翻开 · ';
      base += this._isNarrow() ? '轻触此处合上' : '轻触左侧书页合上';
      if (this._count) base += ' · 共 ' + this._count + ' 条';
      return base;
    },

    fatal: function () {
      if (this.els.footHint) {
        this.els.footHint.textContent =
          '未读到任何答案，请检查 answers.txt 或先运行 build.bat';
      }
      console.error('[答案之书] 答案列表为空。');
    },

    /* ---------------------------------------------------------- 事件绑定 */

    bind: function () {
      var self = this;

      this.els.cover.addEventListener('click', function () { self.openBook(); });
      this.els.cover.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          self.openBook();
        }
      });

      this.els.halfLeft.addEventListener('click', function () { self.closeBook(); });

      /* 页脚提示同时也是窄屏下的合书入口 */
      if (this.els.footHint) {
        this.els.footHint.addEventListener('click', function () { self.closeBook(); });
      }

      global.addEventListener('resize', function () {
        if (self.els.footHint) self.els.footHint.textContent = self._hintText();
        /* 提示文案会随宽窄切换（「轻触左侧书页合上」↔「轻触此处合上」），
           行数可能变，所以要重算一次书体尺寸 */
        if (global.Fit) global.Fit.apply();
      });

      this.els.btnDraw.addEventListener('click', function () { self.draw(false); });
      this.els.btnRedraw.addEventListener('click', function () { self.draw(true); });
      this.els.btnCopy.addEventListener('click', function () { self.copyAnswer(); });
      this.els.btnSound.addEventListener('click', function () { self.toggleSound(); });

      /* 键盘：空格 / 回车 快速抽取，Esc 合书 */
      document.addEventListener('keydown', function (e) {
        var tag = (e.target && e.target.tagName) || '';
        if (/^(INPUT|TEXTAREA|BUTTON|SELECT)$/.test(tag)) return;

        if (e.key === 'Escape') {
          self.closeBook();
          return;
        }

        if (e.key === ' ' || e.key === 'Enter') {
          if (global.Book.state === 'closed') {
            e.preventDefault();
            self.openBook();
          } else if (global.Book.state === 'idle') {
            e.preventDefault();
            self.draw(false);
          } else if (global.Book.state === 'showing' && self.canRedraw()) {
            e.preventDefault();
            self.draw(true);
          }
        }
      });
    },

    /* ------------------------------------------------------------ 开 / 合 */

    openBook: function () {
      var self = this;
      if (global.Book.busy || global.Book.state !== 'closed') return;

      /* 首次用户手势 —— 在这里解锁 Web Audio */
      global.SFX.unlock();
      global.SFX.playOpen();

      global.Book.reset();
      this.current = null;

      global.Book.open().then(function () {
        global.Book.setPage('right',
          '<div class="answer-mark"></div>' +
          '<p class="answer-text is-hint" data-len="s">' +
          '心中默念你的问题<br>然后抽取答案</p>');
        global.Book.setFolio(null);
        self.syncButtons();
      });
    },

    closeBook: function () {
      if (global.Book.busy || this.drawing) return;
      if (global.Book.state === 'closed') return;

      global.SFX.playClose();
      global.Book.close().then(function () {
        App.current = null;
        App.syncButtons();
      });
    },

    /* -------------------------------------------------------------- 抽取 */

    canRedraw: function () {
      return !!this.current && this.current.mode !== 'copyOnly';
    },

    draw: function (isRedraw) {
      var self = this;

      if (this.drawing || global.Book.busy) return;
      if (global.Book.state === 'closed') return;
      if (isRedraw && !this.canRedraw()) return;

      this.drawing = true;
      global.Book.setState('drawing');
      this.setBusy(true);
      hideBtn(this.els.btnRedraw);
      hideBtn(this.els.btnCopy);

      global.Draw.run({ rounds: isRedraw ? 3 : 10 })
        .then(function (picked) {
          self.drawing = false;
          self.current = picked;
          self.setBusy(false);

          if (!picked) {
            global.Book.setState('idle');
            self.syncButtons();
            return;
          }

          global.Book.setState('showing');
          global.Book.setFolio(picked.pageNo);
          self.syncButtons();
        });
    },

    setBusy: function (on) {
      this.els.btnDraw.disabled = on;
      this.els.btnRedraw.disabled = on;
      this.els.btnCopy.disabled = on;
      this.els.btnDraw.classList.toggle('is-busy', on);
    },

    /* ------------------------------------------------------ 按钮显隐同步 */

    syncButtons: function () {
      var e = this.els;
      var c = this.current;

      if (global.Book.state === 'closed') {
        hideBtn(e.btnDraw);
        hideBtn(e.btnRedraw);
        hideBtn(e.btnCopy);
        return;
      }

      if (global.Book.state !== 'showing' || !c) {
        showBtn(e.btnDraw);
        e.btnDraw.textContent = '抽取答案';
        hideBtn(e.btnRedraw);
        hideBtn(e.btnCopy);
        return;
      }

      /* showing：主按钮退场，由下方两个按钮接管 */
      hideBtn(e.btnDraw);

      if (c.mode === 'copyOnly') {
        hideBtn(e.btnRedraw);
        showBtn(e.btnCopy);
      } else if (c.mode === 'redrawOnly') {
        showBtn(e.btnRedraw);
        hideBtn(e.btnCopy);
      } else {
        showBtn(e.btnRedraw);
        showBtn(e.btnCopy);
      }
    },

    /* -------------------------------------------------------------- 复制 */

    copyAnswer: function () {
      var self = this;
      if (!this.current) return;

      copyText(this.current.text).then(function (ok) {
        if (ok) {
          self.toast('已复制：' + truncate(self.current.text, 14));
        } else {
          self.toast('复制失败，请手动选中文字');
        }
      });
    },

    /* ------------------------------------------------------------ 音效 */

    toggleSound: function () {
      var on = global.SFX.toggle();
      this.els.btnSound.setAttribute('aria-pressed', on ? 'true' : 'false');
      this.els.soundLabel.textContent = on ? '音效开' : '音效关';
      if (on) global.SFX.playFlip(0.6);
    },

    /* -------------------------------------------------------------- 提示 */

    toast: function (msg) {
      var el = this.els.toast;
      el.textContent = msg;
      el.classList.add('is-on');

      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(function () {
        el.classList.remove('is-on');
      }, 1900);
    }
  };

  function truncate(s, n) {
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  global.App = App;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { App.start(); });
  } else {
    App.start();
  }
})(window);
