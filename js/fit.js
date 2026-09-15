/*
 * fit.js —— 视口自适应：让书体撑满可用空间
 *
 * 目标：在不超宽、不超高、也不让翻页叶片被屏幕边缘切掉的前提下，
 *       把书放到尽可能大。
 *
 * ---------------------------------------------------------------------------
 * 一、书体的尺寸只有一个真源
 * ---------------------------------------------------------------------------
 * 书宽 --book-w = --book-h × --book-ratio；书内一切排版尺寸（答案字号、装饰线、
 * 封面字、页码）都写成 calc(var(--book-h) * k)。所以只要算出 --book-h，
 * 整本书连同字号一起等比缩放，不存在第二处需要同步调的地方。
 * 本文件把结果写在 documentElement 的内联 style 上（优先级高于样式表），
 * 因此 css/book.css 里的 --book-h 只是 JS 没跑起来时的静态兜底。
 *
 * ---------------------------------------------------------------------------
 * 二、为什么必须预留「叶片上顶」的空间
 * ---------------------------------------------------------------------------
 * 叶片绕中缝旋转时，转到 90° 附近远端朝向视点，被透视放大 D/(D-halfW)；
 * 书体本身又有 rotateX(7deg) 倾角，于是「朝向视点」在屏幕上同时表现为「向上」。
 * 两者叠加，叶片最高点会超出书体上沿 —— 实测比例 K ≈ 0.145（c = 12 时）。
 *
 * 这个上顶量正比于书体尺寸，是无量纲常数（K 在 1400x940 / 1600x1000 /
 * 1920x1080 / 1080x620 四个视口测得 0.1435~0.1448，偏差 0.0013）。
 * 书体小的时候上顶量恰好被顶栏那块留白吃掉，看不出来；书一旦撑满，
 * 上顶部分就会被屏幕顶边切平。所以撑满和"不切叶片"必须一起考虑。
 *
 * K 由 .shots/measure_overshoot.js 测定，改动 --tilt 或 .stage 的
 * perspective 系数后必须重测，否则这里的预留量会对不上。
 *
 * ---------------------------------------------------------------------------
 * 三、求解方式：实测 + 迭代，不用公式硬算
 * ---------------------------------------------------------------------------
 * 约束是「书体上沿到屏幕顶的距离 ≥ K × 书高」。这个距离取决于顶栏/页脚/
 * 间距等一堆元素的实际高度，还包括 .app 垂直居中后上下各分到一半的空白，
 * 用纯 CSS 表达不出来（CSS 拿不到 chrome 的实测高度）。
 *
 * 采用迭代：先按可用空间估一个书高，写进去，量出书体上沿的实际位置，
 * 不够就缩，反复几次即收敛。收敛快是因为留白对书高的导数可以算出来：
 *   slack = A_top + (A - H) / 2   →   dslack/dH = -0.5
 * 而需求 K×H 的导数是 +K，所以每缩小 1px 书高只能换回 0.5px 留白，
 * 缺口以 (K + 0.5) 的速率扩大 —— 除以这个速率就是一步到位的步长。
 *
 * 迭代还有一个额外好处：不依赖任何尺寸常量。日后改 padding、gap、字号，
 * 预留量会自动跟着变，不会失配。
 *
 * ---------------------------------------------------------------------------
 * 四、为什么不会来回震荡
 * ---------------------------------------------------------------------------
 * chrome 里每一段（padding / gap / 顶栏 / 控制条 / 页脚）都由 vh、vw、clamp
 * 或固定 px 定尺寸，与 --book-h 无关；--app-w 是由算好的书宽反推出来的，
 * 不参与计算。唯一的软连接是页脚提示文字可能随宽度换行，所以每次写完变量
 * 都要重新量（见 measure 与 apply 的循环），而不是量一次用到底。
 */
(function (global) {
  'use strict';

  /* 对开书 宽:高；窄屏退化为单页时用后者，与 css/book.css 里的值一致 */
  var RATIO_WIDE = 1.58;
  var RATIO_NARROW = 0.82;
  var NARROW_MAX = 760;

  /*
   * 叶片上顶比例 K（上顶峰值 / 书体高），已含安全余量：
   * 实测 0.1448 × 1.10 ≈ 0.159。
   * 宽屏 c = 12；窄屏是单页模式（半页宽 = 整书宽），实测 0.1701 × 1.10 ≈ 0.187。
   */
  var K_WIDE = 0.159;
  var K_NARROW = 0.187;

  /* 安全余量：宁可小几像素，也不要因亚像素误差把书顶出视口
     （body 是 overflow: hidden，多出来的部分会被直接切掉） */
  var SAFETY = 4;

  /* 尺寸上限与下限 —— 只为「别荒唐」，不是设计约束 */
  var MAX_BOOK_H = 1100;
  var MIN_BOOK_H = 180;

  var MAX_PASSES = 6;

  var _queued = false;
  var _last = null;

  /*
   * 量出「除书体之外」的高度占用 total，以及真正可用的宽度 availW。
   * total 里含上下 padding、顶栏/控制条/页脚的高度、以及各段之间的 gap。
   */
  function measure(app, stage) {
    var cs = global.getComputedStyle(app);
    var padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    var padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);

    var gap = parseFloat(cs.rowGap);
    if (!isFinite(gap)) gap = parseFloat(cs.gap) || 0;

    var total = padY;
    var kids = app.children;
    var n = 0;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i] === stage) continue;
      total += kids[i].getBoundingClientRect().height;
      n++;
    }
    /* n 个非 stage 子元素 + stage 本身 = n+1 个孩子，故间隔有 n 段 */
    total += gap * n;

    return { total: total, padX: padX };
  }

  var _book = null;
  function bookTop() {
    if (!_book) _book = document.getElementById('book');
    return _book.getBoundingClientRect().top;
  }

  function write(h, ratio) {
    var style = document.documentElement.style;
    style.setProperty('--book-h', h.toFixed(2) + 'px');
    style.setProperty('--book-ratio', String(ratio));
    return h * ratio;
  }

  var _bookEl = null;
  function bookEl() {
    if (!_bookEl) _bookEl = document.getElementById('book');
    return _bookEl;
  }

  /*
   * 定尺寸期间必须临时关掉 .book 的 transform 过渡。
   *
   * 原因：闭合态的 transform 是 rotateX(7deg) translateX(-半页宽/2)，
   * 与 --book-h 挂钩；.book 上又挂着 var(--dur-book)=1100ms 的过渡，
   * 那是给"翻开/合上"用的。两者一撞，改尺寸就会连带把 transform 也做成
   * 一段 1100ms 的动画 —— 实测首屏加载时封面会自己横向滑动 53px。
   *
   * 只在 data-state="closed" 时关：其余状态（open/idle/drawing/showing）
   * 的 translateX 恒为 0，本来就与 --book-h 无关，不需要也不该动它，
   * 免得在开合动画途中把过渡掐断。
   *
   * 时机的正确性依赖一点：设置与读取之间必须发生一次样式重算，
   * 让"无过渡"这一状态被真正见到。下面的 bookTop() 会强制重算。
   */
  function suppressTransition(on) {
    var b = bookEl();
    if (!b) return;
    b.style.transition = on ? 'none' : '';
  }

  function apply() {
    var app = document.querySelector('.app');
    var stage = document.querySelector('.stage');
    if (!app || !stage) return null;

    var narrow = global.matchMedia('(max-width: ' + NARROW_MAX + 'px)').matches;
    var ratio = narrow ? RATIO_NARROW : RATIO_WIDE;
    var K = narrow ? K_NARROW : K_WIDE;

    var b = bookEl();
    var quiet = !!b && b.getAttribute('data-state') === 'closed';
    if (quiet) suppressTransition(true);

    var h = 0;
    var solve = false;
    var top = 0;

    for (var pass = 0; pass < MAX_PASSES; pass++) {
      var m = measure(app, stage);

      if (pass === 0) {
        /* 初值：高度、宽度、上限三者取最小 */
        var availH = global.innerHeight - m.total - SAFETY;
        var availW = global.innerWidth - m.padX;
        h = Math.min(availH, availW / ratio, MAX_BOOK_H);
        if (!isFinite(h) || h < MIN_BOOK_H) h = MIN_BOOK_H;
      }

      write(h, ratio);

      /* 让布局和 3D 投影都跟上，再量书体上沿 */
      top = bookTop();
      var need = K * h;

      if (top >= need - 0.5) {
        solve = pass > 0;   /* 第一次就满足，说明不需要预留 */
        break;
      }

      /* 缺口以 (K + 0.5) 的速率扩大，除以它即一步到位 */
      h -= (need - top) / (0.5 + K);
      if (h < MIN_BOOK_H) { h = MIN_BOOK_H; break; }
    }

    var finalW = write(h, ratio);

    /* 容器宽度按书宽反推，让顶栏/控制条的左右边缘跟书对齐 */
    var padX = parseFloat(global.getComputedStyle(app).paddingLeft) * 2;
    var appW = finalW + padX;
    if (appW > global.innerWidth) appW = global.innerWidth;
    document.documentElement.style.setProperty('--app-w', appW.toFixed(2) + 'px');

    if (quiet) {
      /* 强制一次重算，让最终值以"无过渡"的形式落地，再恢复过渡 */
      top = bookTop();
      suppressTransition(false);
    }

    _last = {
      h: h, w: finalW, ratio: ratio, narrow: narrow, reserve: K * h,
      slack: top, solved: solve
    };
    return _last;
  }

  /* 合并同一帧内的多次请求（resize 会连发几十次） */
  function fit() {
    if (_queued) return;
    _queued = true;
    global.requestAnimationFrame(function () {
      _queued = false;
      apply();
    });
  }

  function boot() {
    /* 本文件在 </body> 前同步执行，这次 apply 发生在首帧绘制之前，
       所以看不到「先小后大」的跳动 */
    apply();

    global.addEventListener('resize', fit);
    global.addEventListener('orientationchange', fit);

    /* 字体度量会改变顶栏与页脚的高度，等字体就绪再量一次 */
    if (document.fonts && document.fonts.ready &&
        typeof document.fonts.ready.then === 'function') {
      document.fonts.ready.then(function () { apply(); });
    }
  }

  global.Fit = {
    apply: apply,
    fit: fit,
    last: function () { return _last; },
    K_WIDE: K_WIDE,
    K_NARROW: K_NARROW,
    RATIO_WIDE: RATIO_WIDE,
    RATIO_NARROW: RATIO_NARROW
  };

  boot();
})(window);
