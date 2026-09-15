/*
 * _env.js —— 测试脚本的本机环境解析（供 tools/ 与 .shots/ 共用）
 *
 * 为什么要有这个文件：
 * 三个测试脚本原先各自写死了本机绝对路径 —— playwright-core 的安装位置、
 * Python 解释器的完整路径、agent-browser 下载的 Chromium 位置。这些路径里
 * 带用户名，既泄露本机信息，也让别人 clone 下来根本跑不起来。
 *
 * 这里把「在不同机器上会不一样的东西」集中成三件事，逐一做成分级查找：
 *
 *   1. playwright-core 模块    —— 常规 require → 环境变量 → 常见安装位置
 *   2. Chromium 可执行文件      —— 环境变量 → 各下载器目录 → 系统 Chrome/Edge
 *   3. 静态服务器              —— 改用 Node 自带的 http 实现，不再依赖 Python
 *
 * 第 3 点顺手把 Python 依赖整个去掉了：以前要 spawn 一个
 * `python -m http.server`，既要猜解释器路径，又平白多一层跨进程管理。
 * 静态服务本来二十行就能写完，跑在同一个进程里还更好收拾。
 *
 * 分级查找而不是单一常量：换台机器、换个浏览器版本、甚至以后改用 pip 装的
 * playwright，都不需要回来改代码。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

/* 项目根目录（本文件在 tools/ 下） */
const ROOT = path.dirname(__dirname);

/* ------------------------------------------------------------ 1. playwright */

/*
 * 优先常规 require：在项目里 `npm install` 后即可命中，
 * 这也是给别人用时的推荐姿势（见 package.json 的 devDependencies）。
 */
function loadPlaywright() {
  const tried = [];

  try {
    return require('playwright-core');
  } catch (e) {
    tried.push('require("playwright-core")');
  }

  /* 环境变量指定模块目录：适合模块装在项目外的情况 */
  const envPath = process.env.PLAYWRIGHT_CORE_PATH;
  if (envPath) {
    try {
      return require(envPath);
    } catch (e) {
      tried.push('PLAYWRIGHT_CORE_PATH=' + envPath);
    }
  }

  /* NODE_PATH 里逐个试（Node 对裸标识符本就会查它，这里兜一层更明确） */
  for (const dir of String(process.env.NODE_PATH || '').split(path.delimiter)) {
    if (!dir.trim()) continue;
    try {
      return require(path.join(dir.trim(), 'playwright-core'));
    } catch (e) {
      tried.push('NODE_PATH: ' + dir);
    }
  }

  /* 最后试几个常见位置 */
  const guesses = [
    path.join(ROOT, 'node_modules', 'playwright-core'),
    path.join(process.cwd(), 'node_modules', 'playwright-core'),
    path.join(os.homedir(), 'node_modules', 'playwright-core')
  ];
  for (const g of guesses) {
    try {
      return require(g);
    } catch (e) {
      tried.push(g);
    }
  }

  throw new Error(
    '找不到 playwright-core。请任选一种方式：\n' +
    '  · 在项目根目录执行  npm install          （推荐）\n' +
    '  · 或用环境变量指定：PLAYWRIGHT_CORE_PATH=<模块目录>\n' +
    '  · 或把它所在目录加进 NODE_PATH\n' +
    '已尝试：\n  ' + tried.join('\n  ')
  );
}

/* -------------------------------------------------------------- 2. Chromium */

/*
 * 逐个候选位置探测，返回第一个真实存在的可执行文件。
 * 顺序：显式指定 > 各下载器目录 > 系统自带浏览器。
 */
function findChrome() {
  const cands = [];

  /* (a) 显式指定 —— 用户自己最清楚装在哪 */
  if (process.env.CHROME_PATH) cands.push(process.env.CHROME_PATH);

  /* (b) agent-browser 的下载目录（目录名带版本号，需遍历） */
  const abBase = path.join(os.homedir(), '.agent-browser', 'browsers');
  if (fs.existsSync(abBase)) {
    for (const d of safeReaddir(abBase)) {
      cands.push(path.join(abBase, d, 'chrome.exe'));
      cands.push(path.join(abBase, d, 'chrome'));       /* macOS / Linux */
      cands.push(path.join(abBase, d, 'chrome-linux', 'chrome'));
      cands.push(path.join(abBase, d, 'chrome-mac', 'Chromium.app',
                           'Contents', 'MacOS', 'Chromium'));
    }
  }

  /* (c) Playwright 官方浏览器缓存 */
  const pwBase = [
    path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright'),
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'ms-playwright')
  ];
  for (const base of pwBase) {
    if (!fs.existsSync(base)) continue;
    for (const d of safeReaddir(base)) {
      cands.push(path.join(base, d, 'chrome-win', 'chrome.exe'));
      cands.push(path.join(base, d, 'chrome-linux', 'chrome'));
      cands.push(path.join(base, d, 'chrome-mac', 'Chromium.app',
                           'Contents', 'MacOS', 'Chromium'));
    }
  }

  /* (d) 系统已装的 Chrome / Edge —— 没装过 Playwright 也能跑起来 */
  if (process.platform === 'win32') {
    const pf = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'],
                process.env['LOCALAPPDATA']];
    for (const p of pf) {
      if (!p) continue;
      cands.push(path.join(p, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      cands.push(path.join(p, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    cands.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    cands.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    cands.push('/usr/bin/google-chrome', '/usr/bin/chromium',
               '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge');
  }

  for (const c of cands) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch (e) { /* 忽略无权限的项 */ }
  }
  return null;
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (e) {
    return [];
  }
}

/*
 * 启动浏览器。找不到可执行文件时，退一步让 Playwright 按 channel 自己找
 * 系统里装的 Chrome / Edge；再不行才报错并给出可操作的提示。
 */
async function launch(opts) {
  const pw = loadPlaywright();
  const chrome = findChrome();
  const opt = Object.assign({ headless: true }, opts || {});

  if (chrome) {
    return pw.chromium.launch(Object.assign({}, opt, { executablePath: chrome }));
  }

  for (const channel of ['chrome', 'msedge']) {
    try {
      return await pw.chromium.launch(Object.assign({}, opt, { channel }));
    } catch (e) { /* 试下一个 */ }
  }

  throw new Error(
    '找不到可用的 Chromium / Chrome / Edge。请任选一种方式：\n' +
    '  · npx playwright install chromium\n' +
    '  · 或用环境变量指定：CHROME_PATH=<浏览器可执行文件的完整路径>'
  );
}

/* ------------------------------------------------------- 3. 静态服务器（Node） */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

/*
 * 起一个只读静态服务器，绑定回环地址。返回 server 对象（自带 .close()）。
 *
 * 只服务 ROOT 之内的文件：把解析后的路径与 ROOT 比对，挡住 `../` 穿越。
 * 测试用的小服务，不需要也不该有写能力。
 */
function startServer(port, root) {
  const base = root || ROOT;

  const server = http.createServer((req, res) => {
    let rel;
    try {
      rel = decodeURIComponent(req.url.split('?')[0]);
    } catch (e) {
      res.writeHead(400); res.end('bad request'); return;
    }
    if (rel === '/' || rel === '') rel = '/index.html';

    const file = path.resolve(base, rel.replace(/^[/\\]+/, ''));
    if (file !== base && !file.startsWith(base + path.sep)) {
      res.writeHead(403); res.end('forbidden'); return;
    }

    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store'   /* 测试要拿到最新文件，禁止缓存 */
      });
      res.end(data);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/* 探测端口上是否已有服务在跑（复用别人起的服务，不重复占用端口） */
function serverAlive(port, pathname) {
  const p = pathname || '/index.html';
  return new Promise(resolve => {
    const req = http.get('http://127.0.0.1:' + port + p, res => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1200, () => { req.destroy(); resolve(false); });
  });
}

/*
 * 确保端口上有可用的静态服务。已有则复用并返回 { server: null }，
 * 自己起的则返回 { server }，调用方收尾时 close() 掉。
 */
async function ensureServer(port, root) {
  if (await serverAlive(port)) return { server: null, reused: true };

  const server = await startServer(port, root);
  for (let i = 0; i < 25; i++) {
    if (await serverAlive(port)) return { server, reused: false };
    await new Promise(r => setTimeout(r, 200));
  }
  server.close();
  throw new Error('本地服务器启动失败（端口 ' + port + '）');
}

module.exports = {
  ROOT,
  loadPlaywright,
  findChrome,
  launch,
  startServer,
  serverAlive,
  ensureServer,
  MIME
};
