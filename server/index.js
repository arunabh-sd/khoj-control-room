import http from 'node:http';
import zlib from 'node:zlib';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadSources } from './sources.js';
import { compute } from './engine.js';
import { createStore } from './store.js';
import { DEFAULT_SETTINGS, SETTING_LABELS, mergeSettings } from './rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(__dirname, '..', 'web');
const TTL_MS = (Number(process.env.CACHE_TTL_MIN) || 30) * 60 * 1000;
const PASSWORD = process.env.DASHBOARD_PASSWORD || '';

const store = createStore();
let cache = null;
let loading = null;

async function getSources(force) {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.sources;
  if (!loading) {
    loading = loadSources()
      .then((sources) => { cache = { sources, at: Date.now() }; return sources; })
      .finally(() => { loading = null; });
  }
  return loading;
}

export async function buildState(force) {
  const sources = await getSources(force);
  const settings = mergeSettings(await store.getSettings());
  const history = await store.listDecisions();
  const result = compute(sources, settings, history);
  await store.recordDecisions(result.decisions);
  await store.upsertTasks(result.tasks);

  const generated = new Set(result.tasks.map((t) => t.id));
  const healthy = ['products', 'ads', 'catalog'].every((k) => sources[k].status !== 'error');
  if (healthy) {
    const open = (await store.listTasks()).filter((t) => !t.done_at && !generated.has(t.id)).map((t) => t.id);
    await store.autoClose(open);
  }
  const tasks = (await store.listTasks()).filter((t) => generated.has(t.id) || t.done_at);
  const log = (await store.listDecisions()).slice(0, 300);

  const { decisions, ...view } = result;
  return {
    meta: {
      loadedAt: sources.loadedAt,
      store: store.kind,
      sources: Object.fromEntries(['products', 'ads', 'catalog'].map((k) => [k, {
        status: sources[k].status, origin: sources[k].origin, rows: sources[k].rows.length, error: sources[k].error || null
      }]))
    },
    settings, settingLabels: SETTING_LABELS, defaults: DEFAULT_SETTINGS,
    ...view,
    tasks: tasks.map((t) => ({
      id: t.id, segment: t.segment, category: t.category, title: t.title, detail: t.detail,
      due: typeof t.due === 'string' ? t.due.slice(0, 10) : t.due, done: !!t.done_at, auto: !!t.auto
    })),
    log
  };
}

// ---------- tiny HTTP layer ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function send(req, res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const gzip = buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const out = gzip ? zlib.gzipSync(buf) : buf;
  res.writeHead(status, { 'content-type': type, 'content-length': out.length, ...(gzip ? { 'content-encoding': 'gzip' } : {}), ...extra });
  res.end(out);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) { size += c.length; if (size > 100_000) throw new Error('Body too large'); chunks.push(c); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function authorised(req) {
  if (!PASSWORD) return true;
  const [scheme, encoded] = String(req.headers.authorization || '').split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  return Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':') === PASSWORD;
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(WEB, rel));
  if (!file.startsWith(WEB)) return send(req, res, 404, 'Not found', 'text/plain');
  try {
    const body = await fs.readFile(file);
    return send(req, res, 200, body, TYPES[path.extname(file)] || 'application/octet-stream', { 'cache-control': 'no-cache' });
  } catch {
    const body = await fs.readFile(path.join(WEB, 'index.html'));
    return send(req, res, 200, body, TYPES['.html'], { 'cache-control': 'no-cache' });
  }
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/healthz') return send(req, res, 200, { ok: true });
  if (!authorised(req)) return send(req, res, 401, 'Password required', 'text/plain', { 'www-authenticate': 'Basic realm="Khoj Control Room"' });

  if (p === '/api/state' && req.method === 'GET') return send(req, res, 200, await buildState(url.searchParams.get('refresh') === '1'));

  const taskMatch = p.match(/^\/api\/tasks\/(.+)$/);
  if (taskMatch && req.method === 'POST') {
    const body = await readJson(req);
    const ok = await store.setTaskDone(decodeURIComponent(taskMatch[1]), !!body.done);
    return send(req, res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Task not found' });
  }

  if (p === '/api/settings' && req.method === 'PUT') {
    const incoming = await readJson(req);
    const merged = mergeSettings(incoming);
    const toSave = {};
    for (const k of Object.keys(incoming)) if (k in DEFAULT_SETTINGS) toSave[k] = merged[k];
    await store.saveSettings(toSave);
    return send(req, res, 200, { ok: true, settings: mergeSettings(await store.getSettings()) });
  }
  if (p === '/api/settings' && req.method === 'DELETE') {
    await store.saveSettings({ ...DEFAULT_SETTINGS });
    return send(req, res, 200, { ok: true, settings: DEFAULT_SETTINGS });
  }
  if (p.startsWith('/api/')) return send(req, res, 404, { error: 'Not found' });
  if (req.method !== 'GET') return send(req, res, 405, 'Method not allowed', 'text/plain');
  return serveStatic(req, res, p);
}

const port = Number(process.env.PORT) || 3000;
store.init()
  .then(() => {
    http.createServer((req, res) => {
      handle(req, res).catch((e) => {
        console.error(e);
        if (!res.headersSent) send(req, res, 500, { error: e.message });
      });
    }).listen(port, () => console.log(`Khoj control room on :${port} (store: ${store.kind})`));
  })
  .catch((e) => { console.error('Failed to start', e); process.exit(1); });
