/*
 * serve.js —— 起一个本地静态服务器，用于本地预览（node tools/serve.js）
 *
 * 为什么本地预览要用服务器而不是双击 index.html：
 * 双击打开走的是 file:// 协议，浏览器会以 CORS 为由拦掉 fetch('answers.txt')，
 * 页面只能回落到 js/answers.js 这份编译产物 —— 改了 answers.txt 不重新编译就看不到。
 * 走本地服务器则直接读 answers.txt 最新内容，改完刷新即可。
 *
 * 用法：
 *     双击 serve.bat        （推荐，会自动打开浏览器）
 *     或 node tools/serve.js [端口] [--no-open]
 *
 * --no-open 只起服务、不打开浏览器（脚本化调用或远程环境用）。
 */
'use strict';

const { spawn } = require('child_process');
const env = require('./_env');

const args = process.argv.slice(2);
const noOpen = args.includes('--no-open');
const PORT = Number(args.find(a => /^\d+$/.test(a))) || 8765;
const URL = 'http://127.0.0.1:' + PORT + '/';

/* 尽力打开系统默认浏览器；打不开也不影响服务本身 */
function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd'
            : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
    return true;
  } catch (e) {
    return false;
  }
}

(async () => {
  try {
    await env.ensureServer(PORT, env.ROOT);
  } catch (e) {
    console.error('[ERR] 端口 ' + PORT + ' 启动失败：' + e.message);
    console.error('      换个端口试试：node tools/serve.js 8770');
    process.exit(1);
  }

  console.log('');
  console.log('  答案之书 · 本地预览');
  console.log('  ----------------------------------------');
  console.log('  地址：  ' + URL);
  console.log('  数据源：answers.txt（改了刷新即可，无需重新编译）');
  console.log('');
  console.log('  按 Ctrl+C 停止');
  console.log('');

  if (!noOpen) openBrowser(URL);
})().catch(e => {
  console.error('[ERR] ' + e.message);
  process.exit(1);
});
