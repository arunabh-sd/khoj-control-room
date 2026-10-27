// Overall Status: an executive summary from the day-wise question (Q16083) and the P&L question (Q16167, pulled per
// date window). Everything here is about the business as a whole: scale, efficiency, unit economics, quality, ops.
import { num, day } from './engine.js';

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

// Log split of a change in Spend/GMV into its ad-funnel drivers: S/GMV = CPM / (1000 × CTR × C2PR × AOV).
function sgmvDrivers(a, b) {
  if (![a, b].every((x) => x && x.cpm && x.ctr && x.c2pr && x.aov && x.sgmv)) return null;
  const parts = [['CPM (cost of reach)', Math.log(b.cpm / a.cpm)], ['CTR (ad click rate)', -Math.log(b.ctr / a.ctr)], ['Click → order rate', -Math.log(b.c2pr / a.c2pr)], ['AOV', -Math.log(b.aov / a.aov)]];
  const total = parts.reduce((s, [, v]) => s + v, 0);
  const delta = b.sgmv - a.sgmv;
  return { delta, rows: parts.map(([label, v]) => ({ label, points: total ? delta * (v / total) : 0, direction: v > 0 ? 'worse' : 'better' })) };
}

export function computeOverview({ daywiseRows, pnlRows, today }) {
  const daily = parseDaywise(daywiseRows);
  if (!daily.length) return null;
  const complete = daily.filter((r) => r.date < today);
  const todayRow = daily.find((r) => r.date === today) || null;
  const yest = addDaysIST(today, -1);
  const inRange = (a, b) => complete.filter((r) => r.date >= a && r.date <= b);
  const last7 = aggDays(inRange(addDaysIST(yest, -6), yest));
  const prev7 = aggDays(inRange(addDaysIST(yest, -13), addDaysIST(yest, -7)));
  const all = aggDays(complete);

  // Weeks (Mon–Sun); the current week runs to yesterday.
  const weeksMap = new Map();
  for (const r of complete) { const w = mondayOf(r.date); (weeksMap.get(w) || weeksMap.set(w, []).get(w)).push(r); }
  const pnl = (pnlRows || []).map(pnlRow);
  const pnlBy = Object.fromEntries(pnl.map((p) => [p.window, p]));
  const weeks = [...weeksMap.entries()].sort().map(([w, list], i) => ({ week: w, label: `W${i + 1}`, partial: list.length < 7, ...aggDays(list), pnl: pnlBy[`week:${w}`] || null }));

  // 7-day rolling series for the charts.
  const rolling = complete.map((r, i) => {
    const win = complete.slice(Math.max(0, i - 6), i + 1);
    const a = aggDays(win);
    const ok = win.length >= 3;   // the first two days of the series are too thin for a 7-day average
    return { date: r.date, orders: r.orders, spend: r.spend, gmv: r.gmv, sgmv: pct(r.spend, r.gmv), sgmv7: ok ? a.sgmv : null, orders7: ok ? a.ordersPerDay : null, online7: ok ? a.onlinePct : null, aov7: ok ? a.aov : null };
  });

  const drivers = sgmvDrivers(prev7, last7);
  const p7 = pnlBy.last7 || pnlBy.file || null, pp7 = pnlBy.prev7 || null, pAll = pnlBy.all || null;
  // P&L marketing vs ad spend for the same days (taxes and non-ad marketing make it higher); converts the breakeven
  // into the Spend/GMV the ads report.
  const spendFor = (p) => (p?.start && p?.end ? daily.filter((r) => r.date >= p.start && r.date <= p.end).reduce((a, r) => a + r.spend, 0) : 0);
  const mktToSpend = p7 && spendFor(p7) ? p7.mkt / spendFor(p7) : pAll && spendFor(pAll) ? pAll.mkt / spendFor(pAll) : null;
  const breakevenAdSgmv = p7 && mktToSpend ? p7.breakevenMktOfGmv / mktToSpend : null;

  // Ops: orders from before yesterday still not dispatched.
  const backlog = daily.filter((r) => r.date < yest && r.notDispatched > 0).reduce((a, r) => a + r.notDispatched, 0);
  const yRow = daily.find((r) => r.date === yest);

  const flags = [];
  const chg = (a, b) => (a !== null && b !== null && b !== 0 ? ((a - b) / b) * 100 : null);
  if (last7.sgmv !== null && breakevenAdSgmv !== null) flags.push(last7.sgmv > breakevenAdSgmv
    ? { tone: 'bad', text: `Spend/GMV is ${last7.sgmv.toFixed(1)}% vs ~${breakevenAdSgmv.toFixed(1)}% needed to break even at today's RTO and seller payouts: ${(last7.sgmv - breakevenAdSgmv).toFixed(1)} points to close.` }
    : { tone: 'good', text: `Spend/GMV of ${last7.sgmv.toFixed(1)}% is inside the ~${breakevenAdSgmv.toFixed(1)}% breakeven line.` });
  if (p7 && pp7 && p7.rtoPct !== null && pp7.rtoPct !== null && p7.rtoPct - pp7.rtoPct >= 2) flags.push({ tone: 'bad', text: `RTO is up: ${p7.rtoPct.toFixed(1)}% in the last 7 days vs ${pp7.rtoPct.toFixed(1)}% the week before.` });
  if (last7.cancelPct !== null && prev7.cancelPct !== null && last7.cancelPct - prev7.cancelPct >= 2) flags.push({ tone: 'bad', text: `Cancellations rose to ${last7.cancelPct.toFixed(1)}% (from ${prev7.cancelPct.toFixed(1)}%).` });
  if (last7.onlinePct !== null && prev7.onlinePct !== null && Math.abs(last7.onlinePct - prev7.onlinePct) >= 3) flags.push({ tone: last7.onlinePct > prev7.onlinePct ? 'good' : 'bad', text: `Online share ${last7.onlinePct > prev7.onlinePct ? 'up' : 'down'} to ${last7.onlinePct.toFixed(1)}% (from ${prev7.onlinePct.toFixed(1)}%).` });
  if (backlog > 0) flags.push({ tone: 'bad', text: `${backlog} orders from before yesterday are still not dispatched.` });
  if (yRow && yRow.nonCancelled && yRow.notDispatched / yRow.nonCancelled > 0.25) flags.push({ tone: 'info', text: `${yRow.notDispatched} of yesterday's ${yRow.nonCancelled} orders are not dispatched yet.` });
  const g = chg(last7.ordersPerDay, prev7.ordersPerDay);
  if (g !== null && g <= -10) flags.push({ tone: 'bad', text: `Orders per day fell ${Math.abs(g).toFixed(0)}% week on week.` });

  // Headline sentence.
  const first = weeks.find((w) => !w.partial && w.days >= 5) || weeks[0];
  const verdict = [
    `Last 7 days: ${last7.ordersPerDay?.toFixed(0)} orders a day (${g === null ? '—' : `${g >= 0 ? '+' : ''}${g.toFixed(0)}% week on week`}), ₹${Math.round(last7.gmvPerDay || 0).toLocaleString('en-IN')} GMV a day on ₹${Math.round(last7.spendPerDay || 0).toLocaleString('en-IN')} spend: Spend/GMV ${last7.sgmv?.toFixed(1)}%${prev7.sgmv !== null ? ` (was ${prev7.sgmv.toFixed(1)}%)` : ''}.`,
    first && first.to < last7.from ? `Since ${first.label} (first full week), Spend/GMV has gone from ${first.sgmv?.toFixed(0)}% to ${last7.sgmv?.toFixed(0)}% and orders per day from ${first.ordersPerDay?.toFixed(0)} to ${last7.ordersPerDay?.toFixed(0)}.` : '',
    p7 ? `P&L (${p7.window === 'last7' ? 'last 7 days' : `${p7.start}${p7.end !== p7.start ? ' to ' + p7.end : ''}`}, ${p7.rtoPct?.toFixed(0)}% RTO): profit ${p7.profitPct?.toFixed(1)}% of NMV, ₹${Math.round(p7.perOrder?.profit || 0)} per shipped order.` : ''
  ].filter(Boolean).join(' ');

  return { today, yesterday: yest, todayRow, daily, rolling, last7, prev7, all, weeks, pnl: { last7: p7, prev7: pp7, all: pAll, yesterday: pnlBy.yesterday || null, file: pnlBy.file || null }, mktToSpend, breakevenAdSgmv, drivers, backlog, flags, verdict };
}
