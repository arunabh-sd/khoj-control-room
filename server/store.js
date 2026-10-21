// Persistence for settings, tasks (done ticks) and the decision log.
// Postgres when DATABASE_URL is set; otherwise an in-memory store (lost on restart).
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
`;

function memoryStore() {
  const settings = {};
  const tasks = new Map();
  const decisions = [];
  return {
    kind: 'memory',
    async init() {},
    async getSettings() { return { ...settings }; },
    async saveSettings(obj) { Object.assign(settings, obj); },
    async upsertTasks(list) {
      const now = new Date().toISOString();
      for (const t of list) {
        const cur = tasks.get(t.id);
        tasks.set(t.id, { ...t, created_at: cur?.created_at || now, last_seen: now, done_at: cur?.done_at || null });
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
    async recordDecisions(list) {
      for (const d of list) {
        if (decisions.some((x) => x.key === d.key)) continue;
        decisions.push({ ...d, at: new Date().toISOString() });
      }
    },
    async listDecisions() { return [...decisions].sort((a, b) => (a.at < b.at ? 1 : -1)); }
  };
}

function pgStore(url) {
  let pool;
  return {
    kind: 'postgres',
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
    }
  };
}

export function createStore() {
  return process.env.DATABASE_URL ? pgStore(process.env.DATABASE_URL) : memoryStore();
}
