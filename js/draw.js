/*
 * draw.js —— 抽取引擎
 *
 * 两件事：
 *   1. 洗牌袋抽选：把全部答案洗成一副牌，抽完一轮再重新洗。
 *      一轮之内不会重复抽到同一条 —— 否则连抽两次同一条，用户第一反应是"坏了"。
 *   2. 抽取动画编排：快速连翻 → 指数减速 → 停稳 → 答案墨迹浮现。
 *
 * 节奏公式：t(i) = base × e^(i × growth)
 *   i=0 → 45ms（急促）  i=5 → 179ms  i=9 → 544ms（停稳）
 * 这套"先快后慢"的减速曲线，比任何渲染精度都更能决定"像不像真的在翻书"。
 */
(function (global) {
  'use strict';

  /*
   * 特殊条目规则 —— 只影响「抽完之后显示哪些按钮」，不影响抽选概率。
   * 顺序敏感：含「也没用」的那条必须先匹配，因为它的文本里也包含「再抽一次」。
   * 以后想给新条目加特殊按钮行为，在这里追加一条即可。
   */
  var SPECIAL_RULES = [
    {
      id: 'copyOnly',
      test: function (t) { return /再抽一次\s*也没用/.test(t); }
    },
    {
      id: 'redrawOnly',
      test: function (t) { return /再抽一次/.test(t); }
    }
  ];

  function classify(text) {
    for (var i = 0; i < SPECIAL_RULES.length; i++) {
      if (SPECIAL_RULES[i].test(text)) return SPECIAL_RULES[i].id;
    }
    return 'normal';
  }

  function delay(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /* 答案墨迹浮现 */
  function revealAnswer() {
    var page = document.getElementById('pageRight');
    if (!page) return Promise.resolve();

    var textEl = page.querySelector('.answer-text');
    if (!textEl) return Promise.resolve();

    var bloom = document.createElement('div');
    bloom.className = 'ink-bloom';
    page.appendChild(bloom);
    void bloom.offsetWidth;
    bloom.classList.add('is-on');
    setTimeout(function () {
      if (bloom.parentNode) bloom.parentNode.removeChild(bloom);
    }, 1100);

    if (global.SFX) global.SFX.playBreath();
    textEl.classList.add('is-revealing');

    return new Promise(function (resolve) {
      var done = false;

      function finish() {
        if (done) return;
        done = true;
        textEl.removeEventListener('animationend', onEnd);
        /* 动画结束后摘掉 class，让文字回到无 filter 的清晰渲染 */
        textEl.classList.remove('is-revealing');
        resolve();
      }

      function onEnd(e) {
        if (e.target !== textEl) return;
        finish();
      }

      textEl.addEventListener('animationend', onEnd);
      setTimeout(finish, 1300);
    });
  }

  var Draw = {
    answers: [],
    bag: [],
    last: null,
    pageNo: 0,
    totalDraws: 0,

    init: function (list) {
      this.answers = (list || []).slice();
      this.bag = [];
      this.last = null;
      this.pageNo = 0;
      this.totalDraws = 0;
      this._refill();
      return this;
    },

    _refill: function () {
      var a = this.answers.slice();
      for (var i = a.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = a[i];
        a[i] = a[j];
        a[j] = tmp;
      }
      this.bag = a;
    },

    /* 抽下一条。袋空则重新洗，并保证不与上一条紧邻重复。 */
    next: function () {
      if (!this.answers.length) return null;

      if (!this.bag.length) {
        this._refill();
        var n = this.bag.length;
        if (n > 1 && this.last != null && this.bag[n - 1] === this.last) {
          var tmp = this.bag[n - 1];
          this.bag[n - 1] = this.bag[n - 2];
          this.bag[n - 2] = tmp;
        }
      }

      var text = this.bag.pop();
      this.last = text;
      this.pageNo++;
      this.totalDraws++;

      return {
        text: text,
        pageNo: this.pageNo,
        mode: classify(text)
      };
    },

    /*
     * 演一遍抽取动画并返回抽中的条目。
     *   rounds: 翻页次数（首次 10 次连翻，再抽 3 次干脆翻过）
     *   base  : 首次翻页间隔 ms
     *   growth: 间隔的指数增长系数
     */
    run: function (opt) {
      opt = opt || {};
      var rounds = opt.rounds || 10;
      var base = opt.base || 45;
      var growth = opt.growth || 0.28;

      var picked = this.next();
      if (!picked) return Promise.resolve(null);

      var gaps = [];
      for (var i = 0; i < rounds; i++) gaps.push(base * Math.exp(i * growth));

      var answerPage = global.Book.buildAnswerPage(picked.text);
      var currentRight = global.Book.nextFakePage();
      var revealDone = null;
      var chain = Promise.resolve();

      gaps.forEach(function (gap, idx) {
        chain = chain.then(function () {
          var isLast = (idx === gaps.length - 1);
          var dur = isLast ? 430 : Math.max(38, Math.min(gap * 0.85, 300));
          var front = currentRight;
          var next = isLast ? answerPage : global.Book.nextFakePage();
          currentRight = next;

          global.SFX.playFlip(isLast ? 1 : 0.5);

          return global.Book.flip({
            front: front,
            back: global.Book.nextFakePage(),
            under: next,
            dur: dur,
            onSettled: isLast ? function () {
              global.SFX.playLand();
              revealDone = revealAnswer();
            } : null
          }).then(function () {
            if (isLast) return;
            var wait = gap - dur;
            if (wait > 4) return delay(wait);
          });
        });
      });

      return chain
        .then(function () { return revealDone || Promise.resolve(); })
        .then(function () { return picked; });
    }
  };

  global.Draw = Draw;
})(window);
