// Usage tracking: who opens the control room, which tabs they spend time on, and what they do there.
// Events come from two places: the page (open, tab views, active time per tab, Refresh) and the API itself (sign-ins,
// refused sign-ins from other domains, task ticks, rule and plan saves, CSV downloads). Only recorded with Google
// sign-in on, so every event has a person.
import crypto from 'node:crypto';

export const KEEP_DAYS = 180;
// Page events: what the browser may send. The rest are written by the server only.
const PAGE_TYPES = new Set(['open', 'view', 'active', 'refresh']);
export const ACTION_TYPES = ['refresh', 'task', 'rules', 'plan', 'csv', 'repull'];

export const istDay = (iso) => new Date(new Date(iso).getTime() + 330 * 60000).toISOString().slice(0, 10);
export const addDay = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const clip = (s, n = 80) => (s === null || s === undefined ? null : String(s).slice(0, n));

export function event(email, type, extra = {}) {
  return { id: crypto.randomBytes(8).toString('hex'), at: new Date().toISOString(), email, type, session: clip(extra.session, 40), tab: clip(extra.tab, 40), detail: clip(extra.detail, 160), sec: Number.isFinite(extra.sec) ? Math.max(0, Math.min(600, Math.round(extra.sec))) : null };
}

// What the page sent → clean events, stamped with the signed-in person and the server's clock.
export function pageEvents(email, body) {
  const session = clip(body?.session, 40);
  return (Array.isArray(body?.events) ? body.events : []).slice(0, 200)
    .filter((x) => x && PAGE_TYPES.has(x.type))
    .map((x) => event(email, x.type, { session, tab: x.tab, detail: x.detail, sec: x.type === 'active' ? Number(x.sec) : undefined }));
}

// The report for the Usage tab. `people`: emails on the access list, so people who never opened it still show.
export function summarise(events, { days = 30, today = istDay(new Date().toISOString()), people = [] } = {}) {
  const from = addDay(today, -(days - 1)), from7 = addDay(today, -6);
  const all = events.filter((e) => e.email && istDay(e.at) >= from && istDay(e.at) <= today);
  // Refused sign-ins are people from outside: listed on their own, never counted as users.
  const refused = all.filter((e) => e.type === 'denied');
  const inWin = all.filter((e) => e.type !== 'denied');
  const dates = Array.from({ length: days }, (_, i) => addDay(from, i));
  const byDay = new Map(dates.map((d) => [d, { date: d, users: new Set(), sessions: new Set(), sec: 0 }]));
  const users = new Map();
  const tabs = new Map();
  const u = (email) => {
    if (!users.has(email)) users.set(email, { email, lastSeen: null, firstSeen: null, days: new Set(), days7: new Set(), sessions: new Set(), sec: 0, sec7: 0, tabSec: {}, actions: Object.fromEntries(ACTION_TYPES.map((t) => [t, 0])), logins: 0 });
    return users.get(email);
  };
  for (const e of inWin) {
    const d = istDay(e.at), r = u(e.email), day = byDay.get(d);
    if (!r.lastSeen || e.at > r.lastSeen) r.lastSeen = e.at;
    if (!r.firstSeen || e.at < r.firstSeen) r.firstSeen = e.at;
    r.days.add(d); if (d >= from7) r.days7.add(d);
    day.users.add(e.email);
    if (e.session) { r.sessions.add(e.session); day.sessions.add(e.session); }
    if (e.type === 'login') r.logins++;
    if (ACTION_TYPES.includes(e.type)) r.actions[e.type]++;
    if (e.type === 'active' && e.sec) {
      r.sec += e.sec; if (d >= from7) r.sec7 += e.sec; day.sec += e.sec;
      if (e.tab) r.tabSec[e.tab] = (r.tabSec[e.tab] || 0) + e.sec;
    }
    if (e.tab && (e.type === 'active' || e.type === 'view')) {
      if (!tabs.has(e.tab)) tabs.set(e.tab, { tab: e.tab, sec: 0, views: 0, users: new Set() });
      const t = tabs.get(e.tab);
      if (e.type === 'active') t.sec += e.sec || 0; else t.views++;
      t.users.add(e.email);
    }
  }
  for (const p of people) u(p);
  const min = (s) => Math.round(s / 60);
  const dayRows = dates.map((d) => { const x = byDay.get(d); return { date: d, users: x.users.size, sessions: x.sessions.size, activeMin: min(x.sec) }; });
  const distinct = (since) => new Set(inWin.filter((e) => istDay(e.at) >= since).map((e) => e.email)).size;
  return {
    days, from, today,
    totals: {
      usersToday: distinct(today), users7: distinct(from7), usersWindow: [...users.values()].filter((r) => r.lastSeen).length,
      sessions7: new Set(inWin.filter((e) => e.session && istDay(e.at) >= from7).map((e) => e.session)).size,
      activeMin7: min(inWin.filter((e) => e.type === 'active' && istDay(e.at) >= from7).reduce((s, e) => s + (e.sec || 0), 0)),
      actions7: inWin.filter((e) => ACTION_TYPES.includes(e.type) && istDay(e.at) >= from7).length,
      people: users.size
    },
    daily: dayRows,
    users: [...users.values()].map((r) => ({
      email: r.email, lastSeen: r.lastSeen, firstSeen: r.firstSeen, daysActive: r.days.size, daysActive7: r.days7.size, sessions: r.sessions.size,
      activeMin: min(r.sec), activeMin7: min(r.sec7), logins: r.logins, actions: r.actions,
      topTab: Object.entries(r.tabSec).sort((a, b) => b[1] - a[1])[0]?.[0] || null
    })).sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || '') || a.email.localeCompare(b.email)),
    tabs: [...tabs.values()].map((t) => ({ tab: t.tab, activeMin: min(t.sec), views: t.views, users: t.users.size })).sort((a, b) => b.activeMin - a.activeMin || b.views - a.views),
    denied: [...refused.reduce((m, e) => {
      const r = m.get(e.email) || { email: e.email, tries: 0, lastAt: null };
      r.tries++; if (!r.lastAt || e.at > r.lastAt) r.lastAt = e.at;
      return m.set(e.email, r);
    }, new Map()).values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt)),
    recent: inWin.filter((e) => e.type !== 'active' && e.type !== 'view').sort((a, b) => b.at.localeCompare(a.at)).slice(0, 60)
      .map(({ at, email, type, tab, detail }) => ({ at, email, type, tab, detail }))
  };
}

export function usageCsv(events) {
  const cols = ['at', 'email', 'type', 'tab', 'detail', 'sec', 'session'];
  const cell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [cols.join(','), ...[...events].sort((a, b) => a.at.localeCompare(b.at)).map((e) => cols.map((c) => cell(e[c])).join(','))].join('\n');
}
