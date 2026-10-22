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
    khojSessions: khoj ? n(khoj.sessions) : 0, metrics, parentSellers: others.length,
    rca: { findings, funnel, visitors, categories, landingCatCoverage, sameProduct, depth, secondView, hasLanding: landing.length > 0 },
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
