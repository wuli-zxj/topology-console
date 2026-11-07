/**
 * 零依赖开发服务器：托管静态前端 + 把 /api/* 反向代理到后端。
 * 这样前端与接口同源，不需要改后端 CORS 配置。
 *
 *   node server.mjs
 *   PORT=5173 BACKEND=http://127.0.0.1:8080 node server.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5173);
const BACKEND = (process.env.BACKEND || 'http://127.0.0.1:8080').replace(/\/$/, '');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png'
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

function json(res, status, obj) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/** 代理任意 /api 请求到后端，原样透传 method / query / body / 响应。 */
async function proxy(req, res, url) {
  const started = Date.now();
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  const headers = {};
  if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
  if (req.headers.authorization) headers.Authorization = req.headers.authorization;

  try {
    const upstream = await fetch(BACKEND + url.pathname + url.search, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
      signal: AbortSignal.timeout(30000)
    });
    const text = await upstream.text();
    cors(res);
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'X-Proxy-Backend': BACKEND,
      'X-Proxy-Ms': String(Date.now() - started)
    });
    res.end(text);
  } catch (err) {
    json(res, 502, {
      code: 502,
      message: '无法连接后端 ' + BACKEND + '：' + err.message,
      hint: '请确认 Spring Boot 服务已启动，或用 BACKEND 环境变量指定地址'
    });
  }
}

/** 前端状态灯使用：探测后端是否在线。 */
async function health(res) {
  try {
    const r = await fetch(BACKEND + '/v3/api-docs', { signal: AbortSignal.timeout(4000) });
    const doc = r.ok ? await r.json() : null;
    json(res, 200, {
      online: !!doc,
      backend: BACKEND,
      title: doc?.info?.title || null,
      paths: doc ? Object.keys(doc.paths || {}).length : 0
    });
  } catch (err) {
    json(res, 200, { online: false, backend: BACKEND, error: err.message });
  }
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'index.html')) {
    return json(res, 403, { message: 'Forbidden' });
  }
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { message: 'Not found: ' + pathname });
    cors(res);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
  if (url.pathname === '/__health') return health(res);
  if (url.pathname === '/__config') return json(res, 200, { backend: BACKEND, port: PORT });
  if (url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/v3/')) return proxy(req, res, url);
  serveStatic(res, url.pathname);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[topology-console] http://localhost:${PORT}`);
  console.log(`[topology-console] 代理 /api/* -> ${BACKEND}`);
});
