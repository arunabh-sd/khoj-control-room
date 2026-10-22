// Platform-neutral API: a function from a web-standard Request to a Response.
// Used by the Netlify Function (netlify/functions/api.mjs) and by the local Node server (server/index.js).
import { loadOne, SOURCE_NAMES, SOURCE_LABELS, DAILY_SOURCES, EVERY_HOURS } from './sources.js';
import { compute, todayIST } from './engine.js';
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

  const istDay = (iso) => new Date(new Date(iso).getTime() + 330 * 60000).toISOString().slice(0, 10);
  const isDaily = (name) => DAILY_SOURCES.includes(name) && !process.env.DATA_DIR;
  const getKV = async (k) => (store.getCache ? store.getCache(k) : store.getKV ? store.getKV('cache:' + k) : null);
  const setKV = async (k, v) => { if (store.setCache) await store.setCache(k, v); else if (store.setKV) await store.setKV('cache:' + k, v); };

  // Runs one Metabase question now and keeps the result for every later request.
  // A failed pull (timeout, Metabase error) keeps the last good pull, flagged stale, so one slow question doesn't
  // blank the dashboard.
  async function refreshSource(name, opts = {}) {
    const result = await loadOne(name, opts);
    if (result.status === 'error') {
      const prev = mem[name] || (await getKV('source:' + name));
      if (prev && prev.status === 'ok') {
        const kept = { ...prev, stale: true, error: result.error, failedAt: result.loadedAt };
        mem[name] = kept;
        return { ...kept, status: 'error' };
      }
    }
    mem[name] = result;
    await setKV('source:' + name, result);
    await setKV('meta:' + name, { loadedAt: result.loadedAt, status: result.status });
    return result;
  }

  // Never calls Metabase: uses the last pull. Daily sources are re-read from the store when the scheduled pull has
  // replaced them; a source never pulled is fetched once (daily ones wait for the scheduled pull).
  async function getSource(name) {
    if (isDaily(name)) {
      const meta = await getKV('meta:' + name);
      if (mem[name] && (!meta || mem[name].loadedAt === meta.loadedAt)) return mem[name];
      const cached = await getKV('source:' + name);
      if (cached) { mem[name] = cached; return cached; }
      return { status: 'missing', origin: 'waiting for the daily pull', rows: [], loadedAt: null, daily: true };
    }
    if (mem[name]) return mem[name];
    const cached = await getKV('source:' + name);
    if (cached) { mem[name] = cached; return cached; }
    return refreshSource(name);
  }

  // Page load / Refresh. Daily sources are not pulled here: the page gets the last daily pull. Only if there has
  // never been a good pull does the page try once (at most once an hour), so a new setup isn't empty until the
  // scheduled run.
  async function pageRefresh(name) {
    if (!isDaily(name)) return refreshSource(name);
    const cur = await getSource(name);
    if (cur.status === 'ok') return { ...cur, daily: true };
    const attempt = await getKV('attempt:' + name);
    if (attempt && Date.now() - new Date(attempt.at).getTime() < 3600_000) return { ...cur, daily: true, error: cur.error || 'Waiting for the daily pull (runs every hour until it succeeds)' };
    await setKV('attempt:' + name, { at: new Date().toISOString() });
    return { ...(await refreshSource(name)), daily: true };
  }

  // Scheduled (hourly): pulls each scheduled source once per period (IST day, or every N hours), with a longer
  // timeout. A failed pull is retried next hour, at most 3 tries per period.
  const periodOf = (name, iso) => {
    const h = EVERY_HOURS[name] || 24;
    const ist = new Date(new Date(iso).getTime() + 330 * 60000);
    return h >= 24 ? ist.toISOString().slice(0, 10) : `${ist.toISOString().slice(0, 10)}#${Math.floor(ist.getUTCHours() / h)}`;
  };
  async function runDaily({ timeoutMs = Number(process.env.MB_DAILY_TIMEOUT_MS || 25000), force = false } = {}) {
    const now = new Date().toISOString();
    return Promise.all(DAILY_SOURCES.map(async (name) => {
      const period = periodOf(name, now);
      const meta = await getKV('meta:' + name);
      if (!force && meta && meta.status === 'ok' && periodOf(name, meta.loadedAt) === period) return { name, skipped: EVERY_HOURS[name] >= 24 ? 'already pulled today' : `already pulled in this ${EVERY_HOURS[name]}-hour window` };
      const tries = await getKV('tries:' + name);
      const n = tries && tries.period === period ? tries.n : 0;
      if (!force && n >= 3) return { name, skipped: '3 failed tries this period' };
      await setKV('tries:' + name, { period, n: n + 1 });
      const r = await refreshSource(name, { timeoutMs });
      return { name, status: r.status, rows: r.rawRows ?? r.rows.length, error: r.error || null };
    }));
  }

  async function buildState() {
    const sources = {};
    for (const name of SOURCE_NAMES) sources[name] = await getSource(name);
    sources.loadedAt = SOURCE_NAMES.filter((n) => !isDaily(n)).map((n) => sources[n].loadedAt).filter(Boolean).sort()[0] || new Date().toISOString();
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
          status: sources[k].status, stale: !!sources[k].stale, daily: isDaily(k), everyHours: EVERY_HOURS[k] || null, loadedAt: sources[k].loadedAt, origin: sources[k].origin, rows: sources[k].rawRows ?? sources[k].rows.length, error: sources[k].error || null,
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
      const r = await pageRefresh(srcMatch[1]);
      return json(200, { name: srcMatch[1], status: r.status, stale: !!r.stale, daily: !!r.daily, everyHours: EVERY_HOURS[srcMatch[1]] || null, origin: r.origin, rows: r.rawRows ?? r.rows.length, columns: Object.keys(r.rows[0] || {}), error: r.error || null, loadedAt: r.loadedAt });
    }
    if (p === '/api/state' && req.method === 'GET') return json(200, await buildState());

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
    refreshSource,
    runDaily
  };
}
