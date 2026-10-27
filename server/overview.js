// Overall Status: an executive summary from the day-wise question (Q16083) and the P&L question (Q16167, pulled per
// date window). Everything here is about the business as a whole: scale, efficiency, unit economics, quality, ops.
import { num, day } from './engine.js';
import { parseTs } from './history.js';

export const addDaysIST = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const mondayOf = (iso) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
const pct = (a, b) => (b ? (a / b) * 100 : null);

export function parseDaywise(rows) {
  return (rows || []).map((r) => ({
    date: day(r.date), orders: num(r.total_orders) || 0, cancelled: num(r.cancelled_orders) || 0, nonCancelled: num(r.non_cancelled_orders) || 0,
    notDispatched: num(r.not_dispatched) || 0, dispatched: num(r.dispatched) || 0, online: num(r.online_orders) || 0,
    gmv: num(r.gmv) || 0, spend: num(r.total_spend) || 0, impressions: num(r.total_impressions) || 0, clicks: num(r.total_clicks) || 0
  })).filter((r) => r.date).sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Sums and ratios for a set of days. Ratios follow the question's own definitions (per total orders).
export function aggDays(list) {
  const s = list.reduce((a, r) => { for (const k of ['orders', 'cancelled', 'nonCancelled', 'notDispatched', 'online', 'gmv', 'spend', 'impressions', 'clicks']) a[k] += r[k]; return a; },
    { orders: 0, cancelled: 0, nonCancelled: 0, notDispatched: 0, online: 0, gmv: 0, spend: 0, impressions: 0, clicks: 0 });
  const days = list.length;
  return {
    ...s, days, from: list[0]?.date || null, to: list.at(-1)?.date || null,
    ordersPerDay: days ? s.orders / days : null, gmvPerDay: days ? s.gmv / days : null, spendPerDay: days ? s.spend / days : null,
    sgmv: pct(s.spend, s.gmv), aov: s.orders ? s.gmv / s.orders : null, cpo: s.orders ? s.spend / s.orders : null,
    onlinePct: pct(s.online, s.orders), cancelPct: pct(s.cancelled, s.orders),
    ctr: pct(s.clicks, s.impressions), cpm: s.impressions ? (s.spend / s.impressions) * 1000 : null, cpc: s.clicks ? s.spend / s.clicks : null, c2pr: pct(s.orders, s.clicks)
  };
}

function pnlRow(r) {
  const g = (k) => num(r[k]) || 0;
  const x = { window: r.window || 'file', start: day(r.window_start || r.start_date), end: day(r.window_end || r.end_date),
    orders: g('total_orders'), cancelled: g('cancelled'), shipped: g('awb_nc'), delivered: g('delivered'), rto: g('rto'),
    nmv: g('nmv'), gmv: g('gmv'), logistics: g('logistic_charge'), mkt: g('mkt'), cogs: g('cogs'), tp: g('tp'), profit: g('profit') };
  x.rtoPct = num(r.rto_percent) ?? pct(x.rto, x.delivered + x.rto);
  x.profitPct = num(r.profit_percent) ?? pct(x.profit, x.nmv);
  x.profitOfGmv = pct(x.profit, x.gmv);
  x.mktOfGmv = pct(x.mkt, x.gmv);
  x.nmvOfGmv = pct(x.nmv, x.gmv);
  x.tpOfGmv = pct(x.tp, x.gmv);
  x.logOfGmv = pct(x.logistics, x.gmv);
  // Breakeven: the marketing (as % of GMV) that would make profit zero at this window's RTO, take rate and logistics.
  x.breakevenMktOfGmv = pct(x.nmv - x.tp - x.logistics, x.gmv);
  const per = x.shipped || x.orders;
  x.perOrder = per ? { gmv: x.gmv / per, nmv: x.nmv / per, tp: x.tp / per, logistics: x.logistics / per, mkt: x.mkt / per, profit: x.profit / per } : null;
  return x;
}

// Predicted RTO from Khoj's own orders placed D-17 to D-10 (old enough to have settled): RTO = 1 − delivered ÷
// non-cancelled, separately for COD and online. Order level: delivered if any line was delivered.
const isCodPm = (pm) => pm === 'cod' || pm === 'partial-cod';
const istDay = (t) => new Date((t + 330) * 60000).toISOString().slice(0, 10);
export function predictRto(historyRows, khojSellerId, today, window = {}) {
  const from = window.from || addDaysIST(today, -17), to = window.to || addDaysIST(today, -10);
  const orders = new Map();
  for (const x of historyRows || []) {
    if (x.s !== khojSellerId || !x.t) continue;
    const d = istDay(x.t);
    if (d < from || d > to) continue;
    const o = orders.get(x.o) || orders.set(x.o, { cod: isCodPm(x.pm), st: new Set() }).get(x.o);
    o.st.add(x.st);
  }
  const g = { cod: { nonCancelled: 0, delivered: 0 }, online: { nonCancelled: 0, delivered: 0 } };
  for (const o of orders.values()) {
    if (o.st.size === 1 && o.st.has('C')) continue;
    const b = g[o.cod ? 'cod' : 'online'];
    b.nonCancelled += 1;
    if (o.st.has('D')) b.delivered += 1;
  }
  const rate = (b) => (b.nonCancelled ? (1 - b.delivered / b.nonCancelled) * 100 : null);
  const all = { nonCancelled: g.cod.nonCancelled + g.online.nonCancelled, delivered: g.cod.delivered + g.online.delivered };
  return { from, to, cod: { ...g.cod, rtoPct: rate(g.cod) }, online: { ...g.online, rtoPct: rate(g.online) }, all: { ...all, rtoPct: rate(all) } };
}
// A window's predicted RTO: COD and online rates weighted by the window's own payment mix.
export function rtoForMix(pred, onlinePct) {
  if (!pred) return null;
  const c = pred.cod.rtoPct, o = pred.online.rtoPct;
  if (onlinePct === null || onlinePct === undefined) return pred.all.rtoPct;
  if (c === null) return o; if (o === null) return c;
  return (1 - onlinePct / 100) * c + (onlinePct / 100) * o;
}
export const GST = 1.18;

// New vs repeat orders by IST day. From the Khoj orders question (one row per order) or, until that is connected, from
// the Khoj lines of the order-history question. Repeat = the customer had a Khoj order more than `sessionMinutes`
// earlier; the first order (and anything in the same session) is a new-user order.
const minutesOf = (s) => (typeof s === 'number' ? s : parseTs(s));
export function newVsRepeat({ orderRows, historyRows, khojSellerId, sessionMinutes = 30 }) {
  let orders = [], source = null;
  if (orderRows?.length) {
    source = 'orders';
    orders = orderRows.map((r) => ({ o: String(r.order_id), c: String(r.customer_id || ''), t: minutesOf(r.createdat), pm: String(r.payment_mode || '').toLowerCase() })).filter((x) => x.c && x.t !== null);
  } else if (historyRows?.length) {
    source = 'history';
    const m = new Map();
    for (const x of historyRows) if (x.s === khojSellerId && x.t) { const o = m.get(x.o); if (!o || x.t < o.t) m.set(x.o, { o: x.o, c: x.c, t: x.t, pm: x.pm }); }
    orders = [...m.values()];
  }
  if (!orders.length) return null;
  orders.sort((a, b) => a.t - b.t);
  const first = new Map();
  const byDay = new Map();
  for (const x of orders) {
    if (!first.has(x.c)) first.set(x.c, x.t);
    const rep = x.t - first.get(x.c) > sessionMinutes;
    const d = istDay(x.t);
    const g = byDay.get(d) || byDay.set(d, { date: d, newOrders: 0, repeatOrders: 0, newOnline: 0, repeatOnline: 0 }).get(d);
    if (rep) { g.repeatOrders++; if (!isCodPm(x.pm)) g.repeatOnline++; } else { g.newOrders++; if (!isCodPm(x.pm)) g.newOnline++; }
  }
  const days = [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  return { source, days, asOf: days.at(-1)?.date || null };
}
const aggNR = (list, nDays) => {
  if (!list || !nDays) return null;
  const s = list.reduce((a, r) => ({ newOrders: a.newOrders + r.newOrders, repeatOrders: a.repeatOrders + r.repeatOrders, newOnline: a.newOnline + r.newOnline, repeatOnline: a.repeatOnline + r.repeatOnline }), { newOrders: 0, repeatOrders: 0, newOnline: 0, repeatOnline: 0 });
  const tot = s.newOrders + s.repeatOrders;
  return { newPerDay: s.newOrders / nDays, repeatPerDay: s.repeatOrders / nDays, newOnlinePct: pct(s.newOnline, s.newOrders), repeatOnlinePct: pct(s.repeatOnline, s.repeatOrders), repeatPct: pct(s.repeatOrders, tot), total: tot };
};   // P&L marketing includes 18% GST; ad spend in the day-wise question doesn't

export function computeOverview({ daywiseRows, pnlRows, historyRows, orderRows, khojSellerId, sessionMinutes = 30, rtoWindow, today }) {
  const daily = parseDaywise(daywiseRows);
  if (!daily.length) return null;
  const complete = daily.filter((r) => r.date < today);
  const yest = addDaysIST(today, -1);
  const inRange = (a, b) => daily.filter((r) => r.date >= a && r.date <= b);
  const pred = predictRto(historyRows, khojSellerId, today, rtoWindow);
  const pnl = (pnlRows || []).map(pnlRow);
  const pnlBy = Object.fromEntries(pnl.map((p) => [p.window, p]));

  // The four headline windows.
  const NR = newVsRepeat({ orderRows, historyRows, khojSellerId, sessionMinutes });
  const nrIn = (a, b) => (NR ? NR.days.filter((r) => r.date >= a && r.date <= b) : null);
  const W = [['today', 'Today', today, today], ['yesterday', 'Yesterday', yest, yest], ['l3d', 'L3D', addDaysIST(yest, -2), yest], ['l7d', 'L7D', addDaysIST(yest, -6), yest]];
  const windows = W.map(([key, label, from, to]) => {
    const a = aggDays(inRange(from, to));
    const p = pnlBy[key] || (key === 'l7d' ? pnlBy.last7 : key === 'yesterday' ? null : null) || null;
    const predictedRto = rtoForMix(pred, a.onlinePct);
    const covered = NR && NR.asOf && NR.asOf >= to;
    const nr = covered ? aggNR(nrIn(from, to), a.days) : null;
    return { key, label, from, to, ...a, predictedRto, cmPct: p ? p.profitPct : null, pnlRto: p ? p.rtoPct : null, pnl: p, nr };
  });
  const prev7 = aggDays(inRange(addDaysIST(yest, -13), addDaysIST(yest, -7)));
  const last7 = windows.find((w) => w.key === 'l7d');

  // Weeks (Mon–Sun); the current week runs to yesterday.
  const weeksMap = new Map();
  for (const r of complete) { const w = mondayOf(r.date); (weeksMap.get(w) || weeksMap.set(w, []).get(w)).push(r); }
  const weeks = [...weeksMap.entries()].sort().map(([w, list], i) => ({ week: w, label: `W${i + 1}`, partial: list.length < 7, ...aggDays(list), pnl: pnlBy[`week:${w}`] || null, nr: NR && NR.asOf >= list.at(-1).date ? aggNR(nrIn(w, list.at(-1).date), list.length) : null }));

  // Daily series for the trend charts (7-day averages need at least 3 days).
  const rolling = complete.map((r, i) => {
    const win = complete.slice(Math.max(0, i - 6), i + 1);
    const a = aggDays(win);
    const ok = win.length >= 3;
    const nrd = NR ? NR.days.find((x) => x.date === r.date) : null;
    const nrw = NR && NR.asOf >= r.date ? aggNR(nrIn(win[0].date, r.date), win.length) : null;
    return { date: r.date, orders: r.orders, spend: r.spend, gmv: r.gmv, sgmv: pct(r.spend, r.gmv), sgmv7: ok ? a.sgmv : null, orders7: ok ? a.ordersPerDay : null, online7: ok ? a.onlinePct : null, aov7: ok ? a.aov : null, cancel7: ok ? a.cancelPct : null,
      repeatPct: nrd ? pct(nrd.repeatOrders, nrd.newOrders + nrd.repeatOrders) : null, repeatPct7: ok && nrw ? nrw.repeatPct : null,
      newOrders: nrd ? nrd.newOrders : null, repeatOrders: nrd ? nrd.repeatOrders : null, onlinePct: pct(r.online, r.orders), cancelPct: pct(r.cancelled, r.orders), aov: r.orders ? r.gmv / r.orders : null };
  });

  // Unit economics and breakeven: yesterday's P&L at the predicted RTO (pricing and payouts can change daily).
  const PY = pnlBy.yesterday || pnlBy.file || null;
  const breakevenAdSgmv = PY && PY.breakevenMktOfGmv !== null ? PY.breakevenMktOfGmv / GST : null;

  return { today, yesterday: yest, daily, rolling, windows, last7, prev7, weeks, predictedRto: pred, newRepeat: NR ? { source: NR.source, asOf: NR.asOf } : null,
    pnl: { yesterday: PY, l7d: pnlBy.l7d || pnlBy.last7 || pnlBy.file || null, prev7: pnlBy.prev7 || null, all: pnlBy.all || null, last7: pnlBy.l7d || pnlBy.last7 || pnlBy.file || null },
    breakevenAdSgmv };
}
