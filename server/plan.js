// Scaling plan: a week-by-week plan built from a few assumptions, and the actuals for the same weeks, so it's clear
// where Khoj is against plan, which assumptions are holding and what puts the plan at risk.
//
// Plan model (per week):
//   testing, catalog, Google and other-Meta daily spend are inputs.
//   Winners found in a week = trials finishing that week × success %; trials finishing ≈ testing spend / trial budget
//   × 7 / trial days. A winner scales from the following week at the average winner budget for `winnerLifeWeeks`.
//   GMV per bucket = spend ÷ that bucket's Spend/GMV; orders = GMV ÷ AOV.
import { num, day } from './engine.js';
import { mondayOf, addDaysIST, parseDaywise, aggDays } from './overview.js';

const pct = (a, b) => (b ? (a / b) * 100 : null);
export const BUCKETS = ['testing', 'winners', 'catalog', 'metaOther', 'google'];
export const BUCKET_LABELS = { testing: 'Product testing', winners: 'Meta product-wise (winners scaling)', catalog: 'Meta catalog (scaling)', metaOther: 'Meta other (retargeting etc.)', google: 'Google' };

export const DEFAULT_PLAN = {
  saved: false,
  startWeek: '2026-09-28',
  weeks: 12,
  assumptions: { aov: 550, successPct: 50, trialBudget: 1000, trialDays: 7, winnerDas: 1500, winnerLifeWeeks: 4,
    sgmv: { testing: 40, winners: 28, catalog: 30, metaOther: 30, google: 35 } },
  // ₹ per day, one value per week. Placeholders until the plan is set on the page: testing at the Rules' 12 trial
  // slots × ₹1,000, catalog growing 10% a week, a little retargeting, no Google yet.
  das: {
    testing: Array(12).fill(12000),
    catalog: Array.from({ length: 12 }, (_, i) => Math.round((8000 * 1.1 ** i) / 500) * 500),
    metaOther: Array(12).fill(1000),
    google: Array(12).fill(0)
  }
};

export function normalisePlan(p) {
  const d = DEFAULT_PLAN;
  const out = { ...d, ...(p || {}), assumptions: { ...d.assumptions, ...(p?.assumptions || {}), sgmv: { ...d.assumptions.sgmv, ...(p?.assumptions?.sgmv || {}) } }, das: { ...d.das, ...(p?.das || {}) } };
  out.weeks = Math.max(1, Math.min(26, Number(out.weeks) || d.weeks));
  for (const b of ['testing', 'catalog', 'metaOther', 'google']) {
    const arr = (out.das[b] || []).map((v) => Number(v) || 0);
    while (arr.length < out.weeks) arr.push(arr.at(-1) ?? 0);
    out.das[b] = arr.slice(0, out.weeks);
  }
  return out;
}

export function planRows(plan) {
  const P = normalisePlan(plan), A = P.assumptions;
  const rows = [];
  const found = [];
  let cumStarted = 0, cumWinners = 0, cumDecided = 0;
  for (let i = 0; i < P.weeks; i++) {
    const week = addDaysIST(mondayOf(P.startWeek), 7 * i);
    const testing = P.das.testing[i], catalog = P.das.catalog[i], metaOther = P.das.metaOther[i], google = P.das.google[i];
    const slots = testing / A.trialBudget;                         // trials running at once
    const finishing = i > 0 ? (P.das.testing[i - 1] / A.trialBudget) * (7 / A.trialDays) : 0;
    const winnersFound = finishing * (A.successPct / 100);
    found.push(winnersFound);
    const active = found.slice(Math.max(0, i - A.winnerLifeWeeks), i).reduce((a, b) => a + b, 0);
    const winners = active * A.winnerDas;
    const das = { testing, winners, catalog, metaOther, google };
    const meta = testing + winners + catalog + metaOther;
    const total = meta + google;
    const gmvB = Object.fromEntries(BUCKETS.map((b) => [b, A.sgmv[b] ? das[b] / (A.sgmv[b] / 100) : 0]));
    const gmv = Object.values(gmvB).reduce((a, b) => a + b, 0);
    cumStarted += slots * (7 / A.trialDays);
    cumDecided += finishing; cumWinners += winnersFound;
    rows.push({ week, das: { ...das, meta, total }, sgmv: { ...A.sgmv, overall: pct(total, gmv) }, gmvPerDay: gmv, aov: A.aov, ordersPerDay: gmv / A.aov,
      testing: { tested: cumStarted, inTesting: slots, winners: cumWinners, killed: cumDecided - cumWinners, successPct: A.successPct, winnersFound } });
  }
  return { plan: P, rows };
}

const bucketOf = (name, s) => {
  const n = String(name || '').toLowerCase();
  if (n.includes(String(s.catalogMatch || 'catalog').toLowerCase())) return 'catalog';
  if (n.includes(String(s.testingMatch || 'testing').toLowerCase())) return 'testing';
  if (n.includes(String(s.scaleMatch || 'scale').toLowerCase())) return 'winners';
  return 'metaOther';
};

// Actuals per week: total spend, orders and GMV from the day-wise question; Meta spend split by campaign type from the
// ads question (Meta GMV corrected by the Spend/GMV factor); Google = total − Meta; product testing from the trials.
export function actualRows({ daywiseRows, adsRows, trials, settings, today }) {
  const daily = parseDaywise(daywiseRows).filter((r) => r.date < today);
  const weeks = new Map();
  const W = (w) => weeks.get(w) || weeks.set(w, { week: w, days: new Set(), meta: Object.fromEntries(['testing', 'winners', 'catalog', 'metaOther'].map((b) => [b, { spend: 0, gmv: 0 }])), dw: [] }).get(w);
  for (const r of daily) { const x = W(mondayOf(r.date)); x.dw.push(r); x.days.add(r.date); }
  for (const r of adsRows || []) {
    const d = day(r.date); if (!d || d >= today) continue;
    const x = W(mondayOf(d)); const b = bucketOf(r.campaign_name, settings);
    x.meta[b].spend += num(r.spend) || 0; x.meta[b].gmv += (num(r.gmv) || 0) / (settings.metaSgmvFactor || 1);
  }
  const ts = trials || [];
  const isWin = (a) => a === 'graduate' || a === 'graduated';
  const isLoss = (a) => a === 'kill' || a === 'killed' || a === 'stopped';
  const decidedOn = (t) => (isWin(t.action) || isLoss(t.action) ? (t.lastSpendDate || t.firstDate) : null);
  return [...weeks.values()].sort((a, b) => (a.week < b.week ? -1 : 1)).map((x) => {
    // Days with data this week: from the day-wise question, else from the ad data's dates.
    for (const r of adsRows || []) { const d2 = day(r.date); if (d2 && d2 < today && mondayOf(d2) === x.week) x.days.add(d2); }
    const days = Math.max(1, x.dw.length || x.days.size);
    const dwA = aggDays(x.dw);
    const meta = Object.values(x.meta).reduce((a, m) => a + m.spend, 0);
    const google = Math.max(0, dwA.spend - meta) > 0.02 * dwA.spend ? dwA.spend - meta : 0;
    const das = Object.fromEntries(Object.entries(x.meta).map(([b, m]) => [b, m.spend / days]));
    const sgmv = Object.fromEntries(Object.entries(x.meta).map(([b, m]) => [b, pct(m.spend, m.gmv)]));
    const end = addDaysIST(x.week, 6);
    const upto = end < today ? end : addDaysIST(today, -1);
    const started = ts.filter((t) => t.firstDate && t.firstDate <= upto);
    const decided = ts.filter((t) => decidedOn(t) && decidedOn(t) <= upto);
    const winners = decided.filter((t) => isWin(t.action)).length, killed = decided.filter((t) => isLoss(t.action)).length;
    return {
      week: x.week, days, partial: days < 7,
      das: { ...das, google: google / days, meta: meta / days, total: dwA.spendPerDay }, sgmv: { ...sgmv, google: null, overall: dwA.sgmv },
      gmvPerDay: dwA.gmvPerDay, aov: dwA.aov, ordersPerDay: dwA.ordersPerDay,
      testing: { tested: started.length, inTesting: started.length - decided.length, winners, killed, successPct: winners + killed ? pct(winners, winners + killed) : null,
        startedThisWeek: ts.filter((t) => t.firstDate >= x.week && t.firstDate <= upto).length }
    };
  });
}

export function computePlan({ plan, daywiseRows, adsRows, trials, settings, today }) {
  const { plan: P, rows: planned } = planRows(plan);
  const actual = actualRows({ daywiseRows, adsRows, trials, settings, today });
  const aBy = Object.fromEntries(actual.map((a) => [a.week, a]));
  const thisWeek = mondayOf(addDaysIST(today, -1));
  const rows = planned.map((p) => ({ week: p.week, plan: p, actual: aBy[p.week] || null, current: p.week === thisWeek, past: p.week < thisWeek }));
  for (const a of actual) if (!rows.some((r) => r.week === a.week)) rows.push({ week: a.week, plan: null, actual: a, current: a.week === thisWeek, past: a.week < thisWeek });
  rows.sort((a, b) => (a.week < b.week ? -1 : 1));

  // Where we are + assumption checks, on the last 2 weeks with actuals (current week to date and the one before).
  const cur = rows.find((r) => r.current) || rows.filter((r) => r.actual).at(-1);
  const recent = rows.filter((r) => r.actual && r.week <= thisWeek).slice(-2);
  const avg = (f) => { const v = recent.map(f).filter((x) => x !== null && x !== undefined && Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const A = P.assumptions;
  const lastActual = rows.filter((r) => r.actual).at(-1)?.actual;
  const checks = [
    { key: 'success', label: 'Trial success %', assumed: A.successPct, actual: lastActual?.testing.successPct ?? null, unit: '%', better: 'higher', note: lastActual ? `${lastActual.testing.winners} winners of ${lastActual.testing.winners + lastActual.testing.killed} decided` : '' },
    ...['testing', 'winners', 'catalog', 'metaOther'].map((b) => ({ key: `sgmv_${b}`, label: `Spend/GMV · ${BUCKET_LABELS[b]}`, assumed: A.sgmv[b], actual: avg((r) => r.actual?.sgmv[b]), unit: '%', better: 'lower', note: 'Meta-reported, corrected' })),
    { key: 'aov', label: 'AOV', assumed: A.aov, actual: avg((r) => r.actual?.aov), unit: '₹', better: 'higher' },
    { key: 'slots', label: 'Trials running at once', assumed: cur?.plan ? cur.plan.testing.inTesting : null, actual: lastActual?.testing.inTesting ?? null, unit: '', better: 'higher' },
    { key: 'spend', label: 'Daily spend (this week)', assumed: cur?.plan?.das.total ?? null, actual: cur?.actual?.das.total ?? null, unit: '₹', better: 'higher' }
  ].map((c) => {
    const gap = c.actual !== null && c.assumed ? ((c.actual - c.assumed) / c.assumed) * 100 : null;
    const ok = gap === null ? null : c.better === 'higher' ? gap >= -10 : gap <= 10;
    return { ...c, gap, ok };
  });

  const risks = [];
  const chk = Object.fromEntries(checks.map((c) => [c.key, c]));
  if (chk.success.ok === false) risks.push(`Trial success is ${chk.success.actual.toFixed(0)}% vs ${A.successPct}% assumed: fewer winners than planned, so the winners-scaling budget can't be deployed on plan.`);
  for (const b of ['testing', 'winners', 'catalog', 'metaOther']) { const c = chk[`sgmv_${b}`]; if (c.ok === false) risks.push(`${BUCKET_LABELS[b]} runs at ${c.actual.toFixed(0)}% Spend/GMV vs ${c.assumed}% planned: each rupee buys less GMV than the plan expects.`); }
  if (chk.aov.ok === false) risks.push(`AOV ₹${Math.round(chk.aov.actual)} vs ₹${A.aov} planned: more orders needed for the same GMV.`);
  if (chk.slots.ok === false) risks.push(`Only ${chk.slots.actual} trials running vs ${Math.round(chk.slots.assumed)} planned: the testing funnel is slower than plan.`);
  if (chk.spend.ok === false) risks.push(`This week's spend is ${Math.round(chk.spend.gap)}% off plan.`);
  if (cur?.plan && cur?.actual && cur.actual.ordersPerDay !== null && cur.plan.ordersPerDay && cur.actual.ordersPerDay < cur.plan.ordersPerDay * 0.9) risks.push(`Orders per day ${cur.actual.ordersPerDay.toFixed(0)} vs ${cur.plan.ordersPerDay.toFixed(0)} planned for this week.`);
  if (!P.saved) risks.unshift('The plan is still the default placeholder: set the weekly budgets and assumptions below so the comparison means something.');

  // Orders are the scaling metric. Gap this week split into spend, efficiency and basket:
  // orders = spend ÷ (Spend/GMV × AOV), so ln(actual/plan) = ln(spend) − ln(S/GMV) − ln(AOV) ratios.
  let gap = null;
  const ca = cur?.actual, cp = cur?.plan;
  if (ca && cp && ca.ordersPerDay && cp.ordersPerDay && ca.das.total && cp.das.total && ca.sgmv.overall && cp.sgmv.overall && ca.aov && cp.aov) {
    const parts = [['Spend', Math.log(ca.das.total / cp.das.total)], ['Spend/GMV (efficiency)', -Math.log(ca.sgmv.overall / cp.sgmv.overall)], ['AOV', -Math.log(ca.aov / cp.aov)]];
    const tot = parts.reduce((a, [, v]) => a + v, 0);
    const delta = ca.ordersPerDay - cp.ordersPerDay;
    gap = { delta, rows: parts.map(([label, v]) => ({ label, orders: tot ? delta * (v / tot) : 0 })) };
  }
  // Orders to date since the plan started: actual orders vs the plan's orders for the same days.
  let cum = null;
  const done = rows.filter((r) => r.plan && r.actual && r.week <= thisWeek);
  if (done.length) cum = { actual: done.reduce((a, r) => a + (r.actual.ordersPerDay || 0) * r.actual.days, 0), plan: done.reduce((a, r) => a + r.plan.ordersPerDay * r.actual.days, 0), weeks: done.length };

  return { plan: P, rows, checks, risks, gap, cum, currentWeek: cur?.week || null, labels: BUCKET_LABELS };
}
