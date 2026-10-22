// The rules engine: turns source rows + settings + decision history into every view and task.
import { TEST_CATEGORIES, categoryOf } from './categories.js';
import { analyseHistory } from './history.js';
import { khojOrderWeights, analyseEvents, analyseRepeatBenchmark, analyseVisitorPersonalisation } from './benchmarks.js';

const CATS_ALL = [...TEST_CATEGORIES, 'Other'];

export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).replace(/[,₹%\s]/g, '');
  // Compact formats in case a question is exported formatted: 1.2K, 3.4M, 2L (lakh), 1.1Cr
  const m = s.match(/^(-?[\d.]+)(k|m|l|lakh|cr|crore)$/i);
  if (m) {
    const mult = { k: 1e3, m: 1e6, l: 1e5, lakh: 1e5, cr: 1e7, crore: 1e7 }[m[2].toLowerCase()];
    s = String(Number(m[1]) * mult);
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
// Accepts YYYY-MM-DD(…), D-M-YYYY / D/M/YYYY (Metabase exports), or anything Date can parse.
export function day(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
const STOP = new Set(['creatives', 'creative', 'saree', 'sarees', 'kurti', 'kurtis', 'jewellery', 'trial', 'testing', 'scale', 'and', 'with', 'for', 'the', 'set', 'pack', 'copy']);
const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w));

// Ad set → product, from the spend-by-product question (Q16676). A row counts only if the product took at least
// half the ad set's spend, or if its title shares at least two distinctive words with the ad set name
// (low-share "top products" are usually site-wide noise, e.g. the same product showing ~4% in every ad set).
function buildAdsetMap(mapRows, adRows, idx, relevant = () => true) {
  const nameOf = new Map();
  const keep = new Set();
  for (const r of adRows) {
    if (r.adset_id && r.adset_name) nameOf.set(String(r.adset_id), r.adset_name);
    if (r.adset_id && relevant(r)) keep.add(String(r.adset_id));
  }
  const byAdset = new Map();
  for (const r of mapRows) {
    const adset = String(r.adset_id || '');
    if (!adset) continue;
    const pid = String(r.product_id || r.sku_id || '').trim();
    const p = idx.bySku.get(pid) || idx.byId.get(pid) || idx.byCode.get(pid);
    if (!p) continue;
    const spend = num(r.product_spend) || 0;
    const share = num(r.share_of_adset) ?? (num(r.adset_spend) ? spend / num(r.adset_spend) : null);
    (byAdset.get(adset) || byAdset.set(adset, []).get(adset)).push({ p, spend, share });
  }
  const out = new Map();
  let rejected = 0;
  for (const [adset, cands] of byAdset) {
    cands.sort((a, b) => b.spend - a.spend);
    const nameWords = new Set(words(normName(nameOf.get(adset) || '')));
    const overlap = (p) => words(p.title).filter((w) => nameWords.has(w)).length;
    const strong = cands.find((c) => c.share !== null && c.share >= 0.5);
    const titled = cands.map((c) => ({ c, o: overlap(c.p) })).filter((x) => x.o >= 2).sort((a, b) => b.o - a.o || b.c.spend - a.c.spend)[0];
    const pick = strong ? strong.p : titled ? titled.c.p : null;
    if (pick) out.set(adset, pick); else if (keep.has(adset)) rejected++;
  }
  return { map: out, rejected };
}

const normName = (s) => String(s || '').replace(/\s*[–—-]\s*copy(\s*\d+)?\s*$/i, '').replace(/\s+/g, ' ').trim();
const pct = (a, b) => (b > 0 ? (a / b) * 100 : null);
const median = (xs) => {
  const s = xs.filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const inr = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
const p0 = (n) => Math.round(n) + '%';

export function todayIST() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ---------- hero ----------
// Type 1: L30D orders >= heroOrdersAll. Type 2: heroOrdersMin <= orders < heroOrdersAll, profit % > heroMinProfitPct and
// L30D spend > heroMinSpend. Both need PQ >= heroMinPq (pq null = unknown, not gated).
export function heroTier({ orders, spend, profit, pq }, s) {
  if (pq !== null && pq !== undefined && pq < s.heroMinPq) return null;
  if (orders >= s.heroOrdersAll) return 'A';
  if (orders >= s.heroOrdersMin && profit !== null && profit > s.heroMinProfitPct && spend > s.heroMinSpend) return 'B';
  return null;
}

// PQ per Khoj product from the universe question (product rows only). Products on Khoj that aren't in it fall under its
// PQ floor (it only returns PQ >= 3), so they get pq 0. Empty map = no PQ information: the PQ bar can't be applied.
function pqByKhojId(uRows) {
  const m = new Map();   // khoj_product_id → PQ (null = in the universe, PQ not given)
  for (const r of uRows) {
    if (!r.khoj_product_id) continue;
    const id = String(r.khoj_product_id), v = num(r.pq ?? r.seller_product_pq);
    const prev = m.get(id);
    m.set(id, v === null ? (prev ?? null) : Math.max(prev ?? v, v));
  }
  return m;
}

// ---------- products ----------
export function buildProductIndex(rows, s) { return buildProducts(rows, s, null); }
function buildProducts(rows, s, pqMap) {
  const products = [];
  const byId = new Map();
  const byCode = new Map();
  const bySku = new Map();
  for (const r of rows) {
    const spend = num(r.l30d_spend) || 0;
    const orders = num(r.l30d_orders) || 0;
    const sg = num(r.l30d_s_gmv);
    const profit = num(r.profit_pct_d40_d10);
    const gmv = sg && sg > 0 ? spend / sg : null;
    const ownPq = num(r.seller_product_pq ?? r.pq);
    const pq = ownPq !== null ? ownPq : pqMap && pqMap.size ? (pqMap.has(String(r.khoj_product_id)) ? pqMap.get(String(r.khoj_product_id)) : 0) : null;
    const tier = heroTier({ orders, spend, profit, pq }, s);
    const p = {
      id: String(r.khoj_product_id || ''),
      code: String(r.khoj_product_code || ''),
      title: r.product_title || '',
      seller: r.seller_id || '',
      status: r.current_status || '',
      live: String(r.current_status || '').toLowerCase() === 'live',
      cat: categoryOf(r),
      l4: r.khoj_category_l4 || '',
      spend, orders, sgmv: sg, profit,
      rto: num(r.rto_pct_d40_d10),
      aov: gmv && orders ? gmv / orders : null,
      pq,
      tier,
      hero: !!tier
    };
    if (!p.id) continue;
    p.skus = String(r.khoj_cust_sku_ids || '').split(',').map((x) => x.trim()).filter(Boolean);
    products.push(p);
    byId.set(p.id, p);
    if (p.code) byCode.set(p.code, p);
    for (const sku of p.skus) bySku.set(sku, p);
  }
  return { products, byId, byCode, bySku };
}

function coverage(products) {
  const rows = CATS_ALL.map((c) => {
    const ps = products.filter((p) => p.cat === c);
    const h = ps.filter((p) => p.hero);
    return {
      key: c, name: c === 'Other' ? 'Other categories' : c,
      uploaded: ps.length, live: ps.filter((p) => p.live).length,
      hero: h.length, tierA: h.filter((p) => p.tier === 'A').length, tierB: h.filter((p) => p.tier === 'B').length,
      heroLive: h.filter((p) => p.live).length
    };
  });
  const total = rows.reduce((a, r) => {
    for (const k of ['uploaded', 'live', 'hero', 'tierA', 'tierB', 'heroLive']) a[k] += r[k];
    return a;
  }, { key: 'Total', name: 'Total', uploaded: 0, live: 0, hero: 0, tierA: 0, tierB: 0, heroLive: 0 });
  return [...rows, total];
}

// ---------- ads ----------
// Meta "product id" = Khoj SKU id (khoj_cust_sku_ids). Also accepts product id/code, or a code inside the ad set name.
function resolveProduct(r, idx) {
  if (r._product) return r._product;
  for (const k of ['sku_id', 'product_id', 'khoj_sku_id', 'retailer_id', 'content_id']) {
    const v = r[k];
    if (v && idx.bySku.has(String(v).trim())) return idx.bySku.get(String(v).trim());
  }
  const id = r.khoj_product_id || r.product_id;
  if (id && idx.byId.has(String(id))) return idx.byId.get(String(id));
  const code = r.product_code || r.khoj_product_code;
  if (code && idx.byCode.has(String(code))) return idx.byCode.get(String(code));
  const name = String(r.adset_name || '');
  for (const tok of name.split(/[\s|·,()\[\]/-]+/)) {
    if (tok.length < 6) continue;
    const p = idx.bySku.get(tok) || idx.byCode.get(tok) || idx.byId.get(tok);
    if (p) return p;
  }
  return null;
}

const METRICS = {
  impressions: ['impressions'],
  clicks: ['link_clicks', 'clicks'],
  atc: ['add_to_cart', 'adds_to_cart', 'atc'],
  purchases: ['purchases', 'orders']
};
const pick = (r, keys) => { for (const k of keys) if (k in r) return num(r[k]) ?? 0; return undefined; };

// Groups ad-set-day rows. keyOf decides the unit: one ad set, or one product across original + "– Copy" ad sets.
// The last day the account actually spent (ignores trailing days with near-zero spend, i.e. data lag).
export function referenceDate(rows) {
  const byDate = new Map();
  for (const r of rows) { const d = day(r.date); if (d) byDate.set(d, (byDate.get(d) || 0) + (num(r.spend) || 0)); }
  const dates = [...byDate.keys()].sort();
  if (!dates.length) return { refDate: null, lastDate: null };
  const med = median(dates.slice(-10).map((d) => byDate.get(d))) || 0;
  let i = dates.length - 1;
  while (i > 0 && byDate.get(dates[i]) < 0.2 * med) i--;
  return { refDate: dates[i], lastDate: dates.at(-1) };
}

function groupAdsets(rows, idx, s, keyOf, refDate) {
  const map = new Map();
  const maxDate = refDate || null;
  const factor = s.metaSgmvFactor > 0 ? s.metaSgmvFactor : 1;
  for (const r of rows) {
    const adsetId = String(r.adset_id || r.adset_name || '');
    if (!adsetId) continue;
    const product = resolveProduct(r, idx);
    const key = keyOf(r, product, adsetId);
    let g = map.get(key);
    if (!g) {
      g = { id: key, name: normName(r.adset_name) || adsetId, campaign: normName(r.campaign_name), product, days: [], adsets: new Map(), has: {} };
      map.set(key, g);
    }
    if (!g.product && product) g.product = product;
    const a = g.adsets.get(adsetId) || { id: adsetId, name: r.adset_name || adsetId, campaign: r.campaign_name || '', lastSpendDate: null, status: '' };
    const date = day(r.date);
    const spend = num(r.spend) || 0;
    if (spend > 0 && (!a.lastSpendDate || date > a.lastSpendDate)) a.lastSpendDate = date;
    if (r.adset_status || r.status) a.status = r.adset_status || r.status;
    g.adsets.set(adsetId, a);
    const d = { date, adsetId, budget: num(r.daily_budget), spend, gmv: (num(r.gmv) ?? num(r.purchase_value) ?? 0) / factor };
    for (const [m, keys] of Object.entries(METRICS)) {
      const v = pick(r, keys);
      if (v !== undefined) { d[m] = v; g.has[m] = true; }
    }
    g.days.push(d);
  }
  for (const g of map.values()) {
    // merge same-date rows from several ad sets (original + copies) into one day
    const byDate = new Map();
    for (const d of g.days) {
      const cur = byDate.get(d.date);
      if (!cur) { byDate.set(d.date, { ...d }); continue; }
      for (const k of ['spend', 'gmv', ...Object.keys(METRICS)]) if (d[k] !== undefined) cur[k] = (cur[k] || 0) + d[k];
      if (d.budget !== null) cur.budget = (cur.budget || 0) + d.budget;
    }
    g.days = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    const t = (k) => g.days.reduce((a, d) => a + (d[k] || 0), 0);
    g.spend = t('spend'); g.gmv = t('gmv');
    for (const m of Object.keys(METRICS)) g[m] = g.has[m] ? t(m) : null;
    g.firstDate = g.days.find((d) => d.spend > 0)?.date || g.days[0]?.date;
    g.lastDate = g.days.at(-1)?.date;
    g.dayCount = new Set(g.days.filter((d) => d.spend > 0).map((d) => d.date)).size;
    const recent = maxDate ? addDays(maxDate, -1) : null;
    const adsets = [...g.adsets.values()];
    for (const a of adsets) {
      a.active = a.status ? /active|on|running|learning/i.test(a.status) : !!(a.lastSpendDate && recent && a.lastSpendDate >= recent);
    }
    g.activeAdsets = adsets.filter((a) => a.active);
    g.active = g.activeAdsets.length > 0;
    g.sgmv = pct(g.spend, g.gmv);
    g.ctr = g.has.clicks && g.has.impressions ? pct(g.clicks, g.impressions) : null;
    g.cat = g.product?.cat || TEST_CATEGORIES.find((c) => g.campaign.toLowerCase().includes(c.split(' ')[0].toLowerCase())) || 'Other';
  }
  return [...map.values()];
}

// Spend/GMV over the most recent part of a trial: the latest days covering at least `verdictWindowShare` of spend
// and at least `verdictWindowMin` rupees. Early days (learning, or a restart after duplicating an ad set) drop out.
export function recentWindow(t, s) {
  const need = Math.max(s.verdictWindowMin, t.spend * s.verdictWindowShare);
  let spend = 0, gmv = 0, from = null;
  for (let i = t.days.length - 1; i >= 0; i--) {
    spend += t.days[i].spend; gmv += t.days[i].gmv; from = t.days[i].date;
    if (spend >= need) break;
  }
  return { spend, gmv, from, sgmv: pct(spend, gmv), full: spend >= need && spend < t.spend };
}

// The lower of lifetime and recent Spend/GMV, and which one it was.
export function bestOf(lifetime, recent) {
  if (recent === null || recent === undefined) return { value: lifetime ?? null, basis: 'lifetime' };
  if (lifetime === null || lifetime === undefined) return { value: recent, basis: 'recent' };
  return recent < lifetime ? { value: recent, basis: 'recent' } : { value: lifetime, basis: 'lifetime' };
}

// Spend/GMV over the last `share` of a day list's spend (no rupee minimum). Used to see a trend at a point in time.
function lastShare(days, share) {
  const total = days.reduce((a, d) => a + d.spend, 0);
  let sp = 0, g = 0;
  for (let i = days.length - 1; i >= 0; i--) { sp += days[i].spend; g += days[i].gmv; if (sp >= total * share) break; }
  return pct(sp, g);
}

// Khoj product page: https://khoj.shopdeck.com/<title-slug>/catalogue/<product id>/<sku id>
export function productUrl(p, base) {
  if (!p || !p.id) return null;
  const slug = String(p.title || 'product').replace(/[^A-Za-z0-9]/g, '-');
  const sku = p.skus && p.skus[0];
  return `${String(base || 'https://khoj.shopdeck.com').replace(/\/+$/, '')}/${slug}/catalogue/${encodeURIComponent(p.id)}${sku ? '/' + encodeURIComponent(sku) : ''}`;
}

function decideTrial(t, s, ctx) {
  const bar = s.winBar;
  const extended = ctx.extended.has(t.id);
  const aov = t.product?.aov || ctx.catAov[t.cat] || null;
  const targetCpp = aov ? (bar / 100) * aov : null;
  t.targetCpp = targetCpp;
  t.extended = extended;
  const rec = recentWindow(t, s);
  t.recent = rec;
  // Verdicts use the better (lower) of lifetime and recent Spend/GMV, so neither a slow start nor a late dip sinks a product.
  const best = bestOf(t.sgmv, rec.full ? rec.sgmv : null);
  const vs = best.value;
  t.verdictSgmv = vs; t.verdictBasis = best.basis;
  const tag = (x) => (x === null ? 'no GMV' : p0(x));
  const why = !rec.full ? `Spend/GMV ${tag(t.sgmv)}`
    : best.basis === 'recent' ? `recent Spend/GMV ${tag(rec.sgmv)} on the last ${inr(rec.spend)} (lifetime ${tag(t.sgmv)})`
    : `lifetime Spend/GMV ${tag(t.sgmv)} (recent ${tag(rec.sgmv)})`;
  if (t.spend >= s.verdictSpend) {
    if (vs !== null && vs <= bar) return { action: 'graduate', reason: `${why}: ≤ ${bar}%` };
    if (extended) {
      if (t.spend >= s.extendedVerdictSpend) return { action: 'kill', reason: `${why}: still above ${bar}% at ${inr(s.extendedVerdictSpend)} after extension` };
      return { action: 'continue', reason: `Extended. ${why}; graduates as soon as it is ≤ ${bar}%, verdict by ${inr(s.extendedVerdictSpend)}`, watch: true };
    }
    if (vs !== null && vs <= s.retestMax) return { action: 'extend', reason: `${why}: inside the ${bar}–${s.retestMax}% retest band` };
    return { action: 'kill', reason: `${why}: above ${s.retestMax}% at ${inr(s.verdictSpend)}` };
  }
  const sg = t.sgmv;
  const sgTxt = sg === null ? 'no GMV' : 'Spend/GMV ' + p0(sg);
  if (t.spend >= s.earlyGateSpend) {
    if (t.ctr !== null && t.ctr < s.minCtr) return { action: 'kill', reason: `CTR ${t.ctr.toFixed(2)}% < ${s.minCtr}% after ${inr(t.spend)}` };
    if (t.atc === 0) return { action: 'kill', reason: `No add-to-carts after ${inr(t.spend)}` };
  }
  const noOrders = t.purchases !== null ? t.purchases === 0 : t.gmv === 0;
  if (noOrders && targetCpp && t.spend >= s.zeroOrderCppMultiple * targetCpp) {
    return { action: 'kill', reason: `0 orders after ${inr(t.spend)} (${s.zeroOrderCppMultiple}× target CPP = ${inr(s.zeroOrderCppMultiple * targetCpp)})` };
  }
  const limit = s.verdictSpend;
  let reason;
  if (t.spend < s.earlyGateSpend) reason = `Too early: first gate at ${inr(s.earlyGateSpend)}`;
  else if (sg === null) reason = `No orders yet; verdict at ${inr(limit)}`;
  else if (sg > bar) reason = `${sgTxt} above ${bar}%, no kill gate hit; verdict at ${inr(limit)}`;
  else reason = `${sgTxt} within ${bar}%; verdict at ${inr(limit)}`;
  if (extended) reason = 'Extended. ' + reason;
  return { action: 'continue', reason, watch: sg !== null && sg > bar };
}

function nearestStep(ladder, b) {
  let best = 0;
  for (let i = 0; i < ladder.length; i++) if (Math.abs(ladder[i] - b) < Math.abs(ladder[best] - b)) best = i;
  return best;
}

function decideScale(a, s) {
  const L = s.ladder;
  const days = a.days.filter((d) => d.spend > 0 || d.budget);
  // Without a daily_budget column, a day's spend is snapped to the nearest ladder step.
  const budgetOf = (d) => d.budget ?? L[nearestStep(L, d.spend)];
  const cur = days.at(-1) ? budgetOf(days.at(-1)) : null;
  const curRun = [];
  for (let i = days.length - 1; i >= 0 && budgetOf(days[i]) === cur; i--) curRun.unshift(days[i]);
  const prevRun = [];
  const prevBudget = days.length > curRun.length ? budgetOf(days[days.length - curRun.length - 1]) : null;
  for (let i = days.length - curRun.length - 1; i >= 0 && budgetOf(days[i]) === prevBudget; i--) prevRun.unshift(days[i]);
  const avg = (run, k) => (run.length ? run.reduce((x, d) => x + d[k], 0) / run.length : 0);
  const sCur = avg(curRun, 'spend'), gCur = avg(curRun, 'gmv');
  const sPrev = avg(prevRun, 'spend'), gPrev = avg(prevRun, 'gmv');
  let marginal = null;
  if (prevRun.length && gCur - gPrev > 0) marginal = ((sCur - sPrev) / (gCur - gPrev)) * 100;
  else if (gCur > 0) marginal = (sCur / gCur) * 100;
  if (prevRun.length && gCur - gPrev <= 0 && sCur > sPrev) marginal = 999;
  const idx = cur !== null ? nearestStep(L, cur) : 0;
  a.budget = cur; a.step = idx + 1; a.steps = L.length; a.marginal = marginal === 999 ? null : marginal;
  a.marginalNote = marginal === 999 ? 'extra spend added no GMV' : null;
  a.daysAtStep = curRun.length;

  const tail = a.days.slice(-s.lifecycleDays);
  const tailS = tail.reduce((x, d) => x + d.spend, 0), tailG = tail.reduce((x, d) => x + d.gmv, 0);
  const atFloor = tail.length >= s.lifecycleDays && tail.every((d) => budgetOf(d) <= L[0] * 1.05);
  if (!a.active) return { action: 'paused', reason: 'Ad set not active' };
  if (atFloor && pct(tailS, tailG) !== null && pct(tailS, tailG) > s.winBar) {
    return { action: 'lifecycle', reason: `${s.lifecycleDays} days above ${s.winBar}% Spend/GMV at the floor budget` };
  }
  if (curRun.length < s.stepDays) return { action: 'hold', reason: `Learning at this step (${curRun.length} of ${s.stepDays} days)` };
  if (marginal === null) return { action: 'hold', reason: 'No GMV at this step yet' };
  const mTxt = marginal === 999 ? 'extra spend added no GMV' : 'marginal Spend/GMV ' + p0(marginal);
  if (marginal < s.stepUpBelow) {
    if (idx < L.length - 1) return { action: 'up', to: L[idx + 1], reason: `${mTxt} < ${s.stepUpBelow}%` };
    return { action: 'hold', reason: `Top of ladder; ${mTxt}` };
  }
  if (marginal <= s.winBar) return { action: 'hold', reason: `${mTxt} between ${s.stepUpBelow}% and ${s.winBar}%` };
  if (idx > 0) return { action: 'down', to: L[idx - 1], ceiling: L[idx - 1], reason: `${mTxt} above ${s.winBar}%; ceiling ≈ ${inr(L[idx - 1])}/day` };
  return { action: 'hold', reason: `${mTxt} above ${s.winBar}% at the floor; lifecycle check running` };
}

// ---------- product signal (product-wise, day-wise spend across all campaigns incl. catalog: Q16674) ----------
// Spend/GMV here is accurate, so no Meta correction is applied.
// Step 1, eligibility: lifetime spend (every day in the question) at least `catalogMinSpend`.
// Step 2, performance: Spend/GMV over the most recent `signalWindowShare` of spend (at least `signalWindowMin`),
// the same idea as the trial verdict window, so early days don't decide the read.
// Accepts product_spend/spend, product_gmv/gmv, or a Spend/GMV column (fraction or percent) when GMV is missing.
function buildCatalog(rows, idx, s, isTested, opts = {}) {
  const factor = opts.gmvFactor > 0 ? opts.gmvFactor : 1;
  const map = new Map();
  let minDate = null, maxDate = null;
  for (const r of rows) {
    const d = day(r.date || r.spend_date);
    if (d) { if (!minDate || d < minDate) minDate = d; if (!maxDate || d > maxDate) maxDate = d; }
    const p = resolveProduct(r, idx);
    const key = p ? p.id : String(r.product_id || r.sku_id || r.product_code || '');
    if (!key) continue;
    let g = map.get(key);
    if (!g) { g = { key, product: p, byDate: new Map() }; map.set(key, g); }
    const spend = num(r.product_spend) ?? num(r.spend) ?? 0;
    let gmv = num(r.product_gmv) ?? num(r.gmv) ?? num(r.purchase_value);
    if (gmv === null) {
      const ratio = num(r.product_spend_gmv) ?? num(r.s_gmv) ?? num(r.spend_gmv) ?? num(r.speng_gmv);
      if (ratio !== null && ratio > 0) gmv = spend / (ratio > 1.5 ? ratio / 100 : ratio);
    }
    const cur = g.byDate.get(d || '') || { date: d, spend: 0, gmv: 0 };
    cur.spend += spend; cur.gmv += (gmv || 0) / factor;
    g.byDate.set(d || '', cur);
  }
  const items = [...map.values()].map((g) => {
    const days = [...g.byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const spend = days.reduce((a, x) => a + x.spend, 0);
    const gmv = days.reduce((a, x) => a + x.gmv, 0);
    const need = Math.max(s.signalWindowMin, spend * s.signalWindowShare);
    let rs = 0, rg = 0, from = null;
    for (let i = days.length - 1; i >= 0; i--) { rs += days[i].spend; rg += days[i].gmv; from = days[i].date; if (rs >= need) break; }
    const recentOk = rs >= need && rs < spend;
    const best = bestOf(pct(spend, gmv), recentOk ? pct(rs, rg) : null);
    const read = spend < s.catalogMinSpend ? 'thin' : best.value !== null && best.value <= s.winBar ? 'hit' : 'miss';
    return {
      productId: g.product?.id || g.key, name: g.product?.title || g.key, cat: g.product?.cat || 'Other',
      hero: !!g.product?.hero, live: !!g.product?.live, linked: !!g.product, url: productUrl(g.product, s.khojBaseUrl),
      spend, gmv, lifetimeSgmv: pct(spend, gmv), recentSgmv: recentOk ? pct(rs, rg) : null,
      sgmv: best.value, basis: best.basis, recentSpend: recentOk ? rs : null, recentFrom: recentOk ? from : null,
      read, trialed: g.product ? isTested(g.product) : false, days
    };
  }).sort((a, b) => b.spend - a.spend);
  const byProduct = new Map(items.map((i) => [i.productId, i]));
  return { items, byProduct, from: minDate, to: maxDate, unlinked: items.filter((i) => !i.linked && i.read !== 'thin').length };
}

// Product signal counts per category, leaving out products already in testing.
function signalSummary(sig) {
  return TEST_CATEGORIES.concat(['Other']).map((c) => {
    const xs = sig.items.filter((i) => i.cat === c && !i.trialed);
    const readable = xs.filter((i) => i.read !== 'thin');
    return { key: c, withSpend: xs.length, readable: readable.length, hits: readable.filter((i) => i.read === 'hit').length, queued: readable.filter((i) => i.read === 'hit' && i.live).length };
  });
}

// ---------- main ----------
export function compute(src, s, history, today = todayIST()) {
  const notes = [];
  const pqMap = pqByKhojId(src.universe?.rows || []);
  const idx = buildProducts(src.products.rows, s, pqMap);
  if (!pqMap.size && !(src.products.rows[0] && ('seller_product_pq' in src.products.rows[0] || 'pq' in src.products.rows[0])))
    notes.push(`No product PQ available (universe question not loaded or aggregated), so the hero PQ ≥ ${s.heroMinPq} bar isn't applied to Khoj products.`);
  const { products } = idx;
  // Products question health: required columns present, and numbers actually parse.
  const prow = src.products.rows;
  if (prow.length) {
    const REQUIRED = ['khoj_product_id', 'khoj_cust_sku_ids', 'product_title', 'current_status', 'l30d_spend', 'l30d_orders', 'profit_pct_d40_d10', 'khoj_category_l2', 'khoj_category_l3', 'khoj_category_l4'];
    const seen = new Set(Object.keys(prow[0]));
    const missing = REQUIRED.filter((c) => !seen.has(c));
    if (missing.length) notes.push(`Products question is missing column(s) ${missing.join(', ')}. Columns received: ${[...seen].join(', ')}.`);
    for (const c of ['l30d_spend', 'l30d_orders', 'profit_pct_d40_d10']) {
      if (!seen.has(c)) continue;
      const bad = prow.filter((r) => r[c] !== null && r[c] !== '' && r[c] !== undefined && num(r[c]) === null).length;
      if (bad) notes.push(`${bad.toLocaleString('en-IN')} of ${prow.length.toLocaleString('en-IN')} products have an unreadable ${c} (e.g. “${prow.find((r) => r[c] !== null && r[c] !== '' && num(r[c]) === null)[c]}”). Those products can't qualify as hero.`);
    }
    if (products.length < prow.length) notes.push(`${(prow.length - products.length).toLocaleString('en-IN')} product rows have no khoj_product_id and were skipped.`);
  }
  const coverageRows = coverage(products);
  const catAov = {};
  for (const c of CATS_ALL) {
    const ps = products.filter((p) => p.cat === c);
    catAov[c] = median(ps.filter((p) => p.hero).map((p) => p.aov)) ?? median(ps.map((p) => p.aov));
  }

  const extended = new Set(history.filter((d) => d.action === 'extend').map((d) => d.adset_id));
  const finalByAdset = new Map();
  const finalReason = new Map();
  for (const d of [...history].reverse()) if (['kill', 'graduate', 'stopped'].includes(d.action)) { finalByAdset.set(d.adset_id, d.action); finalReason.set(d.adset_id, d.reason); }
  const lifecycleProducts = new Set(history.filter((d) => d.action === 'lifecycle').map((d) => d.product_id));

  const tm = s.testingMatch.toLowerCase(), sm = s.scaleMatch.toLowerCase();
  const isTrial = (r) => String(r.campaign_name || '').toLowerCase().includes(tm);
  const isScale = (r) => !isTrial(r) && String(r.campaign_name || '').toLowerCase().includes(sm);
  // A trial is one product: its original ad set and any "– Copy" duplicates are summed together.
  // Link ad sets to products through the ad set → product map; an original and its "– Copy" share the link by name.
  const adsetMap = buildAdsetMap(src.adsetMap?.rows || [], src.ads.rows, idx, (r) => isTrial(r) || isScale(r));
  const nameProduct = new Map();
  for (const r of src.ads.rows) {
    const p = adsetMap.map.get(String(r.adset_id));
    if (p && (isTrial(r) || isScale(r))) nameProduct.set(normName(r.adset_name).toLowerCase(), p);
  }
  const adRows = src.ads.rows.map((r) => {
    const p = adsetMap.map.get(String(r.adset_id)) || ((isTrial(r) || isScale(r)) ? nameProduct.get(normName(r.adset_name).toLowerCase()) : null);
    return p ? { ...r, _product: p } : r;
  });
  if (adsetMap.rejected) notes.push(`${adsetMap.rejected} trial/scale ad set(s) in the ad set → product map were ignored: their top product had under 50% of the ad set's spend and its title doesn't match the ad set name.`);

  const { refDate, lastDate } = referenceDate(src.ads.rows);
  if (refDate && lastDate && refDate < lastDate) notes.push(`Ad data after ${refDate} looks incomplete (almost no spend), so ad sets are judged as of ${refDate}.`);
  const trials = groupAdsets(adRows.filter(isTrial), idx, s,
    (r, p) => (p ? 'p:' + p.id : 'n:' + normName(r.adset_name).toLowerCase()), refDate);
  const scales = groupAdsets(adRows.filter(isScale), idx, s, (_r, _p, adsetId) => 'a:' + adsetId, refDate);
  const unmatched = [...trials, ...scales].filter((a) => !a.product);
  if (unmatched.length) notes.push(`${unmatched.length} trial/scale ad set group(s) aren't linked to a Khoj product (not in the ad set → product map, or its match was too weak), so they count in trial decisions but not in hero coverage or Success% by source.`);

  const ctx = { extended, catAov };
  const closedNow = [];
  for (const t of trials) {
    const d = decideTrial(t, s, ctx);
    const prior = finalByAdset.get(t.id);
    if (t.active) { t.decision = d; continue; }
    t.closed = true;
    if (prior) t.decision = { action: prior === 'graduate' ? 'graduated' : prior === 'stopped' ? 'stopped' : 'killed', reason: finalReason.get(t.id) || 'Closed' };
    else if (d.action === 'kill' || d.action === 'graduate') {
      t.decision = { action: d.action === 'kill' ? 'killed' : 'graduated', reason: d.reason + ' (ad sets already paused)' };
      closedNow.push({ t, action: d.action, reason: t.decision.reason });
    } else {
      const sgTxt = t.sgmv === null ? 'no GMV' : 'Spend/GMV ' + p0(t.sgmv);
      t.decision = { action: 'stopped', reason: `Paused at ${inr(t.spend)}, before the ${inr(t.extended ? s.extendedVerdictSpend : s.verdictSpend)} verdict (${sgTxt})` };
      closedNow.push({ t, action: 'stopped', reason: t.decision.reason });
    }
  }
  for (const a of scales) a.decision = decideScale(a, s);

  const trialedIds = new Set(trials.filter((t) => t.product).map((t) => t.product.id));
  // For trials still not linked to a product, treat a product as tested when its title contains every distinctive word
  // of the trial's name. The same product is often listed by several sellers under one title: once one is tested, all are.
  const unlinkedSigs = trials.filter((t) => !t.product).map((t) => words(t.name)).filter((w) => w.length >= 2);
  const titleKey = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const testedTitles = new Set(trials.filter((t) => t.product).map((t) => titleKey(t.product.title)));
  const looksTested = (p) => { const tw = new Set(words(p.title)); return unlinkedSigs.some((sig) => sig.every((w) => tw.has(w))); };
  const isTested = (p) => trialedIds.has(p.id) || testedTitles.has(titleKey(p.title)) || looksTested(p);

  // Product signal: spend distributed to products by PPO (product-wise spend question).
  const catalog = buildCatalog(src.catalog.rows, idx, s, isTested);
  if (catalog.unlinked) notes.push(`${catalog.unlinked} product(s) in the product-wise spend question with enough spend don't match a Khoj product id or SKU id in the products question.`);

  // product outcome status
  const statusOf = new Map();
  const set = (id, st, rank) => { const cur = statusOf.get(id); if (!cur || cur.rank < rank) statusOf.set(id, { st, rank }); };
  for (const t of trials) {
    if (!t.product) continue;
    const a = t.decision.action;
    if (a === 'continue' || a === 'extend') set(t.product.id, 'testing', 2);
    else if (a === 'graduate' || a === 'graduated') set(t.product.id, 'scaling', 4);
    else if (a === 'kill' || a === 'killed' || a === 'stopped') set(t.product.id, 'killed', 1);
  }
  for (const a of scales) {
    if (!a.product) continue;
    if (a.decision.action === 'lifecycle' || lifecycleProducts.has(a.product.id)) set(a.product.id, 'lifecycle', 3);
    else if (a.active) set(a.product.id, 'scaling', 4);
  }
  for (const id of lifecycleProducts) set(id, 'lifecycle', 3);

  const pipeline = CATS_ALL.map((c) => {
    const ps = products.filter((p) => p.cat === c);
    const hero = ps.filter((p) => p.hero);
    const count = (st, list = ps) => list.filter((p) => statusOf.get(p.id)?.st === st).length;
    const win = count('scaling'), life = count('lifecycle'), kill = count('killed'), live = count('testing');
    const heroTested = hero.filter((p) => statusOf.has(p.id)).length;
    return { key: c, hero: hero.length, heroTested, notTested: hero.length - heroTested, testing: live, scaling: win, lifecycle: life, killed: kill };
  });
  const bySource = ['A', 'B', 'control'].map((k) => {
    const ps = products.filter((p) => statusOf.has(p.id) && (k === 'control' ? !p.hero : p.tier === k));
    const w = ps.filter((p) => ['scaling', 'lifecycle'].includes(statusOf.get(p.id).st)).length;
    const kd = ps.filter((p) => statusOf.get(p.id).st === 'killed').length;
    return { key: k, decided: w + kd, winners: w };
  });

  // ---------- tasks + decisions ----------
  const tasks = [];
  const decisions = [];
  const label = (t) => t.product?.title || t.name;
  const where = (t) => {
    const live = (t.activeAdsets && t.activeAdsets.length ? t.activeAdsets : [...(t.adsets?.values() || [])]);
    const camps = [...new Set(live.map((a) => a.campaign))];
    return `${live.length > 1 ? live.length + ' ad sets' : 'ad set'} “${t.name}” in ${camps.map((c) => `“${c}”`).join(' and ')}`;
  };
  const sku = (t) => (t.product?.skus?.length ? `SKU ${t.product.skus.join(', ')}` : 'the product');
  for (const { t, action, reason } of closedNow) {
    decisions.push({ adset_id: t.id, product_id: t.product?.id || null, product_name: label(t), category: t.cat, key: `${action === 'stopped' ? 'stopped' : action}:${t.id}`, action: action === 'stopped' ? 'stopped' : action, reason });
  }
  for (const t of trials) {
    if (t.firstDate) decisions.push({ adset_id: t.id, product_id: t.product?.id || null, product_name: label(t), category: t.cat, key: `start:${t.id}`, action: 'start', reason: `Trial started ${t.firstDate}` });
    if (t.closed) continue;
    const a = t.decision.action;
    const base = { adset_id: t.id, product_id: t.product?.id || null, product_name: label(t), category: t.cat };
    if (a === 'kill') {
      tasks.push({ id: `kill:${t.id}`, segment: 'kill', category: t.cat, due: today,
        title: `Pause ${where(t)}`, detail: `${t.decision.reason}. Add ${sku(t)} to the Killed product set.` });
      decisions.push({ ...base, key: `kill:${t.id}`, action: 'kill', reason: t.decision.reason });
    } else if (a === 'graduate') {
      tasks.push({ id: `grad:${t.id}`, segment: 'scale', category: t.cat, due: today,
        title: `Graduate ${label(t)} to Scale | ${t.cat}`, detail: `New ad set at ${inr(s.graduateBudget)}/day with the same post IDs. Add ${sku(t)} to the Winners product set.` });
      tasks.push({ id: `gradoff:${t.id}`, segment: 'scale', category: t.cat, due: addDays(today, s.overlapDays),
        title: `Pause trial ${where(t)}`, detail: `After ${s.overlapDays} days of overlap with the new scale ad set.` });
      decisions.push({ ...base, key: `graduate:${t.id}`, action: 'graduate', reason: t.decision.reason });
    } else if (a === 'extend' || (a === 'continue' && t.extended)) {
      tasks.push({ id: `ext:${t.id}`, segment: 'scale', category: t.cat, due: today,
        title: `Extend ${label(t)} trial to ${inr(s.extendedVerdictSpend)}`, detail: `No change in Ads Manager: keep ${inr(s.trialDailyBudget)}/day. Next verdict at ${inr(s.extendedVerdictSpend)}.` });
      if (a === 'extend') decisions.push({ ...base, key: `extend:${t.id}`, action: 'extend', reason: t.decision.reason });
    }
  }
  for (const a of scales) {
    const d = a.decision;
    const base = { adset_id: a.id, product_id: a.product?.id || null, product_name: a.product?.title || a.name, category: a.cat };
    if (d.action === 'up' || d.action === 'down') {
      const verb = d.action === 'up' ? 'Step up' : 'Step down';
      tasks.push({ id: `step:${a.id}:${d.to}`, segment: 'scale', category: a.cat, due: today,
        title: `${verb} ${base.product_name}: ${inr(a.budget)} → ${inr(d.to)}/day`, detail: d.reason });
      decisions.push({ ...base, key: `step:${a.id}:${a.budget}->${d.to}`, action: d.action === 'up' ? 'step_up' : 'step_down', reason: d.reason });
    } else if (d.action === 'lifecycle') {
      tasks.push({ id: `life:${a.id}`, segment: 'kill', category: a.cat, due: today,
        title: `Pause scale ad set “${a.name}”: lifecycle ended`, detail: d.reason });
      decisions.push({ ...base, key: `lifecycle:${a.id}`, action: 'lifecycle', reason: d.reason });
    }
  }

  // new trials to fill free slots; product signal hits go first
  const catalogHit = new Map();
  for (const c of catalog.items) if (c.read === 'hit' && !catalogHit.has(c.productId)) catalogHit.set(c.productId, { ...c, view: 'PPO-distributed' });
  const everTrialed = trials.length;
  const controlEvery = s.controlShare > 0 ? Math.max(2, Math.round(100 / s.controlShare)) : Infinity;
  let pickCounter = everTrialed;
  const queue = {};
  for (const c of TEST_CATEGORIES) {
    const running = trials.filter((t) => t.cat === c && !t.closed && ['continue', 'extend'].includes(t.decision.action)).length;
    const free = Math.max(0, s.slotsPerCategory - running);
    const pool = products.filter((p) => p.cat === c && p.live && !isTested(p));
    const heroQ = pool.filter((p) => p.hero).map((p) => {
      const ch = catalogHit.get(p.id);
      return { p, source: ch ? 'catalog' : p.tier === 'A' ? 'tierA' : 'tierB', score: ch ? 3e9 - (ch.sgmv || 0) : p.tier === 'A' ? 2e9 + p.orders : 1e9 + (p.profit || 0) * 1000 + p.orders };
    }).sort((a, b) => b.score - a.score);
    const ctrlQ = pool.filter((p) => !p.hero && p.orders < s.heroOrdersMin)
      .map((p) => ({ p, source: 'control', score: hash(p.id) })).sort((a, b) => a.score - b.score);
    queue[c] = { free, running, heroQueue: heroQ.length, controlQueue: ctrlQ.length };
    let hi = 0, ci = 0;
    for (let i = 0; i < free; i++) {
      pickCounter++;
      const useControl = pickCounter % controlEvery === 0 && ci < ctrlQ.length;
      const pick = useControl ? ctrlQ[ci++] : heroQ[hi++] || ctrlQ[ci++];
      if (!pick) break;
      const p = pick.p;
      const ch = catalogHit.get(p.id);
      const srcTxt = pick.source === 'catalog' ? `product signal, ${ch.view} (Spend/GMV ${p0(ch.sgmv)}, ${inr(ch.spend)} lifetime spend)`
        : pick.source === 'tierA' ? `hero, ${p.orders.toLocaleString('en-IN')} seller orders in 30 days`
        : pick.source === 'tierB' ? `hero, ${p.orders} seller orders, profit ${p.profit?.toFixed(1)}%`
        : 'control group (no seller demand proof)';
      tasks.push({ id: `trial:${p.id}`, segment: 'trial', category: c, due: today, url: productUrl(p, s.khojBaseUrl),
        title: `Start trial: ${p.title.slice(0, 90)}`,
        detail: `Product ${p.code}, SKU ${p.skus.join(', ') || '—'}. Source: ${srcTxt}. ${inr(s.trialDailyBudget)}/day, 3 statics.` });
    }
  }

  // ---------- view models ----------
  const trialRows = trials.map((t) => ({
    closed: !!t.closed, lastSpendDate: [...t.adsets.values()].map((a) => a.lastSpendDate).filter(Boolean).sort().at(-1) || null,
    id: t.id, name: t.name, product: t.product?.title || null, code: t.product?.code || null, cat: t.cat,
    url: productUrl(t.product, s.khojBaseUrl), verdictSgmv: t.verdictSgmv ?? null, verdictBasis: t.verdictBasis || null, productId: t.product?.id || null,
    adsetCount: t.adsets.size, activeAdsetCount: t.activeAdsets.length, firstDate: t.firstDate,
    tier: t.product ? (t.product.hero ? t.product.tier : 'control') : null,
    days: t.dayCount, spend: t.spend, gmv: t.gmv, purchases: t.purchases, atc: t.atc, ctr: t.ctr, sgmv: t.sgmv,
    recentSgmv: t.recent?.full ? t.recent.sgmv : null, recentSpend: t.recent?.full ? t.recent.spend : null, recentFrom: t.recent?.full ? t.recent.from : null,
    targetCpp: t.targetCpp, cpp: t.purchases ? t.spend / t.purchases : null,
    limit: t.extended ? s.extendedVerdictSpend : s.verdictSpend, extended: t.extended,
    action: t.decision.action, reason: t.decision.reason, watch: !!t.decision.watch, active: t.active
  }));
  const ladderRows = scales.map((a) => ({
    id: a.id, name: a.name, product: a.product?.title || null, cat: a.cat, url: productUrl(a.product, s.khojBaseUrl),
    budget: a.budget, step: a.step, steps: a.steps, marginal: a.marginal, marginalNote: a.marginalNote,
    avg: a.sgmv, days: a.dayCount, daysAtStep: a.daysAtStep,
    action: a.decision.action, to: a.decision.to || null, reason: a.decision.reason
  }));

  // ---------- kill review: was each closed trial's kill right? ----------
  const killReview = trials.filter((t) => t.closed && ['killed', 'stopped'].includes(t.decision.action)).map((t) => {
    const lastSpend = [...t.adsets.values()].map((a) => a.lastSpendDate).filter(Boolean).sort().at(-1) || null;
    const recent = t.recent?.full ? t.recent.sgmv : null;
    const best = bestOf(t.sgmv, recent).value;
    const lastHalf = lastShare(t.days, 0.5);
    // After the stop: the product's own spend and GMV across all campaigns (PPO-distributed view).
    const sig = t.product ? catalog.byProduct.get(t.product.id) : null;
    const after = sig ? sig.days.filter((d) => d.date && lastSpend && d.date > lastSpend) : [];
    const aSpend = after.reduce((a, d) => a + d.spend, 0), aGmv = after.reduce((a, d) => a + d.gmv, 0);
    const afterSgmv = pct(aSpend, aGmv);
    let verdict, why;
    if (best !== null && best <= s.winBar) { verdict = 'wrong'; why = `Was winning: Spend/GMV ${p0(best)} at stop`; }
    else if (aSpend >= s.signalWindowMin && afterSgmv !== null && afterSgmv <= s.winBar) { verdict = 'wrong'; why = `Did well after the stop: ${p0(afterSgmv)} on ${inr(aSpend)}`; }
    else if (best !== null && best <= s.retestMax) { verdict = 'premature'; why = `Was in the ${s.winBar}–${s.retestMax}% retest band (${p0(best)})`; }
    else if (t.spend < s.verdictSpend && lastHalf !== null && lastHalf <= s.retestMax) { verdict = 'recheck'; why = `Improving when stopped: last half of spend at ${p0(lastHalf)}`; }
    else {
      verdict = 'right';
      why = best === null ? 'No GMV at all' : `Spend/GMV ${p0(best)} at stop${lastHalf !== null ? `, last half ${p0(lastHalf)}` : ''}`;
      if (aSpend > 0) why += aGmv > 0 ? `; after stop ${p0(afterSgmv)} on ${inr(aSpend)}` : `; ${inr(aSpend)} spent after stop with no GMV`;
    }
    return {
      name: t.name, product: t.product?.title || null, url: productUrl(t.product, s.khojBaseUrl), cat: t.cat,
      call: t.decision.action, stoppedOn: lastSpend, spend: t.spend, lifetime: t.sgmv, recent, lastHalf,
      afterSpend: aSpend, afterGmv: aGmv, afterSgmv, verdict, why
    };
  }).sort((a, b) => String(a.stoppedOn).localeCompare(String(b.stoppedOn)));

  // ---------- ShopDeck universe (optional source, e.g. Q16457: all ShopDeck products with PQ ≥ 3) ----------
  // Rows are either one per product (raw or compacted, with `n`) or counts the question already aggregated.
  const uRows = src.universe?.rows || [];
  const universe = {};
  for (const c of CATS_ALL) universe[c] = { all: 0, uploaded: 0, live: 0, hero: 0, heroUploaded: 0, heroLive: 0 };
  let uHasStatus = false;
  const isHeroRow = (r) => {
    const flag = String(r.is_hero ?? '').toLowerCase();
    if (r.is_hero !== undefined && r.is_hero !== null && flag !== '') return ['1', 'true', 'yes', 'y'].includes(flag);
    if (r.l30d_orders === undefined) return false;
    return !!heroTier({ orders: num(r.l30d_orders) || 0, spend: num(r.l30d_spend) || 0, profit: num(r.profit_pct_d40_d10), pq: num(r.pq ?? r.seller_product_pq) }, s);
  };
  for (const r of uRows) {
    if (String(r.seller_id || '').toUpperCase() === 'TOTAL') continue;
    const c = categoryOf(r);
    const U = universe[c];
    if ('sd_products' in r || 'sd_hero_products' in r) {
      U.all += num(r.sd_products) || 0;
      U.hero += num(r.sd_hero_products) || 0;
      if ('live' in r || 'hero_live' in r) {
        uHasStatus = true;
        U.uploaded += num(r.uploaded) || 0; U.live += num(r.live) || 0;
        U.heroUploaded += num(r.hero_uploaded) || 0; U.heroLive += num(r.hero_live) || 0;
      }
      continue;
    }
    const n = r.n !== undefined ? num(r.n) || 0 : 1;
    const up = r.n !== undefined ? num(r.uploaded) || 0 : (r.khoj_product_id ? 1 : 0);
    const lv = r.n !== undefined ? num(r.live) || 0 : (String(r.current_status || '').toLowerCase() === 'live' ? 1 : 0);
    if (r.current_status !== undefined || r.n !== undefined) uHasStatus = true;
    U.all += n; U.uploaded += up; U.live += lv;
    if (n === 1 && isHeroRow(r)) { U.hero += 1; U.heroUploaded += up; U.heroLive += lv; }
  }
  const hasUniverse = uRows.length > 0;

  // ---------- cannibalisation: Khoj buyers who also bought from the product's own seller (Q16494) ----------
  // Its product_id is the seller's product id; the universe question maps it to the Khoj product.
  const sellerToKhoj = new Map();
  for (const r of uRows) if (r.seller_product_id && r.khoj_product_id) sellerToKhoj.set(String(r.seller_product_id), String(r.khoj_product_id));
  const titleBySellerProduct = new Map();
  for (const r of uRows) if (r.seller_product_id && r.product_title) titleBySellerProduct.set(String(r.seller_product_id), r.product_title);
  const oRows = src.overlap?.rows || [];
  let overlap = null;
  const overlapByProduct = new Map();
  if (oRows.length) {
    const items = oRows.map((r) => {
      const spid = String(r.product_id || r.seller_product_id || '');
      const kid = r.khoj_product_id ? String(r.khoj_product_id) : sellerToKhoj.get(spid);
      const p = kid ? idx.byId.get(kid) : null;
      return {
        sellerId: String(r.seller_id || ''), sellerProductId: spid, product: p,
        name: p?.title || titleBySellerProduct.get(spid) || spid, cat: p?.cat || 'Other',
        orders: num(r.khoj_orders) || 0, buyers: num(r.khoj_buyers) || 0, overlap: num(r.overlapping_buyers) || 0
      };
    });
    const sum = (xs, f) => xs.reduce((a, x) => a + x[f], 0);
    const rate = (xs) => { const b = sum(xs, 'buyers'); return b ? sum(xs, 'overlap') / b * 100 : null; };
    const group = (keyOf) => {
      const m = new Map();
      for (const x of items) { const k = keyOf(x); (m.get(k) || m.set(k, []).get(k)).push(x); }
      return [...m.entries()].map(([key, xs]) => ({ key, buyers: sum(xs, 'buyers'), overlap: sum(xs, 'overlap'), pct: rate(xs), products: xs.length }))
        .sort((a, b) => b.buyers - a.buyers);
    };
    const sellers = group((x) => x.sellerId);
    const top = sellers[0];
    const rest = items.filter((x) => x.sellerId !== top?.key);
    for (const x of items) if (x.product) {
      const cur = overlapByProduct.get(x.product.id) || { buyers: 0, overlap: 0 };
      cur.buyers += x.buyers; cur.overlap += x.overlap; overlapByProduct.set(x.product.id, cur);
    }
    overlap = {
      buyers: sum(items, 'buyers'), overlap: sum(items, 'overlap'), orders: sum(items, 'orders'), pct: rate(items),
      sellers: sellers.length, products: items.length, unlinked: items.filter((x) => !x.product).length,
      topSeller: top ? { id: top.key, buyers: top.buyers, overlap: top.overlap, pct: top.pct, shareOfOverlap: sum(items, 'overlap') ? top.overlap / sum(items, 'overlap') * 100 : null } : null,
      pctExTop: rate(rest),
      byCat: group((x) => x.cat),
      byHero: group((x) => (x.product ? (x.product.hero ? 'Hero' : 'Not hero') : 'Not on Khoj list')),
      bySellerSize: group((x) => { const o = x.product?.orders ?? 0; return o >= s.heroOrdersAll ? `${s.heroOrdersAll}+ a month` : o >= s.heroOrdersMin ? `${s.heroOrdersMin}–${s.heroOrdersAll - 1} a month` : `Under ${s.heroOrdersMin} a month`; }),
      bySeller: sellers.slice(0, 15),
      topProducts: [...items].sort((a, b) => b.buyers - a.buyers).slice(0, 25).map((x) => ({
        name: x.name, url: productUrl(x.product, s.khojBaseUrl), cat: x.cat, sellerId: x.sellerId, buyers: x.buyers, overlap: x.overlap,
        pct: x.buyers ? x.overlap / x.buyers * 100 : null, tested: x.product ? isTested(x.product) : false
      }))
    };
  }

  for (const r of trialRows) {
    const o = r.productId ? overlapByProduct.get(r.productId) : null;
    r.sellerOverlap = o && o.buyers ? { pct: o.overlap / o.buyers * 100, buyers: o.buyers, overlap: o.overlap } : null;
  }

  // ---------- headline numbers by category (front end sums the selected scope and all categories) ----------
  const isWin = (a) => a === 'graduate' || a === 'graduated';
  const isLoss = (a) => a === 'kill' || a === 'killed' || a === 'stopped';
  const kpis = {};
  for (const c of CATS_ALL) {
    const cov = coverageRows.find((r) => r.key === c);
    const ts = trials.filter((t) => t.cat === c);
    const scalingIds = new Set();
    for (const t of ts) if (isWin(t.decision.action)) scalingIds.add(t.product ? 'p:' + t.product.id : t.id);
    for (const a of scales) if (a.cat === c && a.active && a.decision.action !== 'lifecycle') scalingIds.add(a.product ? 'p:' + a.product.id : a.id);
    kpis[c] = {
      live: cov.live, heroLive: cov.heroLive, khojHero: cov.hero,
      universeHero: hasUniverse ? universe[c].hero : null, universeHeroLive: hasUniverse && uHasStatus ? universe[c].heroLive : null,
      universeAll: hasUniverse ? universe[c].all : null,
      tested: ts.length, winners: ts.filter((t) => isWin(t.decision.action)).length, losses: ts.filter((t) => isLoss(t.decision.action)).length,
      liveTrials: ts.filter((t) => !t.closed).length,
      scaling: scalingIds.size
    };
  }

  // ---------- Khoj buyers' ShopDeck order history (Q16717): audience, repeat, cross-selling ----------
  let customers = null;
  const khojToSellerProduct = new Map(), sellerProductCat = new Map();
  for (const r of uRows) {
    if (r.khoj_product_id && r.seller_product_id) khojToSellerProduct.set(String(r.khoj_product_id), String(r.seller_product_id));
    if (r.seller_product_id && r.category_l4) sellerProductCat.set(String(r.seller_product_id), { l4: r.category_l4, cat: categoryOf(r) });
  }
  if (src.history?.rows?.length) {
    customers = analyseHistory(src.history.rows, { khojSellerId: s.khojSellerId, sessionMinutes: s.sessionMinutes, idx, khojToSellerProduct, sellerProductCat, browsing: src.browsing?.rows || [], productUrl: (p) => productUrl(p, s.khojBaseUrl) });
    if (customers?.error) notes.push(customers.error);
  }

  // ---------- Khoj vs parent sellers' own sites, weighted by Khoj orders (site events, repeat benchmark) ----------
  const weights = khojOrderWeights(src.history?.rows || [], s.khojSellerId, idx);
  const sessions = src.events?.rows?.length ? analyseEvents(src.events.rows, { khojSellerId: s.khojSellerId, weights, idx, khojToSellerProduct, sellerProductCat, historyRows: src.history?.rows || [] }) : null;
  const visitorPersonalisation = src.personalise?.rows?.length ? analyseVisitorPersonalisation(src.personalise.rows) : null;
  const repeatBench = src.benchmark?.rows?.length ? analyseRepeatBenchmark(src.benchmark.rows, { khojSellerId: s.khojSellerId, weights }) : null;

  return {
    today, catAov, notes, kpis, killReview, overlap, customers, sessions, repeatBench, visitorPersonalisation,
    universe: hasUniverse ? { byCat: universe, hasAll: true, hasStatus: uHasStatus, origin: src.universe.origin } : null,
    activeTrialKeys: trials.filter((t) => t.active).map((t) => t.id),
    coverage: coverageRows,
    pipeline, bySource, queue,
    trials: trialRows, ladder: ladderRows,
    catalog: {
      window: { from: catalog.from, to: catalog.to },
      items: catalog.items.slice(0, 300).map(({ days, ...i }) => i),
      summary: signalSummary(catalog)
    },
    tasks, decisions
  };
}
