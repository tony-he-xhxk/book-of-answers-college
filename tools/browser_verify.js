/*
 * browser_verify.js —— 端到端回归验证（node tools/browser_verify.js）
 *
 * 补充条目、改动 CSS 或 JS 之后跑一遍，能一次性发现：
 *   数据两条路径（http 读 txt / file 回落 js）· 开书抽书流程 · 特殊条目按钮规则
 *   复制双通道 · 布局溢出与视口自适应 · 窄屏单页 · 翻页时长与 DOM 是否累积
 *   开合动效时序 · 控制台报错
 *
 * 依赖：playwright-core + 一个 Chromium 系浏览器（位置自动探测，见 tools/_env.js）
 * 前置：需要一个本地服务器。若 8765 端口没有服务，脚本会自己起一个
 *       （纯 Node 实现，不需要 Python）。
 */
const fs = require('fs');
const path = require('path');

/*
 * 本机相关的三件事（playwright-core 位置 / Chromium 位置 / 静态服务）
 * 全部收敛到 tools/_env.js，脚本里不再出现任何绝对路径与本机用户名。
 */
const env = require('./_env');
const ROOT = env.ROOT;
const PORT = 8765;
const HTTP_URL = 'http://127.0.0.1:' + PORT + '/index.html';
const FILE_URL = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');

/*
 * 翻页时叶片上顶书体上沿的真实比例（上顶峰值 / 书体高），由
 * .shots/measure_overshoot.js 在多个视口实测，偏差 0.0013。
 * 只与「书体倾角 + 透视距离/半页宽」有关，与书体大小无关。
 * 改动 --tilt 或 .stage 的 perspective 系数后必须重测，否则这里的断言会失真。
 *
 * 注意分工：用这个常数做的「顶部预留到位」是模型推算，属于弱校验 ——
 * 万一 K 与 CSS 失配（比如有人改了透视却没重测），它照样会通过。
 * 真正权威的判据是 F2 段里逐帧采样的「翻页全程叶片不越出视口上边」，
 * 它直接量叶片的实际位置，不依赖任何常数。两者互为补充，别只留一个。
 */
const K_OVERSHOOT_TRUE = 0.145;

/* ------------------------------------------------------------ 断言与汇总 */

const results = [];
function ok(name, pass, detail) {
  results.push({ name, pass });
  console.log((pass ? '  [OK]   ' : '  [FAIL] ') + name +
              (detail ? '  -> ' + detail : ''));
}

function section(title) {
  console.log('\n=== ' + title + ' ===');
}

/* ------------------------------------------------------------ 静态服务 */
/* http 服务改由 tools/_env.js 用 Node 自带的 http 实现，不再 spawn Python */

/* ---------------------------------------------------------------- 主流程 */

(async () => {
  const chrome = env.findChrome();
  console.log('Chromium: ' + (chrome || '（未找到可执行文件，交由 Playwright 自动选择）'));

  const { server } = await env.ensureServer(PORT, ROOT);

  const browser = await env.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1500, height: 940 },
    deviceScaleFactor: 1
  });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  const page = await ctx.newPage();

  const msgs = [];
  page.on('console', m => msgs.push('[' + m.type() + '] ' + m.text()));
  page.on('pageerror', e => msgs.push('[pageerror] ' + e.message));

  /* ---------------------------------------- A. http 路径数据加载 */
  section('A. http:// 路径（应走 fetch answers.txt）');
  await page.goto(HTTP_URL, { waitUntil: 'load' });
  await page.waitForTimeout(900);

  const a = await page.evaluate(() => ({
    count: window.AnswersSource.list.length,
    source: window.AnswersSource.source,
    state: window.Book.state,
    btnDrawVisible: !document.getElementById('btnDraw').classList.contains('is-hidden'),
    btnRedrawHidden: document.getElementById('btnRedraw').classList.contains('is-hidden'),
    btnCopyHidden: document.getElementById('btnCopy').classList.contains('is-hidden')
  }));
  ok('数据源 = txt', a.source === 'txt', '实际 ' + a.source);
  ok('已载入答案条目', a.count > 0, a.count + ' 条');
  ok('初始状态 = closed', a.state === 'closed', '实际 ' + a.state);
  ok('初始按钮全部收起', !a.btnDrawVisible && a.btnRedrawHidden && a.btnCopyHidden);

  section('B. 翻开封面');
  await page.click('#cover');
  await page.waitForTimeout(1500);
  const b = await page.evaluate(() => ({
    state: window.Book.state,
    btnDrawVisible: !document.getElementById('btnDraw').classList.contains('is-hidden'),
    btnDrawText: document.getElementById('btnDraw').textContent,
    rightPage: (document.querySelector('#pageRight .answer-text') || {}).textContent || ''
  }));
  ok('开书后状态 = idle', b.state === 'idle', '实际 ' + b.state);
  ok('主按钮出现且文案为「抽取答案」',
     b.btnDrawVisible && b.btnDrawText === '抽取答案', '"' + b.btnDrawText + '"');
  ok('右页显示引导语', /心中默念/.test(b.rightPage), '"' + b.rightPage + '"');

  section('C. 抽取答案');
  await page.click('#btnDraw');
  await page.waitForFunction(() => window.Book.state === 'showing',
    null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1400);

  const c = await page.evaluate(() => {
    const el = document.querySelector('#pageRight .answer-text');
    const face = document.getElementById('pageRight');
    const r = el ? el.getBoundingClientRect() : null;
    const fr = face.getBoundingClientRect();
    return {
      state: window.Book.state,
      answer: el ? el.textContent : null,
      overflowX: r ? r.width > fr.width + 1 : null,
      overflowY: r ? r.height > fr.height + 1 : null,
      folio: document.getElementById('folioRight').textContent,
      btnRedrawVisible: !document.getElementById('btnRedraw').classList.contains('is-hidden'),
      btnCopyVisible: !document.getElementById('btnCopy').classList.contains('is-hidden'),
      btnDrawHidden: document.getElementById('btnDraw').classList.contains('is-hidden')
    };
  });
  ok('抽取后状态 = showing', c.state === 'showing', '实际 ' + c.state);
  ok('右页出现答案文字', !!c.answer, '"' + c.answer + '"');
  ok('答案未溢出页面', c.overflowX === false && c.overflowY === false,
     'x=' + c.overflowX + ' y=' + c.overflowY);
  ok('页码已显示', /—/.test(c.folio), '"' + c.folio + '"');
  ok('主按钮已退场', c.btnDrawHidden === true);
  console.log('       抽到：「' + c.answer + '」');

  /* ------------------------------------ D. 特殊条目按钮规则 */
  section('D. 特殊条目按钮规则');
  async function forceMode(text, mode) {
    await page.evaluate(([t, m]) => {
      window.App.current = { text: t, pageNo: 7, mode: m };
      window.Book.setState('showing');
      window.App.syncButtons();
    }, [text, mode]);
    await page.waitForTimeout(420);
    return page.evaluate(() => ({
      redraw: !document.getElementById('btnRedraw').classList.contains('is-hidden'),
      copy: !document.getElementById('btnCopy').classList.contains('is-hidden'),
      draw: !document.getElementById('btnDraw').classList.contains('is-hidden')
    }));
  }

  const d1 = await forceMode('抽到这条，请再抽一次。', 'redrawOnly');
  ok('「再抽一次」条目：只有「再抽一次」',
     d1.redraw && !d1.copy && !d1.draw, JSON.stringify(d1));

  const d2 = await forceMode('抽到这条，说明再抽一次也没用。', 'copyOnly');
  ok('「也没用」条目：只有「复制结果」',
     !d2.redraw && d2.copy && !d2.draw, JSON.stringify(d2));

  const d3 = await forceMode('相信自己！', 'normal');
  ok('普通条目：两个按钮都在', d3.redraw && d3.copy, JSON.stringify(d3));

  section('E. 复制结果');
  await page.click('#btnCopy');
  await page.waitForTimeout(500);
  const e = await page.evaluate(async () => {
    let clip = '';
    try { clip = await navigator.clipboard.readText(); } catch (err) { clip = 'READ_FAIL'; }
    return {
      clip,
      toastOn: document.getElementById('toast').classList.contains('is-on')
    };
  });
  ok('剪贴板拿到答案', e.clip === '相信自己！', '"' + e.clip + '"');
  ok('Toast 已弹出', e.toastOn === true);

  section('F. 布局');
  const f = await page.evaluate(() => {
    const bk = document.getElementById('book').getBoundingClientRect();
    const cs = getComputedStyle(document.getElementById('book'));
    return {
      /*
       * 两套比例要分开看：
       *  · 布局比例取自 computed style，与 transform 无关，应精确等于 1.58
       *  · 投影比例取自 getBoundingClientRect，是 3D 投影后的包围盒，
       *    受 rotateX(7deg) 与透视影响，天然略大于布局比例（约 1.60）
       * 之前只测投影比例、容差 0.05，数值一贴近边界就会误判，故拆开。
       */
      layoutRatio: +(parseFloat(cs.width) / parseFloat(cs.height)).toFixed(3),
      projRatio: +(bk.width / bk.height).toFixed(3),
      bottom: Math.round(bk.bottom),
      left: Math.round(bk.left),
      vw: window.innerWidth,
      vh: window.innerHeight,
      scrollH: document.documentElement.scrollHeight
    };
  });
  ok('书体布局宽高比 = 1.58', Math.abs(f.layoutRatio - 1.58) < 0.005, '实际 ' + f.layoutRatio);
  ok('书体投影宽高比 ≈ 1.58（含 3D 投影误差）',
    Math.abs(f.projRatio - 1.58) < 0.05, '实际 ' + f.projRatio);
  ok('页面无纵向滚动', f.scrollH <= f.vh + 1, f.scrollH + ' / ' + f.vh);
  ok('书体未超出视口底部', f.bottom <= f.vh + 1, f.bottom + ' / ' + f.vh);
  ok('书体左侧未被裁切', f.left >= 0, 'left=' + f.left);

  section('F2. 视口自适应撑满');

  /* 书体不再写死尺寸，改由 fit.js 按视口算，把真源钉在 documentElement 上 */
  const f2a = await page.evaluate(() => ({
    inline: document.documentElement.style.getPropertyValue('--book-h'),
    appW: document.documentElement.style.getPropertyValue('--app-w'),
    last: window.Fit && window.Fit.last ? window.Fit.last() : null
  }));
  ok('--book-h 由 JS 内联写入 documentElement',
    /^\d+(\.\d+)?px$/.test(f2a.inline.trim()), '"' + f2a.inline.trim() + '"');
  ok('--app-w 由 JS 反推（与书宽对齐）',
    /^\d+(\.\d+)?px$/.test(f2a.appW.trim()), '"' + f2a.appW.trim() + '"');

  /*
   * 撑满程度：取几个典型桌面视口，要求书体高度占比不低于 65%。
   * 这个下限同时是「防回退」闸门 —— 只要有人把 --book-h 改回固定值，
   * 或者去掉预留逻辑导致书体被压小，这里立刻报红。
   */
  const FILL_VIEWPORTS = [[1400, 940], [1600, 1000], [1920, 1080], [1080, 620]];
  for (const [w, h] of FILL_VIEWPORTS) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(1500);

    const r = await page.evaluate(() => {
      const bk = document.getElementById('book').getBoundingClientRect();
      const cs = getComputedStyle(document.getElementById('book'));
      return {
        vw: innerWidth, vh: innerHeight,
        bookH: parseFloat(cs.height),
        bookW: parseFloat(cs.width),
        top: bk.top,
        slack: bk.top,       /* 书体上沿到屏幕顶的距离，即留给叶片上顶的空间 */
        bottom: innerHeight - bk.bottom,
        appW: document.querySelector('.app').getBoundingClientRect().width,
        scrollH: document.documentElement.scrollHeight
      };
    });

    const pctH = r.bookH / r.vh;
    const pctW = r.bookW / r.vw;
    /*
     * 叶片上顶的真实比例，独立于 fit.js 里的 K_WIDE（那个含 10% 安全余量）。
     * 这里用实测值，才是对物理约束本身的校验；改透视或倾角后需重测，
     * 方法见 .shots/measure_overshoot.js。
     */
    const need = K_OVERSHOOT_TRUE * r.bookH;

    ok(w + 'x' + h + '：书体高度撑满（≥65%）',
      pctH >= 0.65, (pctH * 100).toFixed(0) + '% （' + Math.round(r.bookH) + 'px）');
    ok(w + 'x' + h + '：顶部预留到位（≥ 叶片上顶量）',
      r.slack >= need - 1,
      '留白 ' + Math.round(r.slack) + 'px ≥ 需要 ' + Math.round(need) + 'px');
    ok(w + 'x' + h + '：书体未超出视口底部',
      r.bottom >= -1, '下留白 ' + Math.round(r.bottom) + 'px');
    ok(w + 'x' + h + '：容器未溢出、页面无滚动',
      r.scrollH <= r.vh + 1 && r.appW <= r.vw + 1,
      'app ' + Math.round(r.appW) + ' / vw ' + r.vw + '，scrollH ' + r.scrollH);
  }

  /* 关键回归：翻页全程叶片不得被屏幕顶边切平 */
  await page.setViewportSize({ width: 1400, height: 940 });
  await page.waitForTimeout(1500);
  const f2b = await page.evaluate(() => new Promise(resolve => {
    const book = document.getElementById('book');
    let minTop = Infinity, minLeft = Infinity, maxRight = -Infinity;
    const t0 = performance.now();
    const vw = innerWidth;
    (function tick() {
      const leaf = document.querySelector('.leaf');
      if (leaf) {
        const r = leaf.getBoundingClientRect();
        if (r.width > 0.5 && r.height > 0.5) {
          minTop = Math.min(minTop, r.top);
          minLeft = Math.min(minLeft, r.left);
          maxRight = Math.max(maxRight, r.right);
        }
      }
      if (performance.now() - t0 < 2600) requestAnimationFrame(tick);
      else resolve({ minTop, minLeft, maxRight, vw });
    })();
    document.getElementById('btnRedraw').click();
  }));
  ok('翻页全程叶片不越出视口上边（这是书体撑满后的主要风险）',
    f2b.minTop >= -1, '叶片最高点 y=' + Math.round(f2b.minTop));
  ok('翻页全程叶片不越出视口左右',
    f2b.minLeft >= -1 && f2b.maxRight <= f2b.vw + 1,
    'left=' + Math.round(f2b.minLeft) + ' right=' + Math.round(f2b.maxRight));

  /*
   * 首屏不得有横向滑动。
   * 闭合态的 transform 是 rotateX(7deg) translateX(-半页宽/2)，与 --book-h 挂钩，
   * 而 .book 上挂着 1100ms 的 transform 过渡（开合动画用）。若不临时关掉它，
   * 定尺寸时会把 transform 也做成动画 —— 实测封面会自己横向滑 53px。
   */
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.waitForTimeout(300);
  const f2c = await page.evaluate(() => new Promise(resolve => {
    const xs = [];
    let n = 0;
    (function tick() {
      const c = document.getElementById('cover');
      if (c) xs.push(c.getBoundingClientRect().left);
      if (++n < 90) requestAnimationFrame(tick);
      else resolve({ min: Math.min(...xs), max: Math.max(...xs) });
    })();
    window.Fit.apply();   /* 模拟尺寸重算（resize 时会发生） */
  }));
  ok('尺寸重算不引发封面横向滑动',
    f2c.max - f2c.min <= 1, '漂移 ' + (f2c.max - f2c.min).toFixed(1) + 'px');


  section('G. 窄屏（430x900）');
  await page.setViewportSize({ width: 430, height: 900 });
  await page.waitForTimeout(700);
  const g = await page.evaluate(() => {
    const bk = document.getElementById('book').getBoundingClientRect();
    const cov = getComputedStyle(document.getElementById('cover'));
    return {
      leftHidden: getComputedStyle(document.getElementById('halfLeft')).display === 'none',
      coverHidden: cov.visibility === 'hidden',
      scrollH: document.documentElement.scrollHeight,
      vh: window.innerHeight,
      hintText: document.getElementById('footHint').textContent,
      bookW: Math.round(bk.width)
    };
  });
  ok('左页已隐藏（单页模式）', g.leftHidden === true);
  ok('封面翻开后不残留在左缘', g.coverHidden === true);
  ok('窄屏无纵向滚动', g.scrollH <= g.vh + 1, g.scrollH + ' / ' + g.vh);
  ok('页脚提示改为窄屏合书入口', /轻触此处合上/.test(g.hintText), '"' + g.hintText + '"');
  await page.setViewportSize({ width: 1500, height: 940 });
  await page.waitForTimeout(400);

  section('H. file:// 回落路径');
  const page2 = await ctx.newPage();
  await page2.goto(FILE_URL, { waitUntil: 'load' });
  await page2.waitForTimeout(1200);
  const h = await page2.evaluate(() => ({
    count: window.AnswersSource.list.length,
    source: window.AnswersSource.source,
    hasInline: !!(window.ANSWERS && window.ANSWERS.length)
  }));
  ok('回落为 inline 数据', h.source === 'inline', '实际 ' + h.source);
  ok('回落数据条数一致', h.count === a.count, h.count + ' vs ' + a.count);
  ok('answers.js 提供内联数据', h.hasInline === true);
  await page2.close();

  /* --------------------------------- E2. 翻页机制与 DOM 压测 */
  section('I. 翻页机制');
  const i1 = await page.evaluate(() => {
    const leaf = document.createElement('div');
    leaf.className = 'leaf';
    leaf.style.setProperty('--dur', '1234ms');
    document.getElementById('leafLayer').appendChild(leaf);
    leaf.classList.add('is-flipping');
    const cs = getComputedStyle(leaf);
    const out = { dur: cs.animationDuration, name: cs.animationName };
    leaf.remove();
    return out;
  });
  ok('CSS 变量 --dur 被读到', i1.dur === '1.234s', '实际 ' + i1.dur);
  ok('动画名正确', i1.name === 'leafFlip', i1.name);

  const i2 = await page.evaluate(async () => {
    const t0 = performance.now();
    await window.Book.flip({
      front: window.Book.nextFakePage(),
      back: window.Book.nextFakePage(),
      under: window.Book.nextFakePage(),
      dur: 500
    });
    return {
      elapsed: Math.round(performance.now() - t0),
      leafCount: document.querySelectorAll('.leaf').length,
      leftFilled: document.getElementById('pageLeft').innerHTML.length > 0
    };
  });
  ok('翻页时长符合预期（500ms 内）', i2.elapsed >= 480 && i2.elapsed < 700,
     '实际 ' + i2.elapsed + 'ms');
  ok('动画结束后叶片已清理', i2.leafCount === 0, i2.leafCount + ' 个残留');
  ok('左页接管叶片背面内容', i2.leftFilled === true);

  const i3 = await page.evaluate(async () => {
    for (let i = 0; i < 30; i++) {
      await window.Book.flip({
        front: window.Book.nextFakePage(),
        back: window.Book.nextFakePage(),
        under: window.Book.nextFakePage(),
        dur: 40
      });
    }
    return {
      leafCount: document.querySelectorAll('.leaf').length,
      children: document.getElementById('leafLayer').childElementCount
    };
  });
  ok('连翻 30 次 DOM 零累积',
     i3.leafCount === 0 && i3.children === 0, JSON.stringify(i3));

  /* -------------------------------- I2. 浮现动画的布局稳定性（静态防线） */
  section('I2. 浮现动画不得改动文字宽度');

  /* 回归背景：inkReveal 曾动画化 letter-spacing，导致文字宽度在动画期间变化，
     跨过换行阈值时行数 1↔2 翻转、文字上下抖动。此处静态扫描关键帧，
     禁止出现任何会改变文字宽度的属性。注释先剥离，避免读到自己写的警示文字。 */
  const animCss = fs.readFileSync(path.join(ROOT, 'css', 'anim.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const kfStart = animCss.indexOf('@keyframes inkReveal');
  const kfEnd = animCss.indexOf('@keyframes', kfStart + 10);
  const inkBlock = animCss.slice(kfStart, kfEnd > 0 ? kfEnd : undefined);

  const forbidden = ['letter-spacing', 'font-size', 'word-spacing',
                     'width', 'padding', 'margin', 'line-height'];
  const hits = forbidden.filter(p => inkBlock.includes(p));
  ok('inkReveal 未动画化改布局的属性', hits.length === 0,
     hits.length ? '发现：' + hits.join(', ') : '只含 opacity / filter / transform');

  /* 动态复核：对全部条目逐帧采样，行数必须全程恒定 */
  const answersTxt = fs.readFileSync(path.join(ROOT, 'answers.txt'), 'utf8')
    .split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  const unstable = await page.evaluate(async (list) => {
    const bad = [];
    for (const text of list) {
      const pg = document.getElementById('pageRight');
      pg.innerHTML = window.Book.buildAnswerPage(text);
      const el = pg.querySelector('.answer-text');
      await new Promise(r => requestAnimationFrame(r));
      const lh = parseFloat(getComputedStyle(el).lineHeight);
      const seen = new Set();
      el.classList.add('is-revealing');
      const t0 = performance.now();
      await new Promise(resolve => {
        (function tick() {
          seen.add(Math.round(el.getBoundingClientRect().height / lh));
          if (performance.now() - t0 < 900) requestAnimationFrame(tick);
          else resolve();
        })();
      });
      el.classList.remove('is-revealing');
      if (seen.size > 1) bad.push(text + ' 行数' + JSON.stringify([...seen]));
    }
    return bad;
  }, answersTxt);
  ok('全部条目浮现过程行数恒定（无抖动）', unstable.length === 0,
     unstable.length ? unstable.join(' | ') : answersTxt.length + ' 条全部稳定');

  /* -------------------- K. 开合动效：左半页不得凭空显形（幽灵页） -------------------- */
  section('K. 开合动效：左半页不得凭空显形');

  /* 「幽灵页」= 封面已经遮不住左半区、左半页却仍可见时，左缘冒出的那条白/灰书页。
     量化指标 ghost = 左区未被封面遮住的比例 × 左半页不透明度。
     用 getAnimations() 暂停并逐帧拖拽，取精确时间点的真实状态 ——
     普通按时间截图会因截图耗时严重失真（实测 50% 时刻已翻到 180°）。 */
  async function ghostProfile(action) {
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(900);
    if (action === 'close') {
      await page.click('#cover');
      await page.waitForTimeout(1800);
    }

    const prof = await page.evaluate(async (act) => {
      if (act === 'open') window.App.openBook(); else window.App.closeBook();
      await new Promise(r => setTimeout(r, 40));

      const anims = document.getAnimations();
      anims.forEach(a => a.pause());

      const cover = document.getElementById('cover');
      const half = document.getElementById('halfLeft');
      const out = [];

      for (let t = 0; t <= 1100; t += 25) {
        anims.forEach(a => { a.currentTime = t; });
        await new Promise(r => setTimeout(r, 8));

        const m = new DOMMatrix(getComputedStyle(cover).transform);
        const deg = Math.abs(Math.atan2(m.m13, m.m11) * 180 / Math.PI);
        const op = parseFloat(getComputedStyle(half).opacity);
        const covered = Math.min(Math.abs(Math.cos(deg * Math.PI / 180)), 1);
        const exposed = deg > 90 ? 1 - covered : 1;
        out.push({
          t: t,
          deg: Math.round(deg),
          op: +op.toFixed(3),
          ghost: +(exposed * op * 100).toFixed(1)
        });
      }

      anims.forEach(a => { a.play(); });
      return out;
    }, action);

    await page.waitForTimeout(1500);
    return prof;
  }

  const openProf = await ghostProfile('open');
  const openPeak = openProf.reduce((a, b) => (b.ghost > a.ghost ? b : a));
  ok('翻开：无幽灵页', openPeak.ghost <= 5,
     '峰值 ' + openPeak.ghost + '% @' + openPeak.t + 'ms（封面 ' + openPeak.deg +
     '°，左页 opacity ' + openPeak.op + '）');

  const closeProf = await ghostProfile('close');
  const closePeak = closeProf.reduce((a, b) => (b.ghost > a.ghost ? b : a));
  ok('合上：无幽灵页', closePeak.ghost <= 5,
     '峰值 ' + closePeak.ghost + '% @' + closePeak.t + 'ms（封面 ' + closePeak.deg +
     '°，左页 opacity ' + closePeak.op + '）');

  /* 时序必须严格：封面遮不住左半区时，左半页必须已经退场 */
  const closeBad = closeProf.filter(s => s.deg <= 120 && s.op > 0.02);
  ok('合上：封面转到 120° 前左半页已退场', closeBad.length === 0,
     closeBad.length ? closeBad.slice(0, 3).map(s =>
       s.t + 'ms 角度' + s.deg + ' op' + s.op).join(' | ') : '');

  const openBad = openProf.filter(s => s.deg <= 120 && s.op > 0.02);
  ok('翻开：封面转过 120° 前左半页不显形', openBad.length === 0,
     openBad.length ? openBad.slice(0, 3).map(s =>
       s.t + 'ms 角度' + s.deg + ' op' + s.op).join(' | ') : '');

  section('J. 控制台');
  const errs = msgs.filter(m => /^\[(error|pageerror)\]/.test(m))
    .filter(m => !/CORS|Failed to load resource|Access to fetch/i.test(m));
  ok('无 JS 运行时报错', errs.length === 0, errs.join(' | ').slice(0, 240));
  msgs.forEach(m => console.log('       ' + m.slice(0, 150)));

  /* ------------------------------------------------------ 汇总 */
  const failed = results.filter(r => !r.pass);
  console.log('\n========================================');
  console.log(failed.length === 0
    ? '全部通过：' + results.length + ' 项'
    : (results.length - failed.length) + ' 项通过，' + failed.length + ' 项失败');
  if (failed.length) failed.forEach(f2 => console.log('   失败：' + f2.name));
  console.log('========================================\n');

  await browser.close();
  if (server) server.close();
  process.exit(failed.length === 0 ? 0 : 1);
})().catch(e => {
  console.error('验证异常：', e);
  process.exit(2);
});
