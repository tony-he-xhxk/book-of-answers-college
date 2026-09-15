/*
 * selftest.js —— 抽取引擎自检（开发时用，不进网页运行时）
 *
 * 用 node 的 vm 把 draw.js 装进一个假 window 里，只测数据层：
 *   · 特殊条目分类规则是否正确、且顺序敏感
 *   · 洗牌袋一轮内是否真的不重复
 *   · 跨轮衔接处是否会出现相邻重复
 *   · 一轮是否恰好覆盖全部条目
 *
 * 运行：node tools/selftest.js
 * 加完新条目后跑一次，能立刻发现规则误判或去重失效。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.dirname(__dirname);

function loadDraw() {
  const sandbox = { console, Promise, setTimeout };
  sandbox.window = sandbox;
  sandbox.Book = {
    buildAnswerPage: () => '',
    nextFakePage: () => '',
    flip: () => Promise.resolve()
  };
  sandbox.SFX = { playFlip() {}, playLand() {}, playBreath() {} };
  sandbox.document = {
    getElementById: () => null,
    createElement: () => ({ classList: { add() {}, remove() {} }, style: {} })
  };
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'js', 'draw.js'), 'utf8'),
    sandbox,
    { filename: 'draw.js' }
  );
  return sandbox.Draw;
}

function loadAnswers() {
  const txt = fs.readFileSync(path.join(ROOT, 'answers.txt'), 'utf8');
  return txt.split(/\r?\n/)
    .map(s => s.trim())
    .filter(s => s && !s.startsWith('#'));
}

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log('  [OK]   ' + name);
  } else {
    fail++;
    console.log('  [FAIL] ' + name + (detail ? '  -> ' + detail : ''));
  }
}

const Draw = loadDraw();
const answers = loadAnswers();

console.log('\n=== 1. 特殊条目分类 ===');
const cases = [
  ['抽到这条，请再抽一次。',                'redrawOnly'],
  ['抽到这条，说明再抽一次也没用。',        'copyOnly'],
  ['相信自己！',                            'normal'],
  ['外卖点了吗？点了就别问。',              'normal'],
  ['再抽一次也没用',                        'copyOnly'],
  ['再抽一次',                              'redrawOnly']
];
cases.forEach(([text, want]) => {
  Draw.init([text]);
  const got = Draw.next().mode;
  check('「' + text + '」→ ' + want, got === want, '实际 ' + got);
});

console.log('\n=== 2. 洗牌袋：一轮内不重复 ===');
Draw.init(answers);
const round = [];
for (let i = 0; i < answers.length; i++) round.push(Draw.next().text);
check('抽取 ' + answers.length + ' 次无重复',
  new Set(round).size === answers.length,
  '去重后 ' + new Set(round).size + ' 条');
check('一轮恰好覆盖全部条目',
  answers.every(a => round.includes(a)),
  '未覆盖 ' + answers.filter(a => !round.includes(a)).length + ' 条');

console.log('\n=== 3. 连续 300 次：无相邻重复 ===');
Draw.init(answers);
let prev = null;
let adjDup = 0;
for (let i = 0; i < 300; i++) {
  const t = Draw.next().text;
  if (t === prev) adjDup++;
  prev = t;
}
check('无相邻重复', adjDup === 0, adjDup + ' 次相邻重复');

console.log('\n=== 4. 分布均匀性（300 次抽样） ===');
Draw.init(answers);
const freq = {};
for (let i = 0; i < 300; i++) {
  const t = Draw.next().text;
  freq[t] = (freq[t] || 0) + 1;
}
const counts = Object.values(freq);
const min = Math.min(...counts);
const max = Math.max(...counts);
console.log('      最少 ' + min + ' 次，最多 ' + max + ' 次（理想 ' +
            (300 / answers.length).toFixed(1) + '）');
check('每个条目都被抽到', counts.length === answers.length);

console.log('\n----------------------------------------');
console.log(fail === 0
  ? '全部通过：' + pass + ' 项'
  : pass + ' 项通过，' + fail + ' 项失败');
console.log('----------------------------------------\n');

process.exit(fail === 0 ? 0 : 1);
