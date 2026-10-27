// Scaling plan, target-driven: orders per day climb from today to the milestones (1,000 by the end of November,
// 10,000 by the end of January) while total Spend/GMV is held at the target (20–22%). For each week the plan works
// out what that takes:
//   GMV = orders × AOV; total spend = GMV × target Spend/GMV.
//   Winners (product-wise scale campaigns) carry a share of GMV that ramps to `winnersShare`; hits needed =
//   that GMV ÷ GMV per hit (daily budget per hit ÷ its Spend/GMV). Hits retire after `winnerLifeWeeks`.
//   New hits needed each week ÷ trial success % = trials to start; trials running × trial budget = testing spend.
//   Google and other Meta carry fixed GMV shares at their own Spend/GMV.
//   Catalog carries the rest of the GMV with whatever spend is left: the plan reports the Spend/GMV catalog must
//   hit for the total to stay on target, next to what catalog runs at today.
import { num, day } from './engine.js';
import { mondayOf, addDaysIST, parseDaywise, aggDays } from './overview.js';

const pct = (a, b) => (b ? (a / b) * 100 : null);
export const BUCKETS = ['testing', 'winners', 'catalog', 'metaOther', 'google'];
export const BUCKET_LABELS = { testing: 'Product testing', winners: 'Meta product-wise (winners scaling)', catalog: 'Meta catalog (scaling)', metaOther: 'Meta other (retargeting etc.)', google: 'Google' };

export const PLAN_VERSION = 2;
export const DEFAULT_PLAN = {
  version: PLAN_VERSION,
  saved: false,
  startWeek: '2026-10-26',
  startOpd: 80,
  milestones: [{ date: '2026-11-30', opd: 1000 }, { date: '2027-01-31', opd: 10000 }],
  targetSgmv: 21, sgmvBand: [20, 22],
  assumptions: {
    aov: 540, successPct: 33, trialBudget: 1000, trialDays: 7,
    winnerDas: 5000, winnerLifeWeeks: 12, winnersShare: 50, startHits: 4,
    googleShare: 10, otherShare: 2,
    sgmv: { testing: 40, winners: 20, metaOther: 30, google: 22 }
  }
};

export function normalisePlan(p) {
  const d = DEFAULT_PLAN;
  if (!p || p.version !== PLAN_VERSION) p = {};   // plans saved in the old (spend-driven) format are replaced
  const out = { ...d, ...p, assumptions: { ...d.assumptions, ...(p.assumptions || {}), sgmv: { ...d.assumptions.sgmv, ...(p.assumptions?.sgmv || {}) } } };
  out.milestones = (Array.isArray(out.milestones) && out.milestones.length ? out.milestones : d.milestones)
    .map((m) => ({ date: day(m.date) || m.date, opd: Number(m.opd) || 0 })).filter((m) => m.date && m.opd > 0).sort((a, b) => (a.date < b.date ? -1 : 1));
  out.startWeek = mondayOf(day(out.startWeek) || d.startWeek);
  out.startOpd = Number(out.startOpd) || d.startOpd;
  out.targetSgmv = Number(out.targetSgmv) || d.targetSgmv;
  return out;
}

export function planRows(plan) {
  const P = normalisePlan(plan), A = P.assumptions;
  const anchors = [{ week: P.startWeek, opd: P.startOpd }, ...P.milestones.map((m) => ({ week: mondayOf(m.date), opd: m.opd }))];
  const lastWeek = anchors.at(-1).week;
  const weeks = [];
  for (let w = P.startWeek; w <= lastWeek; w = addDaysIST(w, 7)) weeks.push(w);
  const idxOf = (w) => weeks.indexOf(w);
  // Orders per day: geometric steps between anchors.
  const opd = weeks.map((w, i) => {
    const k = anchors.findIndex((a) => idxOf(a.week) >= i);
    if (k <= 0) return anchors[0].opd;
    const a = anchors[k - 1], b = anchors[k], ia = idxOf(a.week), ib = idxOf(b.week);
    return a.opd * (b.opd / a.opd) ** ((i - ia) / Math.max(1, ib - ia));
  });
  const n = weeks.length;
  const gmvPerHit = A.winnerDas / (A.sgmv.winners / 100);
  const share = (i) => (n > 1 ? (A.winnersShare * i) / (n - 1) : A.winnersShare) / 100;   // winners' GMV share ramps up
  const hitsNeeded = weeks.map((_, i) => (opd[i] * A.aov * share(i)) / gmvPerHit);
  // After the last week, assume the same growth continues (so the last week still starts the trials it needs).
  const after = n > 1 && hitsNeeded[n - 2] ? hitsNeeded[n - 1] * (hitsNeeded[n - 1] / hitsNeeded[n - 2]) : hitsNeeded[n - 1];
  let cumTrials = 0, cumHits = A.startHits;
  return { plan: P, rows: weeks.map((week, i) => {
    const gmv = opd[i] * A.aov;
    const nextHits = i + 1 < n ? hitsNeeded[i + 1] : after;
    const newHits = Math.max(0, nextHits - hitsNeeded[i] * (1 - 1 / A.winnerLifeWeeks));   // found this week, scaling next
    const trialsStarted = newHits / (A.successPct / 100);
    const trialsRunning = trialsStarted * (A.trialDays / 7);
    const das = { testing: trialsRunning * A.trialBudget, winners: hitsNeeded[i] * A.winnerDas };
    const gmvB = { testing: das.testing / (A.sgmv.testing / 100), winners: hitsNeeded[i] * gmvPerHit, google: gmv * A.googleShare / 100, metaOther: gmv * A.otherShare / 100 };
    das.google = gmvB.google * A.sgmv.google / 100;
    das.metaOther = gmvB.metaOther * A.sgmv.metaOther / 100;
    const total = gmv * P.targetSgmv / 100;
    gmvB.catalog = Math.max(0, gmv - gmvB.testing - gmvB.winners - gmvB.google - gmvB.metaOther);
    das.catalog = Math.max(0, total - das.testing - das.winners - das.google - das.metaOther);
    const sgmv = { testing: A.sgmv.testing, winners: A.sgmv.winners, google: A.sgmv.google, metaOther: A.sgmv.metaOther, catalog: pct(das.catalog, gmvB.catalog), overall: pct(das.testing + das.winners + das.google + das.metaOther + das.catalog, gmv) };
    cumTrials += trialsStarted; cumHits += i > 0 ? Math.max(0, hitsNeeded[i] - hitsNeeded[i - 1] * (1 - 1 / A.winnerLifeWeeks)) : 0;
    const meta = das.testing + das.winners + das.catalog + das.metaOther;
    return {
      week, das: { ...das, meta, total: meta + das.google }, sgmv, gmvPerDay: gmv, aov: A.aov, ordersPerDay: opd[i], gmvMix: Object.fromEntries(Object.entries(gmvB).map(([k, v]) => [k, pct(v, gmv)])),
      hits: { active: hitsNeeded[i], newNeeded: newHits, trialsStarted, trialsRunning, ordersPerHit: gmvPerHit / A.aov },
      testing: { tested: cumTrials, inTesting: trialsRunning, winners: cumHits, killed: null, successPct: A.successPct }
    };
  }) };
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
  // Lifetime trials before the plan started, so the plan's "tested" line continues from the real count.
  const before = (trials || []).filter((t) => t.firstDate && t.firstDate < P.startWeek).length;
  for (const r of rows) if (r.plan) r.plan.testing.tested += before;
  const catToday = avg((r) => r.actual?.sgmv.catalog);
  const checks = [
    { key: 'sgmv', label: 'Total Spend/GMV', assumed: P.targetSgmv, actual: avg((r) => r.actual?.sgmv.overall), unit: '%', better: 'lower', note: `band ${P.sgmvBand[0]}–${P.sgmvBand[1]}%` },
    { key: 'success', label: 'Trial success %', assumed: A.successPct, actual: lastActual?.testing.successPct ?? null, unit: '%', better: 'higher', note: lastActual ? `${lastActual.testing.winners} hits of ${lastActual.testing.winners + lastActual.testing.killed} decided` : '' },
    { key: 'sgmv_catalog', label: 'Catalog Spend/GMV needed', assumed: cur?.plan?.sgmv.catalog ?? null, actual: catToday, unit: '%', better: 'lower', note: 'Meta-reported, corrected' },
    { key: 'sgmv_testing', label: 'Testing Spend/GMV', assumed: A.sgmv.testing, actual: avg((r) => r.actual?.sgmv.testing), unit: '%', better: 'lower', note: 'Meta-reported, corrected' },
    { key: 'aov', label: 'AOV', assumed: A.aov, actual: avg((r) => r.actual?.aov), unit: '₹', better: 'higher' },
    { key: 'slots', label: 'Trials running at once', assumed: cur?.plan ? cur.plan.hits.trialsRunning : null, actual: lastActual?.testing.inTesting ?? null, unit: '', better: 'higher' },
    { key: 'hits', label: 'Hits scaling', assumed: cur?.plan ? cur.plan.hits.active : null, actual: lastActual?.testing.winners ?? null, unit: '', better: 'higher' },
    { key: 'spend', label: 'Daily spend (this week)', assumed: cur?.plan?.das.total ?? null, actual: cur?.actual?.das.total ?? null, unit: '₹', better: 'higher' }
  ].map((c) => {
    const gap = c.actual !== null && c.actual !== undefined && c.assumed ? ((c.actual - c.assumed) / c.assumed) * 100 : null;
    const ok = gap === null ? null : c.key === 'sgmv' ? c.actual <= P.sgmvBand[1] : c.better === 'higher' ? gap >= -10 : gap <= 10;
    return { ...c, gap, ok };
  });

  const risks = [];
  const chk = Object.fromEntries(checks.map((c) => [c.key, c]));
  const end = rows.filter((r) => r.plan).at(-1)?.plan;
  if (chk.sgmv.ok === false) risks.push(`Total Spend/GMV is ${chk.sgmv.actual.toFixed(0)}% vs the ${P.sgmvBand[0]}–${P.sgmvBand[1]}% band: scaling at today's efficiency costs more than the plan allows.`);
  if (chk.success.ok === false) risks.push(`Trial success is ${chk.success.actual.toFixed(0)}% vs ${A.successPct}% assumed: more trials (and testing spend) per hit than planned.`);
  if (end) risks.push(`By the week of ${end.week} the plan needs ${Math.round(end.hits.active)} hits scaling at ₹${Math.round(A.winnerDas).toLocaleString('en-IN')}/day each and ${Math.round(end.hits.trialsStarted)} new trials a week, with catalog at ${end.sgmv.catalog === null ? '—' : end.sgmv.catalog.toFixed(0) + '%'} Spend/GMV.`);
  if (chk.sgmv_catalog.actual !== null && chk.sgmv_catalog.assumed !== null && chk.sgmv_catalog.ok === false) risks.push(`Catalog runs at ${chk.sgmv_catalog.actual.toFixed(0)}% Spend/GMV; the plan needs ${chk.sgmv_catalog.assumed.toFixed(0)}% this week to hold the total at ${P.targetSgmv}%.`);
  if (chk.aov.ok === false) risks.push(`AOV ₹${Math.round(chk.aov.actual)} vs ₹${A.aov} planned: more orders needed for the same GMV.`);
  if (chk.slots.ok === false) risks.push(`Only ${chk.slots.actual} trials running vs ${Math.round(chk.slots.assumed)} needed this week: the hit pipeline is behind.`);
  if (cur?.plan && cur?.actual && cur.actual.ordersPerDay !== null && cur.plan.ordersPerDay && cur.actual.ordersPerDay < cur.plan.ordersPerDay * 0.9) risks.push(`Orders per day ${cur.actual.ordersPerDay.toFixed(0)} vs ${cur.plan.ordersPerDay.toFixed(0)} planned for this week.`);

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
