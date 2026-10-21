// Local / container server: serves web/ and passes /api/* to the shared API.
// On Netlify, netlify/functions/api.mjs uses the same API instead.
import http from 'node:http';
import zlib from 'node:zlib';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { createApi } from './app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(__dirname, '..', 'web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const store = createStore();
const api = createApi(store);

function send(req, res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const gzip = buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const out = gzip ? zlib.gzipSync(buf) : buf;
  res.writeHead(status, { ...headers, 'content-length': out.length, ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
  res.end(out);
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(WEB, rel));
  const target = file.startsWith(WEB) ? file : path.join(WEB, 'index.html');
  try {
    return send(req, res, 200, await fs.readFile(target), { 'content-type': TYPES[path.extname(target)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  } catch {
    return send(req, res, 200, await fs.readFile(path.join(WEB, 'index.html')), { 'content-type': TYPES['.html'], 'cache-control': 'no-cache' });
  }
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(new URL(req.url, `http://${req.headers.host || 'localhost'}`), {
      method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks)
    });
    const response = await api.handle(request);
    const headers = Object.fromEntries(response.headers.entries());
    return send(req, res, response.status, Buffer.from(await response.arrayBuffer()), headers);
  }
  if (req.method !== 'GET') return send(req, res, 405, 'Method not allowed', { 'content-type': 'text/plain' });
  return serveStatic(req, res, url.pathname);
}

const port = Number(process.env.PORT) || 3000;
store.init()
  .then(() => {
    http.createServer((req, res) => {
      handle(req, res).catch((e) => {
        console.error(e);
        if (!res.headersSent) send(req, res, 500, JSON.stringify({ error: e.message }), { 'content-type': 'application/json' });
      });
    }).listen(port, () => console.log(`Khoj control room on :${port} (store: ${store.kind})`));
  })
  .catch((e) => { console.error('Failed to start', e); process.exit(1); });
