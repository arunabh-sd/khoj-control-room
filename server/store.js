// Persistence for settings, tasks (done ticks), the decision log and usage events.
// Postgres when DATABASE_URL is set; otherwise an in-memory store (lost on restart).
import { istDay, addDay, KEEP_DAYS } from './usage.js';

const SCHEMA = `
create table if not exists settings (key text primary key, value jsonb not null);
create table if not exists tasks (
  id text primary key,
  segment text not null,
  category text,
  title text not null,
  detail text,
  due date,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  done_at timestamptz,
  auto boolean not null default false
);
alter table tasks add column if not exists auto boolean not null default false;
create table if not exists decisions (
  id bigserial primary key,
  key text unique not null,
  at timestamptz not null default now(),
  adset_id text,
  product_id text,
  product_name text,
  category text,
  action text not null,
  reason text
);
create index if not exists decisions_at on decisions (at desc);
create table if not exists kv (key text primary key, value jsonb not null, updated_at timestamptz not null default now());
create table if not exists usage_events (
  id text primary key,
  at timestamptz not null,
  email text,
  type text not null,
  session text,
  tab text,
  detail text,
  sec integer
);
create index if not exists usage_events_at on usage_events (at desc);
`;

function memoryStore() {
  const kv = new Map();
  const settings = {};
  const tasks = new Map();
  const decisions = [];
  let usage = [];
  return {
    kind: 'memory',
    async init() {},
    async getKV(key) { return kv.has(key) ? structuredClone(kv.get(key)) : null; },
    async setKV(key, value) { kv.set(key, structuredClone(value)); },
    async getSettings() { return { ...settings }; },
    async saveSettings(obj) { Object.assign(settings, obj); },
    async upsertTasks(list) {
      const now = new Date().toISOString();
      for (const t of list) {
        const cur = tasks.get(t.id);
        tasks.set(t.id, { ...t, created_at: cur?.created_at || now, last_seen: now, done_at: cur?.done_at || null, auto: !!cur?.auto });
      }
    },
    async listTasks() { return [...tasks.values()]; },
    async setTaskDone(id, done) {
      const t = tasks.get(id);
      if (!t) return false;
      t.done_at = done ? new Date().toISOString() : null;
      t.auto = false;
      return true;
    },
    async autoClose(ids) {
      const now = new Date().toISOString();
      for (const id of ids) {
        const t = tasks.get(id);
        if (t && !t.done_at) { t.done_at = now; t.auto = true; }
      }
    },
    async deleteTasks(ids) { for (const id of ids) tasks.delete(id); },
    async recordDecisions(list) {
      for (const d of list) {
        if (decisions.some((x) => x.key === d.key)) continue;
        decisions.push({ ...d, at: new Date().toISOString() });
      }
    },
    async listDecisions() { return [...decisions].sort((a, b) => (a.at < b.at ? 1 : -1)); },
    async appendUsage(events) { usage.push(...structuredClone(events)); if (usage.length > 50_000) usage = usage.slice(-50_000); },
    async listUsage(since) { return usage.filter((e) => e.at >= since); }
  };
}

function pgStore(url) {
  let pool;
  return {
    kind: 'postgres',
    async getKV(key) {
      const { rows } = await pool.query('select value from kv where key = $1', [key]);
      return rows[0]?.value ?? null;
    },
    async setKV(key, value) {
      await pool.query('insert into kv (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value, updated_at = now()', [key, JSON.stringify(value)]);
    },
    async init() {
      const { default: pg } = await import('pg');
      pool = new pg.Pool({
        connectionString: url,
        ssl: /localhost|127\.0\.0\.1|\.railway\.internal/.test(url) ? false : { rejectUnauthorized: false }
      });
      await pool.query(SCHEMA);
    },
    async getSettings() {
      const { rows } = await pool.query('select key, value from settings');
      return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    },
    async saveSettings(obj) {
      for (const [k, v] of Object.entries(obj)) {
        await pool.query(
          'insert into settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value',
          [k, JSON.stringify(v)]
        );
      }
    },
    async upsertTasks(list) {
      for (const t of list) {
        await pool.query(
          `insert into tasks (id, segment, category, title, detail, due)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (id) do update set title = excluded.title, detail = excluded.detail,
             segment = excluded.segment, category = excluded.category, due = excluded.due, last_seen = now()`,
          [t.id, t.segment, t.category, t.title, t.detail, t.due]
        );
      }
    },
    async listTasks() {
      const { rows } = await pool.query(
        `select id, segment, category, title, detail, to_char(due, 'YYYY-MM-DD') as due,
                created_at, last_seen, done_at, auto from tasks
         where done_at is null or done_at > now() - interval '14 days'`
      );
      return rows;
    },
    async setTaskDone(id, done) {
      const { rowCount } = await pool.query('update tasks set done_at = $2, auto = false where id = $1', [id, done ? new Date() : null]);
      return rowCount > 0;
    },
    async autoClose(ids) {
      if (!ids.length) return;
      await pool.query('update tasks set done_at = now(), auto = true where id = any($1) and done_at is null', [ids]);
    },
    async deleteTasks(ids) {
      if (ids.length) await pool.query('delete from tasks where id = any($1) and done_at is null', [ids]);
    },
    async recordDecisions(list) {
      for (const d of list) {
        await pool.query(
          `insert into decisions (key, adset_id, product_id, product_name, category, action, reason)
           values ($1, $2, $3, $4, $5, $6, $7) on conflict (key) do nothing`,
          [d.key, d.adset_id, d.product_id, d.product_name, d.category, d.action, d.reason]
        );
      }
    },
    async listDecisions() {
      const { rows } = await pool.query('select * from decisions order by at desc limit 5000');
      return rows;
    },
    async appendUsage(events) {
      if (!events.length) return;
      const cols = ['id', 'at', 'email', 'type', 'session', 'tab', 'detail', 'sec'];
      const values = events.map((_, i) => `(${cols.map((__, j) => '$' + (i * cols.length + j + 1)).join(',')})`).join(',');
      await pool.query(`insert into usage_events (${cols.join(',')}) values ${values} on conflict (id) do nothing`, events.flatMap((e) => cols.map((c) => e[c] ?? null)));
      if (Math.random() < 0.01) await pool.query(`delete from usage_events where at < now() - interval '${KEEP_DAYS} days'`);
    },
    async listUsage(since) {
      const { rows } = await pool.query('select id, at, email, type, session, tab, detail, sec from usage_events where at >= $1 order by at', [since]);
      return rows.map((r) => ({ ...r, at: new Date(r.at).toISOString() }));
    }
  };
}

// Netlify Blobs: three small JSON documents (settings, tasks, decisions) plus a cache of the Metabase results.
// Usage events: each batch is its own blob (usage/<IST day>/<time>-<id>), so two people writing at once never overwrite
// each other. A finished day's batches are folded into one document (usage-day/<day>) the next time the report reads it.
function blobsStore() {
  let store;
  const KEEP_DONE_MS = 14 * 24 * 3600 * 1000;
  const read = async (key, fallback) => (await store.get(key, { type: 'json' })) ?? fallback;
  const write = (key, value) => store.setJSON(key, value);
  return {
    kind: 'netlify-blobs',
    async init() {
      const { getStore } = await import('@netlify/blobs');
      store = getStore({ name: 'khoj-control-room', consistency: 'strong' });
    },
    async getSettings() { return read('settings', {}); },
    async saveSettings(obj) { await write('settings', { ...(await read('settings', {})), ...obj }); },
    async upsertTasks(list) {
      const tasks = await read('tasks', {});
      const now = new Date().toISOString();
      for (const t of list) {
        const cur = tasks[t.id];
        tasks[t.id] = { ...t, created_at: cur?.created_at || now, last_seen: now, done_at: cur?.done_at || null, auto: !!cur?.auto };
      }
      for (const [id, t] of Object.entries(tasks)) {
        if (t.done_at && Date.now() - Date.parse(t.done_at) > KEEP_DONE_MS) delete tasks[id];
      }
      await write('tasks', tasks);
    },
    async listTasks() { return Object.values(await read('tasks', {})); },
    async setTaskDone(id, done) {
      const tasks = await read('tasks', {});
      if (!tasks[id]) return false;
      tasks[id].done_at = done ? new Date().toISOString() : null;
      tasks[id].auto = false;
      await write('tasks', tasks);
      return true;
    },
    async autoClose(ids) {
      if (!ids.length) return;
      const tasks = await read('tasks', {});
      const now = new Date().toISOString();
      for (const id of ids) if (tasks[id] && !tasks[id].done_at) { tasks[id].done_at = now; tasks[id].auto = true; }
      await write('tasks', tasks);
    },
    async deleteTasks(ids) {
      if (!ids.length) return;
      const tasks = await read('tasks', {});
      for (const id of ids) if (tasks[id] && !tasks[id].done_at) delete tasks[id];
      await write('tasks', tasks);
    },
    async recordDecisions(list) {
      const decisions = await read('decisions', []);
      const seen = new Set(decisions.map((d) => d.key));
      const fresh = list.filter((d) => !seen.has(d.key)).map((d) => ({ ...d, at: new Date().toISOString() }));
      if (!fresh.length) return;
      await write('decisions', [...fresh, ...decisions].slice(0, 5000));
    },
    async listDecisions() { return (await read('decisions', [])).sort((a, b) => (a.at < b.at ? 1 : -1)); },
    async getCache(key) { return read('cache:' + key, null); },
    async setCache(key, value) { await write('cache:' + key, value); },
    async getKV(key) { return read('kv:' + key, null); },
    async setKV(key, value) { await write('kv:' + key, value); },
    async appendUsage(events) {
      if (!events.length) return;
      const at = events[0].at;
      await write(`usage/${istDay(at)}/${at.replace(/[:.]/g, '')}-${events[0].id}`, events);
    },
    async listUsage(since) {
      const today = istDay(new Date().toISOString());
      const days = [];
      for (let d = istDay(since); d <= today; d = addDay(d, 1)) days.push(d);
      const perDay = await Promise.all(days.map(async (d) => {
        const [folded, { blobs }] = await Promise.all([read('usage-day/' + d, []), store.list({ prefix: `usage/${d}/` })]);
        if (!blobs.length) return folded;
        const parts = (await Promise.all(blobs.map((b) => read(b.key, [])))).flat();
        const seen = new Set(folded.map((e) => e.id));
        const all = [...folded, ...parts.filter((e) => !seen.has(e.id))];
        if (d < today) {
          await write('usage-day/' + d, all);
          await Promise.all(blobs.map((b) => store.delete(b.key)));
        }
        return all;
      }));
      // Drop folded days past the retention window.
      if (Math.random() < 0.02) {
        const { blobs } = await store.list({ prefix: 'usage-day/' });
        const cutoff = addDay(today, -KEEP_DAYS);
        await Promise.all(blobs.filter((b) => b.key.slice('usage-day/'.length) < cutoff).map((b) => store.delete(b.key)));
      }
      return perDay.flat().filter((e) => e.at >= since);
    }
  };
}

// Netlify Functions → Blobs; DATABASE_URL → Postgres; otherwise in memory.
export function createStore() {
  if (globalThis.Netlify || process.env.NETLIFY_BLOBS_CONTEXT || process.env.STORE === 'blobs') return blobsStore();
  return process.env.DATABASE_URL ? pgStore(process.env.DATABASE_URL) : memoryStore();
}
