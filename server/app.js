// Platform-neutral API: a function from a web-standard Request to a Response.
// Used by the Netlify Function (netlify/functions/api.mjs) and by the local Node server (server/index.js).
import { loadOne, SOURCE_NAMES, SOURCE_LABELS } from './sources.js';
import { compute, todayIST } from './engine.js';
import { saveMetaUpload, loadMetaUpload, clearMetaUpload } from './uploads.js';
import { DEFAULT_SETTINGS, SETTING_LABELS, mergeSettings } from './rules.js';

// For the Data sources panel: what each column looks like in the first rows (type and a short shape, no values).
function sampleTypes(rows) {
  const out = {};
  for (const [k, v] of Object.entries(rows[0] || {})) {
    out[k] = v === null || v === undefined ? 'empty' : typeof v === 'number' ? 'number' : /^-?[\d.]+$/.test(String(v)) ? 'numeric text' : /[\d]/.test(String(v)) && /[,%₹kKmM]/.test(String(v)) ? 'formatted number' : 'text';
  }
  return out;
}

export function createApi(store) {
  const mem = {};   // warm-instance copy of the last Metabase pull per source

  // Runs one Metabase question now and keeps the result for every later request (until the next page load).
  async function refreshSource(name) {
    const result = await loadOne(name);
    mem[name] = result;
    if (store.setCache) await store.setCache('source:' + name, result);
    return result;
  }

  // Never calls Metabase: uses the last pull (warm memory, then the store). A source never pulled is fetched once.
  async function getSource(name) {
    if (mem[name]) return mem[name];
    if (store.getCache) {
      const cached = await store.getCache('source:' + name);
      if (cached) { mem[name] = cached; return cached; }
    }
    return refreshSource(name);
  }

  async function buildState() {
    const sources = {};
    for (const name of SOURCE_NAMES) sources[name] = await getSource(name);
    sources.loadedAt = SOURCE_NAMES.map((n) => sources[n].loadedAt).filter(Boolean).sort()[0] || new Date().toISOString();
    sources.metaUpload = await loadMetaUpload(store);
    const settings = mergeSettings(await store.getSettings());
    const history = await store.listDecisions();
    const result = compute(sources, settings, history);
    await store.recordDecisions(result.decisions);
    await store.upsertTasks(result.tasks);

    const generated = new Set(result.tasks.map((t) => t.id));
    const healthy = SOURCE_NAMES.every((k) => sources[k].status !== 'error');
    if (healthy) {
      // A task that's no longer generated either got done (the data shows the change) or was superseded
      // (same trial, still running, new decision, e.g. a kill that became a graduate). Close the first, drop the second.
      const active = new Set(result.activeTrialKeys || []);
      const open = (await store.listTasks()).filter((t) => !t.done_at && !generated.has(t.id));
      const trialKey = (id) => id.replace(/^(kill|grad|gradoff|ext):/, '');
      const superseded = open.filter((t) => /^(kill|grad|ext):/.test(t.id) && active.has(trialKey(t.id))).map((t) => t.id);
      const resolved = open.map((t) => t.id).filter((id) => !superseded.includes(id));
      if (superseded.length && store.deleteTasks) await store.deleteTasks(superseded);
      await store.autoClose(resolved);
    }
    const tasks = (await store.listTasks()).filter((t) => generated.has(t.id) || t.done_at);
    const log = (await store.listDecisions()).slice(0, 300);

    const { decisions, activeTrialKeys, ...view } = result;
    return {
      meta: {
        loadedAt: sources.loadedAt,
        store: store.kind,
        sources: Object.fromEntries(SOURCE_NAMES.map((k) => [k, {
          status: sources[k].status, origin: sources[k].origin, rows: sources[k].rows.length, error: sources[k].error || null,
          columns: Object.keys(sources[k].rows[0] || {}), sample: sampleTypes(sources[k].rows)
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

  const json = (status, body, extra = {}) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra }
  });

  function authorised(req) {
    const password = process.env.DASHBOARD_PASSWORD || '';
    if (!password) return true;
    const [scheme, encoded] = String(req.headers.get('authorization') || '').split(' ');
    if (scheme !== 'Basic' || !encoded) return false;
    return Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':') === password;
  }

  async function readJson(req, limit = 100_000) {
    const text = await req.text();
    if (text.length > limit) throw new Error('Body too large');
    return text ? JSON.parse(text) : {};
  }

  async function handle(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === '/healthz' || p === '/api/healthz') return json(200, { ok: true, store: store.kind });
    if (!authorised(req)) return new Response('Password required', { status: 401, headers: { 'www-authenticate': 'Basic realm="Khoj Control Room"' } });

    if (p === '/api/sources' && req.method === 'GET') return json(200, { sources: SOURCE_NAMES.map((n) => ({ name: n, label: SOURCE_LABELS[n] })) });
    const srcMatch = p.match(/^\/api\/sources\/([A-Za-z]+)$/);
    if (srcMatch && req.method === 'POST') {
      if (!SOURCE_NAMES.includes(srcMatch[1])) return json(404, { error: 'Unknown source' });
      const r = await refreshSource(srcMatch[1]);
      return json(200, { name: srcMatch[1], status: r.status, origin: r.origin, rows: r.rows.length, columns: Object.keys(r.rows[0] || {}), error: r.error || null, loadedAt: r.loadedAt });
    }
    if (p === '/api/state' && req.method === 'GET') return json(200, await buildState());
    if (p === '/api/uploads/meta-products' && req.method === 'POST') {
      const body = await readJson(req, 6_000_000);
      try {
        const file = await saveMetaUpload(store, body, todayIST());
        return json(200, { ok: true, file });
      } catch (e) {
        return json(400, { error: e.message });
      }
    }
    if (p === '/api/uploads/meta-products' && req.method === 'DELETE') {
      await clearMetaUpload(store);
      return json(200, { ok: true });
    }

    const taskMatch = p.match(/^\/api\/tasks\/(.+)$/);
    if (taskMatch && req.method === 'POST') {
      const body = await readJson(req);
      const ok = await store.setTaskDone(decodeURIComponent(taskMatch[1]), !!body.done);
      return ok ? json(200, { ok: true }) : json(404, { error: 'Task not found' });
    }
    if (p === '/api/settings' && req.method === 'PUT') {
      const incoming = await readJson(req);
      const merged = mergeSettings(incoming);
      const toSave = {};
      for (const k of Object.keys(incoming)) if (k in DEFAULT_SETTINGS) toSave[k] = merged[k];
      await store.saveSettings(toSave);
      return json(200, { ok: true, settings: mergeSettings(await store.getSettings()) });
    }
    if (p === '/api/settings' && req.method === 'DELETE') {
      await store.saveSettings({ ...DEFAULT_SETTINGS });
      return json(200, { ok: true, settings: DEFAULT_SETTINGS });
    }
    return json(404, { error: 'Not found' });
  }

  return {
    async handle(req) {
      try { return await handle(req); } catch (e) { console.error(e); return json(500, { error: e.message }); }
    },
    refreshSource
  };
}
