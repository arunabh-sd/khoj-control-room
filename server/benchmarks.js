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

export function analyseEvents(rows, { khojSellerId, weights, idx }) {
  if (!rows?.length) return null;
  const sellers = rows.filter((r) => String(r.kind || 'seller') === 'seller').map((r) => ({ ...r, seller_id: String(r.seller_id) }));
  const khoj = sellers.find((r) => r.seller_id === khojSellerId);
  const others = sellers.filter((r) => r.seller_id !== khojSellerId);
  const METRICS = [
    ['productsPerSession', 'Products viewed per session', (r) => n(r.products_viewed) / n(r.sessions), 'num'],
    ['ppoPerSession', 'Product page opens per session', (r) => n(r.ppo) / n(r.sessions), 'num'],
    ['multiProductPct', 'Sessions viewing 2+ products', (r) => pct(n(r.multi_product_sessions), n(r.sessions)), 'pct'],
    ['secsPerSession', 'Time per session (seconds)', (r) => n(r.secs) / n(r.sessions), 'num'],
    ['buyNowPct', 'Sessions with a buy-now click', (r) => pct(n(r.buy_now_sessions), n(r.sessions)), 'pct'],
    ['multiBuyNowPct', 'Buy-now sessions with 2+ products clicked', (r) => pct(n(r.multi_buy_now_sessions), n(r.buy_now_sessions)), 'pct'],
    ['buyNowToCheckout', 'Buy-now → checkout', (r) => pct(n(r.checkout_sessions), n(r.buy_now_sessions)), 'pct'],
    ['ordersPerSession', 'Orders per 100 sessions', (r) => (n(r.orders) / n(r.sessions)) * 100, 'num']
  ];
  const totalW = [...weights.values()].reduce((a, b) => a + b, 0);
  const metrics = METRICS.map(([key, label, f, unit]) => {
    const b = weighted(others, weights, (r) => (n(r.sessions) ? f(r) : null), (r) => n(r.sessions), 100);
    return { key, label, unit, khoj: khoj && n(khoj.sessions) ? f(khoj) : null, bench: b.value, sellers: b.sellers, coverage: pct(b.weight, totalW) };
  });

  // Landing product (first product page of the session, the ad's product in practice) vs what got the buy-now click.
  const prod = (id) => idx.byId.get(String(id)) || idx.bySku.get(String(id)) || idx.byCode.get(String(id)) || null;
  const clicks = rows.filter((r) => String(r.kind) === 'khoj_click');
  let total = 0, other = 0, otherSameSeller = 0, otherSameCat = 0, unknown = 0;
  const pairs = new Map();
  for (const r of clicks) {
    const k = n(r.sessions) || 1;
    total += k;
    if (String(r.landing_product) === String(r.clicked_product)) continue;
    other += k;
    const a = prod(r.landing_product), b = prod(r.clicked_product);
    if (!a || !b) { unknown += k; continue; }
    if (a.seller && a.seller === b.seller) otherSameSeller += k;
    if (a.cat && a.cat === b.cat) otherSameCat += k;
    const key = `${a.id}>${b.id}`;
    const cur = pairs.get(key) || { from: a.title, fromCat: a.cat, to: b.title, toCat: b.cat, sameSeller: a.seller === b.seller, sessions: 0 };
    cur.sessions += k; pairs.set(key, cur);
  }
  const known = other - unknown;
  return {
    khojSessions: khoj ? n(khoj.sessions) : 0, metrics,
    parentSellers: others.length,
    beyond: {
      clicks: total, otherPct: pct(other, total),
      otherSameSellerPct: pct(otherSameSeller, known), otherAnotherSellerPct: pct(known - otherSameSeller, known),
      otherSameCatPct: pct(otherSameCat, known), otherAnotherCatPct: pct(known - otherSameCat, known), unmatched: unknown,
      topPairs: [...pairs.values()].sort((a, b) => b.sessions - a.sessions).slice(0, 12)
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
