// The rules engine: turns source rows + settings + decision history into every view and task.
import { TEST_CATEGORIES, categoryOf } from './categories.js';

const CATS_ALL = [...TEST_CATEGORIES, 'Other'];

export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[,₹%\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}
const day = (v) => (v ? String(v).slice(0, 10) : null);
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

// ---------- products ----------
function buildProducts(rows, s) {
  const products = [];
  const byId = new Map();
  const byCode = new Map();
  for (const r of rows) {
    const spend = num(r.l30d_spend) || 0;
    const orders = num(r.l30d_orders) || 0;
    const sg = num(r.l30d_s_gmv);
    const profit = num(r.profit_pct_d40_d10);
    const gmv = sg && sg > 0 ? spend / sg : null;
    let tier = null;
    if (orders >= s.heroOrdersAll) tier = 'A';
    else if (orders >= s.heroOrdersMin && profit !== null && profit > s.heroMinProfitPct && spend > s.heroMinSpend) tier = 'B';
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
      tier,
      hero: !!tier
    };
    if (!p.id) continue;
    products.push(p);
    byId.set(p.id, p);
    if (p.code) byCode.set(p.code, p);
  }
  return { products, byId, byCode };
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
function resolveProduct(r, idx) {
  const id = r.product_id || r.khoj_product_id;
  if (id && idx.byId.has(String(id))) return idx.byId.get(String(id));
  const code = r.product_code || r.khoj_product_code;
  if (code && idx.byCode.has(String(code))) return idx.byCode.get(String(code));
  const name = String(r.adset_name || '');
  for (const tok of name.split(/[\s|·,()\[\]/-]+/)) {
    if (tok.length >= 6 && idx.byCode.has(tok)) return idx.byCode.get(tok);
    if (tok.length >= 6 && idx.byId.has(tok)) return idx.byId.get(tok);
  }
  return null;
}

function groupAdsets(rows, idx) {
  const map = new Map();
  for (const r of rows) {
    const id = String(r.adset_id || r.adset_name || '');
    if (!id) continue;
    let g = map.get(id);
    if (!g) {
      g = { id, name: r.adset_name || id, campaign: r.campaign_name || '', product: resolveProduct(r, idx), days: [] };
      map.set(id, g);
    }
    if (!g.product) g.product = resolveProduct(r, idx);
    g.days.push({
      date: day(r.date),
      status: r.adset_status || r.status || '',
      budget: num(r.daily_budget),
      spend: num(r.spend) || 0,
      impressions: num(r.impressions) || 0,
      clicks: num(r.link_clicks) ?? num(r.clicks) ?? 0,
      atc: num(r.add_to_cart) ?? num(r.adds_to_cart) ?? 0,
      purchases: num(r.purchases) ?? num(r.orders) ?? 0,
      gmv: num(r.gmv) ?? num(r.purchase_value) ?? 0
    });
  }
  for (const g of map.values()) {
    g.days.sort((a, b) => (a.date < b.date ? -1 : 1));
    const t = (k) => g.days.reduce((a, d) => a + (d[k] || 0), 0);
    g.spend = t('spend'); g.impressions = t('impressions'); g.clicks = t('clicks');
    g.atc = t('atc'); g.purchases = t('purchases'); g.gmv = t('gmv');
    g.firstDate = g.days[0]?.date; g.lastDate = g.days.at(-1)?.date;
    g.dayCount = new Set(g.days.filter((d) => d.spend > 0).map((d) => d.date)).size;
    const st = g.days.at(-1)?.status || '';
    g.active = !st || /active|on|running|learning/i.test(st);
    g.sgmv = pct(g.spend, g.gmv);
    g.ctr = pct(g.clicks, g.impressions);
    g.cat = g.product?.cat || TEST_CATEGORIES.find((c) => g.campaign.toLowerCase().includes(c.split(' ')[0].toLowerCase())) || 'Other';
  }
  return [...map.values()];
}

function decideTrial(t, s, ctx) {
  const bar = s.winBar;
  const sg = t.sgmv;
  const extended = ctx.extended.has(t.id);
  const aov = t.product?.aov || ctx.catAov[t.cat] || null;
  const targetCpp = aov ? (bar / 100) * aov : null;
  t.targetCpp = targetCpp;
  t.extended = extended;
  const sgTxt = sg === null ? 'no GMV' : 'Spend/GMV ' + p0(sg);
  if (extended && t.spend >= s.extendedVerdictSpend) {
    return sg !== null && sg <= bar
      ? { action: 'graduate', reason: `${sgTxt} ≤ ${bar}% at ${inr(s.extendedVerdictSpend)} (after extension)` }
      : { action: 'kill', reason: `${sgTxt} above ${bar}% at ${inr(s.extendedVerdictSpend)} (after extension)` };
  }
  if (!extended && t.spend >= s.verdictSpend) {
    if (sg !== null && sg <= bar) return { action: 'graduate', reason: `${sgTxt} ≤ ${bar}% at ${inr(s.verdictSpend)}` };
    if (sg !== null && sg <= s.retestMax) return { action: 'extend', reason: `${sgTxt} inside the ${bar}–${s.retestMax}% retest band at ${inr(s.verdictSpend)}` };
    return { action: 'kill', reason: `${sgTxt} above ${s.retestMax}% at ${inr(s.verdictSpend)}` };
  }
  if (t.spend >= s.earlyGateSpend) {
    if (t.ctr !== null && t.ctr < s.minCtr) return { action: 'kill', reason: `CTR ${t.ctr.toFixed(2)}% < ${s.minCtr}% after ${inr(t.spend)}` };
    if (t.atc === 0) return { action: 'kill', reason: `No add-to-carts after ${inr(t.spend)}` };
  }
  if (t.purchases === 0 && targetCpp && t.spend >= s.zeroOrderCppMultiple * targetCpp) {
    return { action: 'kill', reason: `0 orders after ${inr(t.spend)} (${s.zeroOrderCppMultiple}× target CPP = ${inr(s.zeroOrderCppMultiple * targetCpp)})` };
  }
  const limit = extended ? s.extendedVerdictSpend : s.verdictSpend;
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
  const budgetOf = (d) => d.budget ?? d.spend;
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

// ---------- catalog ----------
function buildCatalog(rows, idx, s, trialedIds) {
  const dates = rows.map((r) => day(r.date)).filter(Boolean).sort();
  const maxDate = dates.at(-1);
  const from = maxDate ? addDays(maxDate, -(s.catalogWindowDays - 1)) : null;
  const map = new Map();
  for (const r of rows) {
    const d = day(r.date);
    if (from && d && d < from) continue;
    const p = resolveProduct(r, idx);
    const key = p ? p.id : String(r.product_id || r.product_code || '');
    if (!key) continue;
    let g = map.get(key);
    if (!g) { g = { key, product: p, spend: 0, purchases: 0, gmv: 0, clicks: 0, impressions: 0 }; map.set(key, g); }
    g.spend += num(r.spend) || 0;
    g.purchases += num(r.purchases) ?? num(r.orders) ?? 0;
    g.gmv += num(r.gmv) ?? num(r.purchase_value) ?? 0;
    g.clicks += num(r.link_clicks) ?? 0;
    g.impressions += num(r.impressions) ?? 0;
  }
  const items = [...map.values()].map((g) => {
    const sg = pct(g.spend, g.gmv);
    const read = g.spend < s.catalogMinSpend ? 'thin' : sg !== null && sg <= s.winBar ? 'hit' : 'miss';
    return {
      productId: g.product?.id || g.key, name: g.product?.title || g.key, cat: g.product?.cat || 'Other',
      hero: !!g.product?.hero, live: !!g.product?.live,
      spend: g.spend, purchases: g.purchases, gmv: g.gmv, sgmv: sg, read,
      trialed: g.product ? trialedIds.has(g.product.id) : false
    };
  }).sort((a, b) => b.spend - a.spend);
  return { items, from, to: maxDate };
}

// ---------- main ----------
export function compute(src, s, history, today = todayIST()) {
  const notes = [];
  const idx = buildProducts(src.products.rows, s);
  const { products } = idx;
  const catAov = {};
  for (const c of CATS_ALL) {
    const ps = products.filter((p) => p.cat === c);
    catAov[c] = median(ps.filter((p) => p.hero).map((p) => p.aov)) ?? median(ps.map((p) => p.aov));
  }

  const extended = new Set(history.filter((d) => d.action === 'extend').map((d) => d.adset_id));
  const finalByAdset = new Map();
  for (const d of [...history].reverse()) if (['kill', 'graduate'].includes(d.action)) finalByAdset.set(d.adset_id, d.action);
  const lifecycleProducts = new Set(history.filter((d) => d.action === 'lifecycle').map((d) => d.product_id));

  const tm = s.testingMatch.toLowerCase(), sm = s.scaleMatch.toLowerCase();
  const adsets = groupAdsets(src.ads.rows, idx);
  const trials = adsets.filter((a) => a.campaign.toLowerCase().includes(tm));
  const scales = adsets.filter((a) => a.campaign.toLowerCase().includes(sm) && !a.campaign.toLowerCase().includes(tm));
  const unmatched = adsets.filter((a) => !a.product && (trials.includes(a) || scales.includes(a)));
  if (unmatched.length) notes.push(`${unmatched.length} trial/scale ad set(s) could not be matched to a Khoj product (add product_id to the ads question or put the product code in the ad set name).`);

  const ctx = { extended, catAov };
  for (const t of trials) {
    const d = decideTrial(t, s, ctx);
    const prior = finalByAdset.get(t.id);
    if (prior && !t.active) { t.decision = { action: prior === 'kill' ? 'killed' : 'graduated', reason: 'Closed' }; t.closed = true; }
    else t.decision = d;
  }
  for (const a of scales) a.decision = decideScale(a, s);

  const trialedIds = new Set(trials.filter((t) => t.product).map((t) => t.product.id));
  const catalog = buildCatalog(src.catalog.rows, idx, s, trialedIds);

  // product outcome status
  const statusOf = new Map();
  const set = (id, st, rank) => { const cur = statusOf.get(id); if (!cur || cur.rank < rank) statusOf.set(id, { st, rank }); };
  for (const t of trials) {
    if (!t.product) continue;
    const a = t.decision.action;
    if (a === 'continue' || a === 'extend') set(t.product.id, 'testing', 2);
    else if (a === 'graduate' || a === 'graduated') set(t.product.id, 'scaling', 4);
    else if (a === 'kill' || a === 'killed') set(t.product.id, 'killed', 1);
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
  for (const t of trials) {
    if (t.closed) continue;
    const a = t.decision.action;
    const base = { adset_id: t.id, product_id: t.product?.id || null, product_name: label(t), category: t.cat };
    if (a === 'kill') {
      tasks.push({ id: `kill:${t.id}`, segment: 'kill', category: t.cat, due: today,
        title: `Pause ad set “${t.name}”`, detail: `${label(t)}. ${t.decision.reason}. Add ${t.product?.code || 'the product'} to the Killed product set.` });
      decisions.push({ ...base, key: `kill:${t.id}`, action: 'kill', reason: t.decision.reason });
    } else if (a === 'graduate') {
      tasks.push({ id: `grad:${t.id}`, segment: 'scale', category: t.cat, due: today,
        title: `Graduate ${label(t)} to Scale | ${t.cat}`, detail: `New ad set at ${inr(s.graduateBudget)}/day with the same post IDs. Add ${t.product?.code || 'the product'} to the Winners product set.` });
      tasks.push({ id: `gradoff:${t.id}`, segment: 'scale', category: t.cat, due: addDays(today, s.overlapDays),
        title: `Pause trial ad set “${t.name}”`, detail: `After ${s.overlapDays} days of overlap with the new scale ad set.` });
      decisions.push({ ...base, key: `graduate:${t.id}`, action: 'graduate', reason: t.decision.reason });
    } else if (a === 'extend' || (a === 'continue' && t.extended)) {
      tasks.push({ id: `ext:${t.id}`, segment: 'scale', category: t.cat, due: today,
        title: `Extend ${label(t)} trial to ${inr(s.extendedVerdictSpend)}`, detail: `No change in Ads Manager: keep ${inr(s.trialDailyBudget)}/day. Next verdict at ${inr(s.extendedVerdictSpend)}.` });
      if (a === 'extend') decisions.push({ ...base, key: `extend:${t.id}`, action: 'extend', reason: t.decision.reason });
    }
    if (t.product) decisions.push({ ...base, key: `start:${t.id}`, action: 'start', reason: `Trial started ${t.firstDate || ''}`.trim() });
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

  // new trials to fill free slots
  const catalogHit = new Map(catalog.items.filter((c) => c.read === 'hit').map((c) => [c.productId, c]));
  const everTrialed = trials.length;
  const controlEvery = s.controlShare > 0 ? Math.max(2, Math.round(100 / s.controlShare)) : Infinity;
  let pickCounter = everTrialed;
  const queue = {};
  for (const c of TEST_CATEGORIES) {
    const running = trials.filter((t) => t.cat === c && !t.closed && ['continue', 'extend'].includes(t.decision.action)).length;
    const free = Math.max(0, s.slotsPerCategory - running);
    const pool = products.filter((p) => p.cat === c && p.live && !trialedIds.has(p.id));
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
      const srcTxt = pick.source === 'catalog' ? `catalog signal (Spend/GMV ${p0(ch.sgmv)} on ${inr(ch.spend)})`
        : pick.source === 'tierA' ? `hero, ${p.orders.toLocaleString('en-IN')} seller orders in 30 days`
        : pick.source === 'tierB' ? `hero, ${p.orders} seller orders, profit ${p.profit?.toFixed(1)}%`
        : 'control group (no seller demand proof)';
      tasks.push({ id: `trial:${p.id}`, segment: 'trial', category: c, due: today,
        title: `Start trial: ${p.title.slice(0, 90)}`,
        detail: `Product ${p.code}. Source: ${srcTxt}. ${inr(s.trialDailyBudget)}/day, 3 statics, ad set named with ${p.code}.` });
    }
  }

  // ---------- view models ----------
  const trialRows = trials.filter((t) => !t.closed).map((t) => ({
    id: t.id, name: t.name, product: t.product?.title || null, code: t.product?.code || null, cat: t.cat,
    tier: t.product ? (t.product.hero ? t.product.tier : 'control') : null,
    days: t.dayCount, spend: t.spend, gmv: t.gmv, purchases: t.purchases, atc: t.atc, ctr: t.ctr, sgmv: t.sgmv,
    targetCpp: t.targetCpp, cpp: t.purchases ? t.spend / t.purchases : null,
    limit: t.extended ? s.extendedVerdictSpend : s.verdictSpend, extended: t.extended,
    action: t.decision.action, reason: t.decision.reason, watch: !!t.decision.watch, active: t.active
  }));
  const ladderRows = scales.map((a) => ({
    id: a.id, name: a.name, product: a.product?.title || null, cat: a.cat,
    budget: a.budget, step: a.step, steps: a.steps, marginal: a.marginal, marginalNote: a.marginalNote,
    avg: a.sgmv, days: a.dayCount, daysAtStep: a.daysAtStep,
    action: a.decision.action, to: a.decision.to || null, reason: a.decision.reason
  }));

  return {
    today, catAov, notes,
    coverage: coverage(products),
    pipeline, bySource, queue,
    trials: trialRows, ladder: ladderRows,
    catalog: {
      window: { from: catalog.from, to: catalog.to },
      items: catalog.items.slice(0, 300),
      summary: TEST_CATEGORIES.concat(['Other']).map((c) => {
        const xs = catalog.items.filter((i) => i.cat === c);
        const readable = xs.filter((i) => i.read !== 'thin');
        return { key: c, withSpend: xs.length, readable: readable.length, hits: readable.filter((i) => i.read === 'hit').length, queued: xs.filter((i) => i.read === 'hit' && !i.trialed).length };
      })
    },
    tasks, decisions
  };
}
