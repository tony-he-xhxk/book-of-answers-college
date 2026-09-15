/*
 * reveal_probe.js —— 答案浮现动画的「抖动」探针（node tools/reveal_probe.js）
 *
 * 背景：inkReveal 原本动画了 letter-spacing（.3em → .04em），
 * 文字宽度在动画期间收缩约 26%。当某条答案的宽度刚好贴近容器宽度时，
 * 动画途中会跨过换行阈值，行数在 1↔2 之间反复翻转，
 * 再叠加 .page-face 的 flex 垂直居中，视觉上就是文字上下抖动。
 *
 * 本脚本逐帧（requestAnimationFrame）采样行数与宽度，输出：
 *   · 每条真实条目的行数变化集合 —— 集合大小 > 1 即为抖动
 *   · 长度 2..30 的合成样本，找出抖动的长度区间
 *
 * 用作回归：修完 anim.css 后重跑，所有条目应报告 STABLE。
 */
const fs = require('fs');
const path = require('path');

/* 本机相关的三件事全部收敛到 tools/_env.js，脚本里不出现绝对路径 */
const env = require('./_env');
const ROOT = env.ROOT;
const PORT = 8766;
const URL = 'http://127.0.0.1:' + PORT + '/index.html';

function findChrome() {
  return env.findChrome();
}

function alive() {
  return env.serverAlive(PORT, '/index.html');
}

async function ensureServer() {
  const { server } = await env.ensureServer(PORT, ROOT);
  return server;   /* 复用已有服务时为 null */
}

/* 在页面里跑一次 reveal，逐帧采样 */
const PROBE = async (text) => {
  const page = document.getElementById('pageRight');
  page.innerHTML = window.Book.buildAnswerPage(text);

  const el = page.querySelector('.answer-text');
  await new Promise(r => requestAnimationFrame(r));

  const lh = parseFloat(getComputedStyle(el).lineHeight);
  const boxW = page.clientWidth;
  const samples = [];

  el.classList.add('is-revealing');
  const t0 = performance.now();

  return await new Promise(resolve => {
    function tick() {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      samples.push({
        t: Math.round(performance.now() - t0),
        lines: Math.round(r.height / lh),
        w: +r.width.toFixed(1),
        ls: +parseFloat(cs.letterSpacing).toFixed(2)
      });
      if (performance.now() - t0 < 1000) requestAnimationFrame(tick);
      else resolve({ samples, boxW, lh: +lh.toFixed(1) });
    }
    requestAnimationFrame(tick);
  });
};

(async () => {
  const server = await ensureServer();

  const browser = await env.launch();
  const page = await browser.newPage({
    viewport: { width: 1400, height: 900 },
    deviceScaleFactor: 1
  });
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(900);

  await page.click('#cover');
  await page.waitForTimeout(1700);

  /* -------------------------------------------------- 1. 真实条目 */
  const answers = fs.readFileSync(path.join(ROOT, 'answers.txt'), 'utf8')
    .split(/\r?\n/).map(s => s.trim())
    .filter(s => s && !s.startsWith('#'));

  console.log('\n=== 1. 真实条目逐帧采样 ===');
  console.log('（行数种类 > 1 即为抖动）\n');

  let shaky = 0;
  const detail = [];

  for (const text of answers) {
    const r = await page.evaluate(PROBE, text);
    const lines = [...new Set(r.samples.map(s => s.lines))].sort();
    const widths = r.samples.map(s => s.w);
    const jitter = +(Math.max(...widths) - Math.min(...widths)).toFixed(1);
    const bad = lines.length > 1;
    if (bad) shaky++;

    const label = text.length > 18 ? text.slice(0, 18) + '…' : text;
    console.log(
      (bad ? '  [抖动!] ' : '  [稳定]  ') +
      label.padEnd(21) +
      ' 行数=' + JSON.stringify(lines).padEnd(10) +
      ' 宽度 ' + Math.min(...widths) + '→' + Math.max(...widths) +
      ' (差 ' + jitter + 'px)' +
      ' 容器 ' + r.boxW + 'px'
    );
    if (bad) detail.push({ text, lines, widths: [Math.min(...widths), Math.max(...widths)] });
  }

  /* -------------------------------------- 2. 合成样本：找长度区间 */
  console.log('\n=== 2. 合成样本（长度 2..30） ===');
  console.log('（扫描整个长度区间，确认修复对以后新增的条目同样有效）\n');

  const shakyLens = [];
  for (let n = 2; n <= 30; n++) {
    const text = '答'.repeat(n);
    const r = await page.evaluate(PROBE, text);
    const lines = [...new Set(r.samples.map(s => s.lines))].sort();
    const bad = lines.length > 1;
    if (bad) shakyLens.push(n);
    process.stdout.write(
      '  n=' + String(n).padStart(2) + '  行数=' + JSON.stringify(lines).padEnd(10) +
      (bad ? ' <<< 抖动' : '') + '\n'
    );
  }

  /* ------------------------------------------------ 3. 结论 */
  console.log('\n========================================');
  console.log('真实条目抖动：' + shaky + ' / ' + answers.length);
  if (detail.length) {
    detail.forEach(d => console.log('   · 「' + d.text + '」 行数 ' +
      JSON.stringify(d.lines) + '，宽度 ' + d.widths[0] + '→' + d.widths[1]));
  }
  console.log('合成样本抖动长度：' +
    (shakyLens.length ? shakyLens.join(', ') : '无'));
  console.log('========================================\n');

  await browser.close();
  if (server) server.close();
  process.exit(shaky === 0 && shakyLens.length === 0 ? 0 : 1);
})().catch(e => { console.error('探针异常：', e); process.exit(2); });
