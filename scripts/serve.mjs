#!/usr/bin/env node
/* ============================================================
   零依赖本地静态服务器
   ------------------------------------------------------------
   直接用 file:// 打开 index.html 是不行的：本项目用了 ES Module，
   浏览器会以 CORS 策略拦住 file:// 下的模块加载。所以本地预览
   必须走一个 HTTP 服务 —— 这也是这个脚本存在的唯一理由。
   ============================================================ */

import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, extname, sep, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || process.argv[2] || 5173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

const notFound = (res, msg) => {
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>404</title>
<body style="font:14px/1.7 system-ui;padding:48px;color:#333">
<h1 style="font-size:20px">404 Not Found</h1>
<p>${msg}</p>
<p><a href="/">回到首页</a></p></body></html>`);
};

const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  // 本地开发不要缓存，否则改了 CSS 看不到效果会浪费很多时间
  res.setHeader('Cache-Control', 'no-store');

  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }

  try {
    let pathname = decodeURIComponent(new URL(req.url, `http://${HOST}:${PORT}`).pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';

    // 点开头的路径一律拒绝：.git、.nojekyll 之类不该被读出来
    if (pathname.split('/').some((s) => s.startsWith('.') && s !== '')) {
      notFound(res, '该路径不可访问');
      return;
    }

    const requested = resolve(ROOT, `.${posix.normalize(pathname)}`);

    // 先 realpath 再比对前缀，把符号链接与 ../ 穿越一起挡住
    let file;
    try {
      file = await realpath(requested);
    } catch (_) {
      notFound(res, `找不到文件：${pathname}`);
      return;
    }

    const rootReal = await realpath(ROOT);
    if (file !== rootReal && !file.startsWith(rootReal + sep)) {
      notFound(res, '该路径不可访问');
      return;
    }

    const info = await stat(file);
    if (info.isDirectory()) {
      notFound(res, '这是一个目录');
      return;
    }

    const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('服务器内部错误：' + (err && err.message ? err.message : String(err)));
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Agent 机制可视化实验室');
  console.log(`  ────────────────────────────────────────`);
  console.log(`  本地地址   http://${HOST}:${PORT}/`);
  console.log('  停止服务   Ctrl + C');
  console.log('');
});
