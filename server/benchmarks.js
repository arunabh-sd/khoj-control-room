// Khoj vs its parent sellers' own sites, weighted by Khoj orders.
//
// Both questions return one row per seller (Khoj and the parent sellers of the products Khoj has sold). A parent
// seller counts in the benchmark in proportion to the Khoj orders of its products, so the comparison is "what would
// these same products' own storefronts do", not an all-ShopDeck average.
//
//  - events (MB_Q_EVENTS): site sessions, last 28 days. kind = 'seller' rows hold the session funnel per seller;
//    kind = 'khoj_click' rows hold Khoj buy-now clicks by landing product (first product page in the session).
//  - benchmark (MB_Q_BENCHMARK): each seller site's own repeat, customers whose first order with the seller was in
//    the last 120 days.
import { num } from './engine.js';
import { categoryOf } from './categories.js';
import { categoryFromName } from './history.js';
const categoryOfL4 = (x) => categoryOf({ category_l2: x.l2, category_l3: x.l3, category_l4: x.l4 });

const pct = (a, b) => (b ? (a / b) * 100 : null);

// Khoj orders per parent seller, from the order history (cancelled left out).
export function khojOrderWeights(historyRows, khojSellerId, idx) {
  const w = new Map();
  const seen = new Set();
  for (const x of historyRows || []) {
    if (x.s !== khojSellerId || x.st === 'C' || seen.has(x.o)) continue;
    const p = idx.byId.get(x.p);
    if (!p?.seller) continue;
    seen.add(x.o);
    w.set(p.seller, (w.get(p.seller) || 0) + 1);
  }
  return w;
}

// Parent sellers to ask the two questions about (most Khoj orders first).
export function parentSellerList(weights, max = 300) {
  return [...weights.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([s]) => s);
}

// Weighted average of a per-seller rate. Sellers below `minBase` (too few sessions or customers) are left out.
function weighted(rows, weights, rateOf, baseOf, minBase) {
  let wsum = 0, acc = 0, used = 0;
  for (const r of rows) {
    const w = weights.get(r.seller_id) || 0;
    if (!w || (baseOf(r) || 0) < minBase) continue;
    const v = rateOf(r);
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    wsum += w; acc += w * v; used++;
  }
  return { value: wsum ? acc / wsum : null, weight: wsum, sellers: used };
}

const n = (v) => num(v) || 0;

export function analyseEvents(rows, { khojSellerId, weights, idx, khojToSellerProduct = new Map(), sellerProductCat = new Map(), historyRows = [] }) {
  if (!rows?.length) return null;
  const K = khojSellerId;
  const kindOf = (r) => String(r.kind || 'seller');
  const sellers = rows.filter((r) => kindOf(r) === 'seller').map((r) => ({ ...r, seller_id: String(r.seller_id) }));
  const khoj = sellers.find((r) => r.seller_id === K);
  const others = sellers.filter((r) => r.seller_id !== K);
  const totalW = [...weights.values()].reduce((a, b) => a + b, 0);
  const METRICS = [
    ['productsPerSession', 'Products viewed per session', (r) => n(r.products_viewed) / n(r.sessions), 'num'],
    ['ppoPerSession', 'Product page opens per session', (r) => n(r.ppo) / n(r.sessions), 'num'],
    ['multiProductPct', 'Sessions viewing 2+ products', (r) => pct(n(r.multi_product_sessions), n(r.sessions)), 'pct'],
    ['secsPerSession', 'Time per session (seconds)', (r) => n(r.secs) / n(r.sessions), 'num'],
    ['buyNowPct', 'Sessions with a buy-now click', (r) => pct(n(r.buy_now_sessions), n(r.sessions)), 'pct'],
    ['multiBuyNowPct', 'Buy-now sessions with 2+ products clicked', (r) => pct(n(r.multi_buy_now_sessions), n(r.buy_now_sessions)), 'pct'],
    ['buyNowToCheckout', 'Buy-now → checkout', (r) => pct(n(r.checkout_sessions), n(r.buy_now_sessions)), 'pct'],
    ['checkoutToOrder', 'Checkout → order', (r) => pct(n(r.orders), n(r.checkout_sessions)), 'pct'],
    ['ordersPerSession', 'Orders per 100 sessions', (r) => (n(r.orders) / n(r.sessions)) * 100, 'num']
  ];
  const benchOf = (f, rowsB = others, min = 100, base = (r) => n(r.sessions)) => weighted(rowsB, weights, (r) => (base(r) ? f(r) : null), base, min);
  const metrics = METRICS.map(([key, label, f, unit]) => {
    const b = benchOf(f);
    return { key, label, unit, khoj: khoj && n(khoj.sessions) ? f(khoj) : null, bench: b.value, sellers: b.sellers, coverage: pct(b.weight, totalW) };
  });
  const M = Object.fromEntries(metrics.map((m) => [m.key, m]));

  // ---------- RCA, level 1: where in the funnel Khoj loses orders per session ----------
  const stages = ['buyNowPct', 'buyNowToCheckout', 'checkoutToOrder'].map((k) => M[k]);
  const logs = stages.map((m) => (m.khoj && m.bench ? Math.log(m.khoj / m.bench) : 0));
  // Share of the loss: only stages where Khoj is behind, each one's part of the combined shortfall.
  const lossLog = logs.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  const funnel = stages.map((m, i) => ({ key: m.key, label: m.label, khoj: m.khoj, bench: m.bench, gapPct: m.khoj !== null && m.bench ? ((m.khoj - m.bench) / m.bench) * 100 : null, shareOfGap: logs[i] < 0 && lossLog ? (logs[i] / lossLog) * 100 : null }));

  // ---------- RCA, level 2: why sessions explore less ----------
  // Product → category for any landing product: Khoj products directly; seller products through Khoj, the
  // universe question or the order history (category column or product name).
  const sellerToKhoj = new Map([...khojToSellerProduct.entries()].map(([k, sp]) => [sp, k]));
  const histCat = new Map();
  for (const x of historyRows) {
    if (!x.p || histCat.has(x.p) || x.s === K) continue;
    const c = x.l4 ? categoryOfL4(x) : categoryFromName(x.n);
    if (c) histCat.set(x.p, c);
  }
  const prodById = (id) => idx.byId.get(String(id)) || idx.bySku.get(String(id)) || idx.byCode.get(String(id)) || null;
  const catOf = (sellerId, id) => {
    if (!id) return null;
    if (sellerId === K) return prodById(id)?.cat || null;
    const kid = sellerToKhoj.get(String(id));
    if (kid && idx.byId.get(kid)) return idx.byId.get(kid).cat;
    return sellerProductCat.get(String(id))?.cat || histCat.get(String(id)) || null;
  };
  const landing = rows.filter((r) => kindOf(r) === 'landing').map((r) => ({ ...r, seller_id: String(r.seller_id), cat: catOf(String(r.seller_id), r.landing_product) }));

  // Segment table per seller: { seg → {sessions, products, multi, bn} }
  const segOf = (list, keyOf) => {
    const m = new Map();
    for (const r of list) {
      const k = keyOf(r); if (k === null || k === undefined) continue;
      const bySeller = m.get(r.seller_id) || m.set(r.seller_id, new Map()).get(r.seller_id);
      const a = bySeller.get(k) || { sessions: 0, products: 0, multi: 0, bn: 0 };
      a.sessions += n(r.sessions); a.products += n(r.products_viewed); a.multi += n(r.multi_product_sessions); a.bn += n(r.buy_now_sessions);
      bySeller.set(k, a);
    }
    return m;
  };
  // Mix vs rate: gap in products/session = Σ (Khoj share − bench share) × bench rate  +  Σ Khoj share × (Khoj rate − bench rate)
  const decompose = (bySeller, keys, minSeg = 20) => {
    const kSeg = bySeller.get(K) || new Map();
    const kTotal = [...kSeg.values()].reduce((a, x) => a + x.sessions, 0);
    const rowsOut = [];
    let mixEffect = 0, rateEffect = 0;
    for (const key of keys) {
      const ks = kSeg.get(key) || { sessions: 0, products: 0, multi: 0, bn: 0 };
      let wS = 0, share = 0, wR = 0, rate = 0, multi = 0, bn = 0;
      for (const [sid, segs] of bySeller) {
        if (sid === K) continue;
        const w = weights.get(sid) || 0; if (!w) continue;
        const tot = [...segs.values()].reduce((a, x) => a + x.sessions, 0); if (tot < 100) continue;
        const x = segs.get(key) || { sessions: 0, products: 0, multi: 0, bn: 0 };
        wS += w; share += w * (x.sessions / tot);
        if (x.sessions >= minSeg) { wR += w; rate += w * (x.products / x.sessions); multi += w * pct(x.multi, x.sessions); bn += w * pct(x.bn, x.sessions); }
      }
      const r = {
        key, khojShare: pct(ks.sessions, kTotal), benchShare: wS ? (share / wS) * 100 : null,
        khojRate: ks.sessions ? ks.products / ks.sessions : null, benchRate: wR ? rate / wR : null,
        khojMulti: ks.sessions ? pct(ks.multi, ks.sessions) : null, benchMulti: wR ? multi / wR : null,
        khojBn: ks.sessions ? pct(ks.bn, ks.sessions) : null, benchBn: wR ? bn / wR : null, khojSessions: ks.sessions
      };
      if (r.benchShare !== null && r.benchRate !== null && r.khojShare !== null) mixEffect += ((r.khojShare - r.benchShare) / 100) * r.benchRate;
      if (r.khojRate !== null && r.benchRate !== null) rateEffect += (r.khojShare / 100) * (r.khojRate - r.benchRate);
      rowsOut.push(r);
    }
    return { rows: rowsOut, mixEffect, rateEffect };
  };
  const visitors = decompose(segOf(landing, (r) => r.visitor_type || null), ['new', 'returning']);
  const keysBy = (list, f) => { const m = new Map(); for (const r of list) { const k = f(r); if (k) m.set(k, (m.get(k) || 0) + n(r.sessions)); } return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k); };
  const srcRows = rows.filter((r) => kindOf(r) === 'source').map((r) => ({ ...r, seller_id: String(r.seller_id) }));
  const devRows = rows.filter((r) => kindOf(r) === 'device').map((r) => ({ ...r, seller_id: String(r.seller_id) }));
  const sources = srcRows.length ? decompose(segOf(srcRows, (r) => r.bucket || null), keysBy(srcRows, (r) => r.bucket)) : null;
  const devices = devRows.length ? decompose(segOf(devRows, (r) => r.bucket || null), keysBy(devRows, (r) => r.bucket)) : null;
  // Within paid Meta traffic only, new visitors only: the closest like-for-like the data allows.
  const metaNew = (() => {
    const list = srcRows.filter((r) => r.bucket === 'Meta ads' && r.visitor_type === 'new');
    if (!list.length) return null;
    const d = decompose(segOf(list, () => 'x'), ['x']).rows[0];
    return d && d.khojRate !== null ? d : null;
  })();
  const CATS = ['Saree', 'Kurti & Suits', 'Jewellery', 'Other'];
  const categories = decompose(segOf(landing, (r) => r.cat || null), CATS);
  const landingCatCoverage = (() => { const k = landing.filter((r) => r.seller_id === K); const all = k.reduce((a, r) => a + n(r.sessions), 0); return pct(k.filter((r) => r.cat).reduce((a, r) => a + n(r.sessions), 0), all); })();

  // Same product, two storefronts: Khoj landing product vs the same product landing on its parent seller's site.
  const sum = (list) => list.reduce((a, r) => ({ sessions: a.sessions + n(r.sessions), products: a.products + n(r.products_viewed), multi: a.multi + n(r.multi_product_sessions), bn: a.bn + n(r.buy_now_sessions) }), { sessions: 0, products: 0, multi: 0, bn: 0 });
  const byKey = new Map();
  for (const r of landing) { const k = `${r.seller_id}|${r.landing_product}`; (byKey.get(k) || byKey.set(k, []).get(k)).push(r); }
  // New visitors only, so the comparison isn't just Khoj's colder traffic mix.
  const pairs = [];
  const newOnly = (list) => { const nw = list.filter((r) => r.visitor_type === 'new'); return nw.length ? nw : list; };
  for (const [k, list] of byKey) {
    const [sid, pid] = k.split('|'); if (sid !== K) continue;
    const p = prodById(pid); if (!p) continue;
    const sp = khojToSellerProduct.get(p.id); if (!sp || !p.seller) continue;
    const own = byKey.get(`${p.seller}|${sp}`); if (!own) continue;
    const a = sum(newOnly(list)), b = sum(newOnly(own));
    if (a.sessions < 10 || b.sessions < 10) continue;
    pairs.push({ name: p.title, cat: p.cat, khojSessions: a.sessions, siteSessions: b.sessions, khojRate: a.products / a.sessions, siteRate: b.products / b.sessions, khojMulti: pct(a.multi, a.sessions), siteMulti: pct(b.multi, b.sessions), khojBn: pct(a.bn, a.sessions), siteBn: pct(b.bn, b.sessions) });
  }
  const pw = (f) => { const w = pairs.reduce((a, x) => a + x.khojSessions, 0); return w ? pairs.reduce((a, x) => a + f(x) * x.khojSessions, 0) / w : null; };
  const kLandingTotal = landing.filter((r) => r.seller_id === K && r.visitor_type !== 'returning').reduce((a, r) => a + n(r.sessions), 0);
  const sameProduct = {
    products: pairs.length, coverage: pct(pairs.reduce((a, x) => a + x.khojSessions, 0), kLandingTotal),
    khojRate: pw((x) => x.khojRate), siteRate: pw((x) => x.siteRate), khojMulti: pw((x) => x.khojMulti), siteMulti: pw((x) => x.siteMulti), khojBn: pw((x) => x.khojBn), siteBn: pw((x) => x.siteBn),
    worst: [...pairs].sort((a, b) => (a.khojRate - a.siteRate) * a.khojSessions - (b.khojRate - b.siteRate) * b.khojSessions).slice(0, 10)
  };

  // Session depth: share of sessions by products viewed.
  const depthRows = rows.filter((r) => kindOf(r) === 'depth').map((r) => ({ ...r, seller_id: String(r.seller_id) }));
  const BUCKETS = ['1', '2', '3-5', '6+'];
  const depthBy = segOf(depthRows.map((r) => ({ ...r, products_viewed: 0, multi_product_sessions: 0 })), (r) => String(r.bucket));
  const depth = decompose(depthBy, BUCKETS).rows.map((r) => ({ key: r.key, khoj: r.khojShare, bench: r.benchShare, khojBn: r.khojBn, benchBn: r.benchBn }));

  // After landing on Khoj: where the second product view goes.
  const next = rows.filter((r) => kindOf(r) === 'khoj_next');
  let nTot = 0, nSameSeller = 0, nSameCat = 0, nKnown = 0;
  for (const r of next) {
    const a = prodById(r.landing_product), b = prodById(r.other_product ?? r.clicked_product); const k = n(r.sessions);
    nTot += k; if (!a || !b) continue; nKnown += k;
    if (a.seller && a.seller === b.seller) nSameSeller += k;
    if (a.cat && a.cat === b.cat) nSameCat += k;
  }
  const secondView = { sessions: nTot, sameSellerPct: pct(nSameSeller, nKnown), sameCatPct: pct(nSameCat, nKnown) };

  // Buy-now beyond the landing product.
  const clicks = rows.filter((r) => kindOf(r) === 'khoj_click');
  let total = 0, other = 0, otherSameSeller = 0, otherSameCat = 0, unknown = 0;
  const cpairs = new Map();
  for (const r of clicks) {
    const k = n(r.sessions) || 1, to = r.other_product ?? r.clicked_product;
    total += k;
    if (String(r.landing_product) === String(to)) continue;
    other += k;
    const a = prodById(r.landing_product), b = prodById(to);
    if (!a || !b) { unknown += k; continue; }
    if (a.seller && a.seller === b.seller) otherSameSeller += k;
    if (a.cat && a.cat === b.cat) otherSameCat += k;
    const key = `${a.id}>${b.id}`;
    const cur = cpairs.get(key) || { from: a.title, fromCat: a.cat, to: b.title, toCat: b.cat, sameSeller: a.seller === b.seller, sessions: 0 };
    cur.sessions += k; cpairs.set(key, cur);
  }
  const known = other - unknown;

  // ---------- product-matched: each Khoj session vs the parent site's sessions that started on the same product ----------
  // For a Khoj landing product X (first product page of the session), the base is the parent seller's own-site
  // sessions whose first product page was X's seller product. Base rates are averaged across products with Khoj's
  // session counts as weights, so the base has exactly Khoj's first-product mix.
  const MIN_BASE = 5;
  const agg0 = () => ({ sessions: 0, ppo: 0, products: 0, multi: 0, secs: 0, bn: 0, multiBn: 0, co: 0 });
  const addTo = (a, r) => { a.sessions += n(r.sessions); a.ppo += n(r.ppo); a.products += n(r.products_viewed); a.multi += n(r.multi_product_sessions); a.secs += n(r.secs); a.bn += n(r.buy_now_sessions); a.multiBn += n(r.multi_buy_now_sessions); a.co += n(r.checkout_sessions); return a; };
  const index = (list, segOfRow) => {
    const m = new Map();
    for (const r of list) {
      const key = `${r.seller_id}|${r.landing_product}`;
      const e = m.get(key) || m.set(key, { all: agg0(), seg: new Map() }).get(key);
      addTo(e.all, r);
      const sg = segOfRow ? segOfRow(r) : null;
      if (sg) addTo(e.seg.get(sg) || e.seg.set(sg, agg0()).get(sg), r);
    }
    return m;
  };
  const byLanding = index(landing, (r) => r.visitor_type || null);
  const landSrc = rows.filter((r) => kindOf(r) === 'landing_src').map((r) => ({ ...r, seller_id: String(r.seller_id) }));
  const bySrc = index(landSrc, (r) => r.bucket || null);
  const baseKeyOf = (pid) => {
    const p = prodById(pid); if (!p || !p.seller) return { p, key: null, why: p ? 'no parent seller' : 'not a Khoj product' };
    const sp = khojToSellerProduct.get(p.id);
    for (const id of [sp, p.id].filter(Boolean)) if (byLanding.has(`${p.seller}|${id}`)) return { p, key: `${p.seller}|${id}` };
    return { p, key: null, why: sp ? 'seller site had no sessions starting on it' : 'no seller product id for it' };
  };
  const RATES = {
    productsPerSession: (a) => a.products / a.sessions, ppoPerSession: (a) => a.ppo / a.sessions, multiProductPct: (a) => pct(a.multi, a.sessions),
    singlePct: (a) => pct(a.sessions - a.multi, a.sessions), secsPerSession: (a) => a.secs / a.sessions, buyNowPct: (a) => pct(a.bn, a.sessions),
    multiBuyNowPct: (a) => (a.bn ? pct(a.multiBn, a.bn) : null), buyNowToCheckout: (a) => (a.bn ? pct(a.co, a.bn) : null)
  };
  const LABELS = {
    productsPerSession: 'Products viewed per session', ppoPerSession: 'Product page opens per session', multiProductPct: 'Sessions viewing 2+ products',
    singlePct: 'Sessions that see only the first product', secsPerSession: 'Time per session (seconds)', buyNowPct: 'Sessions with a buy-now click',
    multiBuyNowPct: 'Buy-now sessions with 2+ products clicked', buyNowToCheckout: 'Buy-now → checkout'
  };
  const matchedRows = [];
  const unmatched = { sessions: 0, reasons: {} };
  let khojLandingSessions = 0;
  for (const [key, e] of byLanding) {
    const [sid, pid] = key.split('|'); if (sid !== K) continue;
    khojLandingSessions += e.all.sessions;
    const { p, key: bkey, why } = baseKeyOf(pid);
    const base = bkey ? byLanding.get(bkey) : null;
    if (!base || base.all.sessions < MIN_BASE) {
      unmatched.sessions += e.all.sessions;
      const r = why || `fewer than ${MIN_BASE} seller-site sessions`; unmatched.reasons[r] = (unmatched.reasons[r] || 0) + e.all.sessions;
      continue;
    }
    matchedRows.push({ pid, p, k: e, b: base, srcK: bySrc.get(key), srcB: bySrc.get(bkey) });
  }
  const W = matchedRows.reduce((a, m) => a + m.k.all.sessions, 0);
  const wavg = (f) => { let w = 0, s = 0; for (const m of matchedRows) { const v = f(m); if (v === null || v === undefined || !Number.isFinite(v)) continue; w += m.k.all.sessions; s += v * m.k.all.sessions; } return w ? s / w : null; };
  const matchedMetrics = Object.keys(RATES).map((key) => {
    const f = RATES[key];
    const kPool = matchedRows.reduce((a, m) => addTo(a, { sessions: m.k.all.sessions, ppo: m.k.all.ppo, products_viewed: m.k.all.products, multi_product_sessions: m.k.all.multi, secs: m.k.all.secs, buy_now_sessions: m.k.all.bn, multi_buy_now_sessions: m.k.all.multiBn, checkout_sessions: m.k.all.co }), agg0());
    return { key, label: LABELS[key], unit: /Pct$|Checkout$/.test(key) ? 'pct' : 'num', khoj: kPool.sessions ? f(kPool) : null, bench: wavg((m) => f(m.b.all)) };
  });
  // Product-matched mix vs rate, for a segmentation that exists per landing product (visitor type, traffic source).
  const matchedDecompose = (segGetter, minSeg = 3) => {
    const keys = new Map();
    for (const m of matchedRows) { const g = segGetter(m); if (!g) continue; for (const [k, a] of g.k) keys.set(k, (keys.get(k) || 0) + a.sessions); for (const k of g.b.keys()) if (!keys.has(k)) keys.set(k, 0); }
    const order = [...keys.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    let mixEffect = 0, rateEffect = 0;
    const out = order.map((key) => {
      let kS = 0, kP = 0, kM = 0, kB = 0, totK = 0, wShare = 0, share = 0, wRate = 0, rate = 0, multi = 0, bn = 0;
      for (const m of matchedRows) {
        const g = segGetter(m); if (!g) continue;
        const ktot = [...g.k.values()].reduce((a, x) => a + x.sessions, 0), btot = [...g.b.values()].reduce((a, x) => a + x.sessions, 0);
        if (!ktot || !btot) continue;
        const ks = g.k.get(key), bs = g.b.get(key);
        totK += ktot;
        if (ks) { kS += ks.sessions; kP += ks.products; kM += ks.multi; kB += ks.bn; }
        wShare += ktot; share += ktot * ((bs?.sessions || 0) / btot);
        // Seller-site rate in this segment, averaged over products with Khoj's product weights (even where Khoj has none of this segment).
        if (bs && bs.sessions >= minSeg) { const w = ks ? ks.sessions : ktot; wRate += w; rate += w * (bs.products / bs.sessions); multi += w * pct(bs.multi, bs.sessions); bn += w * pct(bs.bn, bs.sessions); }
      }
      const r = { key, khojShare: pct(kS, totK), benchShare: wShare ? (share / wShare) * 100 : null, khojRate: kS ? kP / kS : null, benchRate: wRate ? rate / wRate : null,
        khojMulti: kS ? pct(kM, kS) : null, benchMulti: wRate ? multi / wRate : null, khojBn: kS ? pct(kB, kS) : null, benchBn: wRate ? bn / wRate : null, khojSessions: kS };
      if (r.benchShare !== null && r.benchRate !== null && r.khojShare !== null) mixEffect += ((r.khojShare - r.benchShare) / 100) * r.benchRate;
      if (r.khojRate !== null && r.benchRate !== null) rateEffect += (r.khojShare / 100) * (r.khojRate - r.benchRate);
      return r;
    });
    return out.length ? { rows: out, mixEffect, rateEffect } : null;
  };
  const mVisitors = matchedDecompose((m) => ({ k: m.k.seg, b: m.b.seg }));
  const mSources = landSrc.length ? matchedDecompose((m) => (m.srcK && m.srcB ? { k: m.srcK.seg, b: m.srcB.seg } : null)) : null;
  // Which products drive the gap: each product's share of Khoj sessions × its gap in products per session.
  const contrib = matchedRows.map((m) => {
    const kr = m.k.all.products / m.k.all.sessions, br = m.b.all.products / m.b.all.sessions;
    return { name: m.p.title, cat: m.p.cat, khojSessions: m.k.all.sessions, siteSessions: m.b.all.sessions, khojRate: kr, siteRate: br,
      khojBn: pct(m.k.all.bn, m.k.all.sessions), siteBn: pct(m.b.all.bn, m.b.all.sessions), effect: W ? (m.k.all.sessions / W) * (kr - br) : 0 };
  }).sort((a, b) => a.effect - b.effect);
  const byCatM = (() => {
    const m = new Map();
    for (const x of matchedRows) { const c = x.p.cat || 'Other'; (m.get(c) || m.set(c, []).get(c)).push(x); }
    return [...m.entries()].map(([key, list]) => {
      const w = list.reduce((a, x) => a + x.k.all.sessions, 0);
      const kAgg = list.reduce((a, x) => ({ s: a.s + x.k.all.sessions, p: a.p + x.k.all.products, m: a.m + x.k.all.multi, b: a.b + x.k.all.bn }), { s: 0, p: 0, m: 0, b: 0 });
      const bw = (f) => list.reduce((a, x) => a + f(x.b.all) * x.k.all.sessions, 0) / w;
      return { key, khojSessions: kAgg.s, share: pct(kAgg.s, W), khojRate: kAgg.p / kAgg.s, benchRate: bw((a) => a.products / a.sessions), khojMulti: pct(kAgg.m, kAgg.s), benchMulti: bw((a) => pct(a.multi, a.sessions)), khojBn: pct(kAgg.b, kAgg.s), benchBn: bw((a) => pct(a.bn, a.sessions)), effect: (kAgg.s / W) * (kAgg.p / kAgg.s - bw((a) => a.products / a.sessions)) };
    }).sort((a, b) => b.khojSessions - a.khojSessions);
  })();
  const MM = Object.fromEntries(matchedMetrics.map((m) => [m.key, m]));
  const mFindings = [];
  const pps = MM.productsPerSession;
  if (W && pps.khoj !== null && pps.bench) {
    const gap = pps.khoj - pps.bench;
    mFindings.push({ tone: gap < 0 ? 'bad' : 'good', text: `Same first product, weighted to Khoj's product mix: Khoj sessions view ${pps.khoj.toFixed(2)} products vs ${pps.bench.toFixed(2)} on the sellers' own sites (${gap >= 0 ? '+' : ''}${((gap / pps.bench) * 100).toFixed(0)}%). ${MM.singlePct.khoj?.toFixed(0)}% of Khoj sessions never leave the first product vs ${MM.singlePct.bench?.toFixed(0)}%.` });
    const bnK = MM.buyNowPct.khoj, bnB = MM.buyNowPct.bench;
    if (bnK !== null && bnB !== null) mFindings.push({ tone: 'info', text: bnK >= bnB && gap < 0
      ? `Buy-now on the same products is ${bnK.toFixed(1)}% on Khoj vs ${bnB.toFixed(1)}%: Khoj visitors decide on the first product as often or more, they just don't look around. Consistent with Khoj's lower price on the same product (Audience tab) making the first product an easy yes.`
      : `Buy-now on the same products is ${bnK.toFixed(1)}% on Khoj vs ${bnB.toFixed(1)}%, so less browsing comes with ${bnK < bnB ? 'less buying intent too' : 'more buying'}.` });
    if (mVisitors) {
      const nw = mVisitors.rows.find((r) => r.key === 'new');
      mFindings.push({ tone: 'info', text: `Visitors, same products: ${nw?.khojShare?.toFixed(0) ?? '—'}% of Khoj sessions are new visitors vs ${nw?.benchShare?.toFixed(0) ?? '—'}% of seller-site sessions on those products. Mix explains ${mVisitors.mixEffect.toFixed(2)} of the ${gap.toFixed(2)} gap; within new visitors Khoj views ${nw?.khojRate?.toFixed(2) ?? '—'} vs ${nw?.benchRate?.toFixed(2) ?? '—'}.` });
    }
    if (mSources) {
      const meta = mSources.rows.find((r) => r.key === 'Meta ads');
      mFindings.push({ tone: 'info', text: `Traffic source, same products: ${meta?.khojShare?.toFixed(0) ?? '—'}% of Khoj sessions come from Meta ads vs ${meta?.benchShare?.toFixed(0) ?? '—'}% on the sellers' sites. Source mix explains ${mSources.mixEffect.toFixed(2)}; within the same source, ${mSources.rateEffect.toFixed(2)}.${meta && meta.khojRate !== null && meta.benchRate !== null ? ` Meta-ad sessions only: Khoj ${meta.khojRate.toFixed(2)} vs ${meta.benchRate.toFixed(2)}.` : ''}` });
    }
    const worstCat = byCatM.filter((c) => c.effect < 0).sort((a, b) => a.effect - b.effect)[0];
    if (worstCat) mFindings.push({ tone: 'bad', text: `By category, ${worstCat.key} drives the most of the gap: ${worstCat.khojRate.toFixed(2)} vs ${worstCat.benchRate.toFixed(2)} products per session on ${worstCat.share.toFixed(0)}% of matched Khoj sessions.` });
    const top3 = contrib.slice(0, 3).filter((c) => c.effect < 0);
    if (top3.length) mFindings.push({ tone: 'info', text: `Three products account for ${((top3.reduce((a, c) => a + c.effect, 0) / gap) * 100).toFixed(0)}% of the gap: ${top3.map((c) => c.name.slice(0, 40)).join('; ')}.` });
  }
  const matched = {
    products: matchedRows.length, coverage: pct(W, khojLandingSessions), khojLandingSessions, minBase: MIN_BASE,
    unmatched: Object.entries(unmatched.reasons).map(([reason, sessions]) => ({ reason, share: pct(sessions, khojLandingSessions) })).sort((a, b) => b.share - a.share),
    metrics: matchedMetrics, visitors: mVisitors, sources: mSources, categories: byCatM, drags: contrib.slice(0, 12), findings: mFindings
  };

  // ---------- findings, in words ----------
  const findings = [];
  const P = M.productsPerSession;
  if (P.khoj !== null && P.bench) {
    const gap = P.khoj - P.bench;
    findings.push({ tone: gap < 0 ? 'bad' : 'good', text: `Khoj sessions view ${P.khoj.toFixed(2)} products vs ${P.bench.toFixed(2)} on the parent sellers' own sites (${gap >= 0 ? '+' : ''}${((gap / P.bench) * 100).toFixed(0)}%).` });
    const v = visitors, nw = v.rows.find((r) => r.key === 'new');
    if (nw && nw.khojShare !== null && nw.benchShare !== null) {
      findings.push({ tone: 'info', text: `Visitor mix: ${nw.khojShare.toFixed(0)}% of Khoj sessions are new visitors vs ${nw.benchShare.toFixed(0)}% on the sellers' sites. Mix accounts for ${v.mixEffect.toFixed(2)} products per session of the gap; behaviour within each visitor type for ${v.rateEffect.toFixed(2)}.` });
      if (nw.khojRate !== null && nw.benchRate !== null) findings.push({ tone: nw.khojRate < nw.benchRate ? 'bad' : 'good', text: `New visitors only: Khoj ${nw.khojRate.toFixed(2)} vs ${nw.benchRate.toFixed(2)} products per session. ${nw.khojRate < nw.benchRate ? 'Khoj is lower even like-for-like, so it is not only cold traffic.' : 'Like-for-like, Khoj is not worse: the gap is the traffic mix.'}` });
    }
    if (sources?.rows.length) {
      const meta = sources.rows.find((r) => r.key === 'Meta ads');
      const topB = [...sources.rows].sort((a, b) => (b.benchShare || 0) - (a.benchShare || 0))[0];
      findings.push({ tone: 'info', text: `Traffic source: ${meta?.khojShare?.toFixed(0) ?? '—'}% of Khoj sessions come from Meta ads vs ${meta?.benchShare?.toFixed(0) ?? '—'}% on the sellers' sites${topB && topB.key !== 'Meta ads' ? ` (their biggest source is ${topB.key}, ${topB.benchShare.toFixed(0)}%)` : ''}. Source mix accounts for ${sources.mixEffect.toFixed(2)} products per session; behaviour within each source for ${sources.rateEffect.toFixed(2)}.` });
    }
    if (metaNew) findings.push({ tone: metaNew.khojRate < metaNew.benchRate ? 'bad' : 'good', text: `Closest like-for-like (new visitors from Meta ads): Khoj ${metaNew.khojRate.toFixed(2)} vs ${metaNew.benchRate.toFixed(2)} products per session, ${metaNew.khojMulti?.toFixed(0) ?? '—'}% vs ${metaNew.benchMulti?.toFixed(0) ?? '—'}% viewing 2+ products.` });
    const c = categories;
    if (c.rows.some((r) => r.khojShare)) {
      const top = [...c.rows].filter((r) => r.khojRate !== null && r.benchRate !== null).sort((a, b) => (a.khojRate - a.benchRate) * (a.khojShare || 0) - (b.khojRate - b.benchRate) * (b.khojShare || 0))[0];
      findings.push({ tone: 'info', text: `Category mix accounts for ${c.mixEffect.toFixed(2)} products per session; category by category, ${c.rateEffect.toFixed(2)}.${top ? ` The biggest drag is ${top.key}: ${top.khojRate.toFixed(2)} on Khoj vs ${top.benchRate.toFixed(2)} on sellers' sites, ${top.khojShare.toFixed(0)}% of Khoj sessions.` : ''}` });
    }
    if (sameProduct.products) findings.push({ tone: sameProduct.khojRate < sameProduct.siteRate ? 'bad' : 'good', text: `Same product, new visitors, two storefronts (${sameProduct.products} products): ${sameProduct.khojRate.toFixed(2)} products per session landing on Khoj vs ${sameProduct.siteRate.toFixed(2)} landing on the seller's own site.${sameProduct.khojRate < sameProduct.siteRate ? ' With traffic held equal, Khoj\'s product page leads to less browsing: look at what the page shows next (recommendations, other sellers, category links).' : ''}` });
    const one = depth.find((d) => d.key === '1');
    if (one && one.khoj !== null && one.bench !== null) findings.push({ tone: one.khoj > one.bench ? 'bad' : 'good', text: `${one.khoj.toFixed(0)}% of Khoj sessions see only the landing product vs ${one.bench.toFixed(0)}% on sellers' sites.` });
    if (secondView.sessions) findings.push({ tone: 'info', text: `When Khoj visitors do open a second product, ${secondView.sameCatPct?.toFixed(0) ?? '—'}% stay in the landing product's category and ${secondView.sameSellerPct?.toFixed(0) ?? '—'}% stay with the same seller.` });
  }
  const stageWorst = [...funnel].filter((f) => f.gapPct !== null && f.gapPct < 0).sort((a, b) => a.gapPct - b.gapPct)[0];
  if (stageWorst) findings.push({ tone: 'bad', text: `In the funnel, the biggest loss vs the sellers' sites is ${stageWorst.label.toLowerCase()} (${stageWorst.gapPct.toFixed(0)}%).` });

  return {
    khojSessions: khoj ? n(khoj.sessions) : 0, metrics, parentSellers: others.length, matched,
    rca: { findings, funnel, visitors, sources, devices, metaNew, categories, landingCatCoverage, sameProduct, depth, secondView, hasLanding: landing.length > 0 },
    beyond: {
      clicks: total, otherPct: pct(other, total),
      otherSameSellerPct: pct(otherSameSeller, known), otherAnotherSellerPct: pct(known - otherSameSeller, known),
      otherSameCatPct: pct(otherSameCat, known), otherAnotherCatPct: pct(known - otherSameCat, known), unmatched: unknown,
      topPairs: [...cpairs.values()].sort((a, b) => b.sessions - a.sessions).slice(0, 12)
    }
  };
}

export function analyseRepeatBenchmark(rows, { khojSellerId, weights }) {
  if (!rows?.length) return null;
  const all = rows.map((r) => ({ ...r, seller_id: String(r.seller_id) }));
  const khoj = all.find((r) => r.seller_id === khojSellerId) || null;
  const others = all.filter((r) => r.seller_id !== khojSellerId);
  const totalW = [...weights.values()].reduce((a, b) => a + b, 0);
  const rate = (num_, den) => (r) => (n(r[den]) ? pct(n(r[num_]), n(r[den])) : null);
  const W = (num_, den, min = 20) => weighted(others, weights, rate(num_, den), (r) => n(r[den]), min);
  const rates = {};
  for (const d of [7, 14, 28]) rates[`d${d}`] = W(`repeat_${d}`, `eligible_${d}`);
  const seg = {
    COD: W('cod_repeat_14', 'cod_eligible_14'), Prepaid: W('prepaid_repeat_14', 'prepaid_eligible_14'),
    'New to ShopDeck': W('new_repeat_14', 'new_eligible_14'), 'Returning to ShopDeck': W('returning_repeat_14', 'returning_eligible_14')
  };
  const sameProduct = weighted(others, weights, rate('repeat_same_product_28', 'repeat_lines_28'), (r) => n(r.repeat_lines_28), 10);
  const khojOwn = khoj ? {
    d7: rate('repeat_7', 'eligible_7')(khoj), d14: rate('repeat_14', 'eligible_14')(khoj), d28: rate('repeat_28', 'eligible_28')(khoj),
    eligible7: n(khoj.eligible_7), eligible14: n(khoj.eligible_14)
  } : null;
  return {
    rates: Object.fromEntries(Object.entries(rates).map(([k, v]) => [k, v.value])),
    sellers: rates.d14.sellers, coverage: pct(rates.d14.weight, totalW),
    segments: Object.fromEntries(Object.entries(seg).map(([k, v]) => [k, v.value])),
    sameProductPct: sameProduct.value,
    khojFromQuestion: khojOwn
  };
}

// Personalisation potential for Khoj visitors (MB_Q_PERSONALISE): Khoj sessions grouped by whether the visitor is a
// known ShopDeck customer, had a ShopDeck order or browse in the 30 days before, and whether the landing product
// matched it. The "if personalised" estimate gives sessions that had a signal but landed on something unrelated the
// conversion of sessions that landed on a match (category-level match as the conservative case).
export function analyseVisitorPersonalisation(rows) {
  if (!rows?.length) return null;
  const bool = (v) => v === true || v === 1 || String(v).toLowerCase() === 'true';
  const R = rows.map((r) => ({ cat: r.landing_cat || 'Unknown', linked: bool(r.linked), signal: bool(r.has_signal), level: String(r.match_level || ''), order: bool(r.order_signal), browse: bool(r.browse_signal), s: n(r.sessions), bn: n(r.buy_now_sessions), o: n(r.order_sessions) }));
  const sum = (list) => list.reduce((a, r) => ({ s: a.s + r.s, bn: a.bn + r.bn, o: a.o + r.o }), { s: 0, bn: 0, o: 0 });
  const all = sum(R);
  const stat = (key, label, list, note) => { const x = sum(list); return { key, label, note, sessions: x.s, share: pct(x.s, all.s), buyNowPct: pct(x.bn, x.s), conversionPct: pct(x.o, x.s), orders: x.o }; };
  const LEVELS = [['same product', 'Landed on a product they had ordered or browsed'], ['same seller', 'Landed on a seller they had ordered from or browsed'], ['same category', 'Landed in a category they had ordered or browsed'], ['no match', 'Had a signal, landed on something unrelated'], ['no signal', 'Known to ShopDeck, no order or browse in 30 days'], ['not known', 'Not a known ShopDeck customer']];
  const levels = LEVELS.map(([k, label]) => stat(k, label, R.filter((r) => r.level === k)));
  const L = Object.fromEntries(levels.map((l) => [l.key, l]));
  const matchedAll = stat('matched', 'Any match', R.filter((r) => ['same product', 'same seller', 'same category'].includes(r.level)));
  const signalled = stat('signal', 'Had a ShopDeck signal in 30 days', R.filter((r) => r.signal));
  // Uplift: "no match" sessions converting like category-matched sessions (conservative) or like any-match sessions.
  const est = (crPct) => {
    if (crPct === null || L['no match'].conversionPct === null) return null;
    const extra = Math.max(0, (crPct - L['no match'].conversionPct) / 100) * L['no match'].sessions;
    const newCr = pct(all.o + extra, all.s);
    return { extraOrders: extra, newConversionPct: newCr, liftPct: all.o ? (extra / all.o) * 100 : null };
  };
  const byCat = [...new Set(R.map((r) => r.cat))].map((c) => {
    const list = R.filter((r) => r.cat === c);
    const m = sum(list.filter((r) => ['same product', 'same seller', 'same category'].includes(r.level))), nm = sum(list.filter((r) => r.level === 'no match')), tot = sum(list);
    return { key: c, sessions: tot.s, conversionPct: pct(tot.o, tot.s), signalPct: pct(sum(list.filter((r) => r.signal)).s, tot.s), matchedPct: pct(m.s, tot.s), matchedCr: pct(m.o, m.s), noMatchPct: pct(nm.s, tot.s), noMatchCr: pct(nm.o, nm.s) };
  }).sort((a, b) => b.sessions - a.sessions);
  const bySignal = [['order', 'Ordered on ShopDeck in 30 days', (r) => r.order], ['browse', 'Browsed ShopDeck sites in 30 days (no order)', (r) => r.browse && !r.order]].map(([k, label, f]) => {
    const list = R.filter((r) => r.signal && f(r));
    const m = sum(list.filter((r) => ['same product', 'same seller', 'same category'].includes(r.level))), nm = sum(list.filter((r) => r.level === 'no match'));
    return { key: k, label, sessions: sum(list).s, matchedCr: pct(m.o, m.s), noMatchCr: pct(nm.o, nm.s), matchedPct: pct(m.s, sum(list).s) };
  });
  return {
    sessions: all.s, orders: all.o, conversionPct: pct(all.o, all.s), buyNowPct: pct(all.bn, all.s),
    linkedPct: pct(sum(R.filter((r) => r.linked)).s, all.s), signalPct: signalled.share, matchedPct: matchedAll.share,
    matchedCr: matchedAll.conversionPct, noMatchCr: L['no match'].conversionPct,
    levels, byCat, bySignal,
    estimate: { conservative: est(L['same category'].conversionPct), optimistic: est(matchedAll.conversionPct), personalisableSessions: L['no match'].sessions, personalisablePct: L['no match'].share }
  };
}
