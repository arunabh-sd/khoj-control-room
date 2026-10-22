// Khoj buyers' ShopDeck order history (Q16717: every ShopDeck order in the last 12 months by anyone who has ordered on
// Khoj, Khoj's own orders included). Feeds Audience intelligence, Repeat behaviour and Cross-selling.
//
// compactHistory() runs as soon as the question loads: it keeps only the columns the analysis needs and drops names,
// addresses, coordinates, AWBs and labels, so no personal data reaches the cache or the browser.
// analyseHistory() turns the compact rows into the three tabs' numbers.
import { num } from './engine.js';
import { categoryOf } from './categories.js';

// ---------- compaction ----------
// "8-8-2026, 12:54" (Metabase formatted), "2026-08-08T12:54:00+05:30" or "2026-08-08 12:54" → minutes since epoch.
// Formatted dates carry no zone; they're read as IST so every row lines up.
export function parseTs(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Math.round((v > 1e11 ? v : v * 1000) / 60000);
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4}),?\s*(\d{1,2}):(\d{2})/);
  if (m) return Math.round(Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]) / 60000) - 330;
  m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m) return Math.round(Date.UTC(+m[3], +m[2] - 1, +m[1]) / 60000) - 330;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) return Math.round(Date.parse(s.replace(' ', 'T') + '+05:30') / 60000);
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.round(t / 60000);
}

// Order state from ShopDeck's two status columns.
export function stateOf(r) {
  const seller = String(r.seller_last_status || '').toLowerCase(), house = String(r.in_house_status || '').toLowerCase();
  if (seller.startsWith('cancel') || house.startsWith('cancel')) return 'C';
  if (house.startsWith('rto') || seller.startsWith('rto')) return 'R';
  if (house === 'delivered' || seller === 'delivered') return 'D';
  return 'O';
}

// India Post pincode → state (approximate at the edges; good enough for a state split).
const PIN3 = [
  [110, 110, 'Delhi'], [120, 136, 'Haryana'], [140, 159, 'Punjab'], [160, 160, 'Chandigarh'], [161, 169, 'Punjab'],
  [170, 177, 'Himachal Pradesh'], [180, 193, 'Jammu & Kashmir'], [194, 194, 'Ladakh'],
  [246, 249, 'Uttarakhand'], [262, 263, 'Uttarakhand'], [200, 285, 'Uttar Pradesh'],
  [300, 345, 'Rajasthan'], [360, 396, 'Gujarat'], [403, 403, 'Goa'], [400, 445, 'Maharashtra'],
  [450, 488, 'Madhya Pradesh'], [490, 497, 'Chhattisgarh'], [500, 509, 'Telangana'], [510, 535, 'Andhra Pradesh'],
  [560, 591, 'Karnataka'], [605, 605, 'Puducherry'], [600, 643, 'Tamil Nadu'], [670, 695, 'Kerala'],
  [737, 737, 'Sikkim'], [744, 744, 'Andaman & Nicobar'], [700, 743, 'West Bengal'], [750, 770, 'Odisha'],
  [780, 788, 'Assam'], [790, 792, 'Arunachal Pradesh'], [793, 794, 'Meghalaya'], [795, 795, 'Manipur'], [796, 796, 'Mizoram'],
  [797, 798, 'Nagaland'], [799, 799, 'Tripura'], [813, 816, 'Jharkhand'], [822, 835, 'Jharkhand'], [800, 855, 'Bihar']
];
export function stateOfPincode(pin) {
  const p3 = Number(String(pin || '').trim().slice(0, 3));
  if (!p3 || String(pin).trim().length !== 6) return null;
  for (const [a, b, st] of PIN3) if (p3 >= a && p3 <= b) return st;
  return null;
}

export function compactHistory(rows) {
  if (rows.length && 'c' in rows[0] && 't' in rows[0]) return rows;   // already compact (cache)
  const out = [];
  for (const r of rows) {
    const t = parseTs(r.createdat ?? r.created_at ?? r.order_date);
    const c = r.customer_id, s = r.seller_id;
    if (t === null || !c || !s) continue;
    const q = num(r.quantity) || 1;
    const price = num(r.selling_price) ?? num(r.seller_price) ?? num(r.product_price) ?? 0;
    const meta = String(r.meta || '');
    const row = {
      o: String(r.order_id || r.seller_group_id || ''), c: String(c), s: String(s),
      p: String(r.customer_product_short_id ?? r.product_id ?? ''), t, st: stateOf(r),
      pm: String(r.payment_mode || '').toLowerCase(), q, g: price * q,
      dt: parseTs(r.delivery_time), reg: stateOfPincode(r.pincode)
    };
    if (r.product_name) row.n = String(r.product_name).trim().slice(0, 70);
    if (r.seller_name) row.sn = String(r.seller_name).trim().slice(0, 40);
    if (/(^|,)first_order(,|$)/.test(meta)) row.ff = 1;
    const l2 = r.category_l2 ?? r.khoj_category_l2, l3 = r.category_l3 ?? r.khoj_category_l3, l4 = r.category_l4 ?? r.khoj_category_l4;
    if (l4) { row.l2 = l2; row.l3 = l3; row.l4 = l4; }
    out.push(row);
  }
  return out;
}

// Test category from a product name, for history lines with no category column: good enough to tell Saree,
// Kurti & Suits and Jewellery apart.
export function categoryFromName(name) {
  const s = String(name || '').toLowerCase();
  if (!s) return null;
  if (/\bsar(ee|i)s?\b|saaree/.test(s)) return 'Saree';
  if (/kurt[aiy]|salwar|anarkali|churidar|dress material|\bsuits?\b|palazzo set|co-?ord/.test(s)) return 'Kurti & Suits';
  if (/necklace|earring|jhumk|bangle|bracelet|pendant|mangalsutra|jewel|\brings?\b|\bchains?\b|anklet|payal|nose ?pin|maang|\bkada\b|choker|\bhaar\b|kamarband|toe ring/.test(s)) return 'Jewellery';
  return null;
}

// Browsing rows (customer × seller × product × day, first view): { c, s, p, t, v }.
export function compactBrowsing(rows) {
  if (rows.length && 'c' in rows[0] && 't' in rows[0]) return rows;
  const out = [];
  for (const r of rows) {
    const t = parseTs(r.first_view ?? r.created_at);
    if (t === null || !r.customer_id) continue;
    out.push({ c: String(r.customer_id), s: String(r.seller_id || ''), p: String(r.product_id || ''), t, v: num(r.views) || 1 });
  }
  return out;
}

// ---------- analysis ----------
const DAY = 1440;
const median = (xs) => { if (!xs.length) return null; const a = [...xs].sort((x, y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const pct = (a, b) => (b ? a / b * 100 : null);
const isCod = (pm) => pm === 'cod' || pm === 'partial-cod';

function closedRates(lines) {
  const valid = lines.filter((x) => x.st !== 'C');
  const closed = valid.filter((x) => x.st === 'D' || x.st === 'R');
  const orders = new Map();
  for (const x of valid) orders.set(x.o, (orders.get(x.o) || 0) + x.g);
  return {
    lines: lines.length, orders: orders.size,
    cancelPct: pct(lines.filter((x) => x.st === 'C').length, lines.length),
    codPct: pct(valid.filter((x) => isCod(x.pm)).length, valid.length),
    rtoPct: pct(closed.filter((x) => x.st === 'R').length, closed.length),
    deliveredPct: pct(valid.filter((x) => x.st === 'D').length, valid.length),
    closed: closed.length,
    aov: orders.size ? [...orders.values()].reduce((a, b) => a + b, 0) / orders.size : null
  };
}

/**
 * ctx: { khojSellerId, sessionMinutes, idx (Khoj products: byId → {seller, cat, l4, title}), khojToSellerProduct (Map),
 *        sellerProductCat (Map seller product id → {l4, cat}), productUrl(p) }
 */
export function analyseHistory(rows, ctx) {
  const K = String(ctx.khojSellerId || '');
  const gap = (ctx.sessionMinutes || 30);
  if (!rows.length || !K) return null;
  const khojAll = rows.filter((x) => x.s === K);
  if (!khojAll.length) return { error: `No orders from Khoj's seller id ${K} in this question. Check the Khoj seller id under Rules → Data.` };

  const end = Math.max(...rows.map((x) => x.t));
  const kp = (x) => ctx.idx.byId.get(x.p) || null;                       // Khoj product of a Khoj line
  const catOfLine = (x) => {                                              // {l4, cat} of any line
    if (x.s === K) { const p = kp(x); return p ? { l4: p.l4 || null, cat: p.cat } : { l4: null, cat: null }; }
    if (x.l4) return { l4: x.l4, cat: categoryOf({ category_l2: x.l2, category_l3: x.l3, category_l4: x.l4 }) };
    const u = ctx.sellerProductCat.get(x.p);
    if (u) return u;
    const byName = categoryFromName(x.n);
    return { l4: null, cat: byName || (x.n ? 'Other' : null) };
  };

  // Per customer: lines sorted by time, split into Khoj and ShopDeck-seller lines (cancelled lines out).
  const byCust = new Map();
  for (const x of rows) (byCust.get(x.c) || byCust.set(x.c, []).get(x.c)).push(x);
  const custs = [];
  for (const [c, all] of byCust) {
    all.sort((a, b) => a.t - b.t);
    const valid = all.filter((x) => x.st !== 'C');
    const khoj = valid.filter((x) => x.s === K);
    if (!khoj.length) continue;
    const fk = khoj[0].t;
    const firstLines = khoj.filter((x) => x.t - fk <= gap);               // first Khoj visit (buy-now makes one order per item)
    const firstProducts = firstLines.map(kp).filter(Boolean);
    const sd = valid.filter((x) => x.s !== K);
    custs.push({
      c, all, khoj, sd, fk, firstLines, firstProducts,
      first: firstProducts[0] || null,
      prior: sd.filter((x) => x.t < fk), after: sd.filter((x) => x.t > fk),
      newToSd: all.some((x) => x.s === K && x.ff),
      reg: (khoj.find((x) => x.reg) || all.find((x) => x.reg) || {}).reg || null
    });
  }
  const N = custs.length;
  if (!N) return { error: 'Every Khoj order in the history question is cancelled.' };

  // ----- who buys -----
  const priorOrders = (cu) => new Set(cu.prior.map((x) => x.o)).size;
  const bucketOf = (n) => (n === 0 ? 'None' : n === 1 ? '1' : n <= 3 ? '2–3' : n <= 6 ? '4–6' : '7+');
  const repeatOf = (cu) => cu.khoj.some((x) => x.t - cu.fk > gap);
  const segRow = (key, cs) => {
    const lines = cs.flatMap((cu) => cu.all.filter((x) => x.s === K));
    const r = closedRates(lines);
    return { key, buyers: cs.length, share: pct(cs.length, N), codPct: r.codPct, rtoPct: r.rtoPct, closed: r.closed, cancelPct: r.cancelPct, aov: r.aov, repeatPct: pct(cs.filter(repeatOf).length, cs.length) };
  };
  const groupBy = (cs, keyOf, order) => {
    const m = new Map();
    for (const cu of cs) { const k = keyOf(cu); if (k === null || k === undefined) continue; (m.get(k) || m.set(k, []).get(k)).push(cu); }
    const rowsOut = [...m.entries()].map(([k, xs]) => segRow(k, xs));
    return order ? rowsOut.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)) : rowsOut.sort((a, b) => b.buyers - a.buyers);
  };
  const BUCKETS = ['None', '1', '2–3', '4–6', '7+'];
  const byPrior = groupBy(custs, (cu) => bucketOf(priorOrders(cu)), BUCKETS);
  const userType = (cu) => (cu.newToSd ? 'New to ShopDeck' : priorOrders(cu) === 0 ? 'Returning, no order in 12 months' : priorOrders(cu) <= 3 ? 'Light (1–3 orders)' : 'Power (4+ orders)');
  const TYPES = ['New to ShopDeck', 'Returning, no order in 12 months', 'Light (1–3 orders)', 'Power (4+ orders)'];
  const byUserType = groupBy(custs, userType, TYPES);
  const byCategory = groupBy(custs, (cu) => cu.first?.cat || 'Unmatched');
  const byState = groupBy(custs, (cu) => cu.reg || 'Unknown').slice(0, 12);
  const byPayment = groupBy(custs, (cu) => { const pm = cu.firstLines[0].pm; return isCod(pm) ? 'COD' : pm ? 'Prepaid' : 'Unknown'; });

  // ----- could we have predicted it? (buyers with ShopDeck orders before their first Khoj order) -----
  const withPrior = custs.filter((cu) => cu.prior.length);
  const parentSellers = (cu) => new Set(cu.firstProducts.map((p) => p.seller).filter(Boolean));
  const parentProducts = (cu) => new Set(cu.firstProducts.map((p) => ctx.khojToSellerProduct.get(p.id)).filter(Boolean));
  const l4s = (cu) => new Set(cu.firstProducts.map((p) => p.l4).filter(Boolean));
  const catsOf = (cu) => new Set(cu.firstProducts.map((p) => p.cat).filter((c) => c && c !== 'Other'));
  const has = (lines, f) => lines.some(f);
  const predict = (cs) => {
    const known = cs.filter((cu) => cu.prior.some((x) => catOfLine(x).l4));
    return {
      buyers: cs.length,
      sameSeller: pct(cs.filter((cu) => { const ps = parentSellers(cu); return has(cu.prior, (x) => ps.has(x.s)); }).length, cs.length),
      sameProduct: pct(cs.filter((cu) => { const pp = parentProducts(cu); return has(cu.prior, (x) => pp.has(x.p)); }).length, cs.length),
      sameL4: pct(known.filter((cu) => { const ls = l4s(cu); return has(cu.prior, (x) => ls.has(catOfLine(x).l4)); }).length, known.length),
      sameCat: pct(known.filter((cu) => { const cs2 = catsOf(cu); return cs2.size && has(cu.prior, (x) => cs2.has(catOfLine(x).cat)); }).length, known.filter((cu) => catsOf(cu).size).length),
      categoryKnown: known.length
    };
  };
  const predictByCat = [];
  {
    const m = new Map();
    for (const cu of withPrior) { const k = cu.first?.cat || 'Unmatched'; (m.get(k) || m.set(k, []).get(k)).push(cu); }
    for (const [k, cs] of m) predictByCat.push({ key: k, ...predict(cs) });
    predictByCat.sort((a, b) => b.buyers - a.buyers);
  }

  // ----- the parent seller, before and after the first Khoj order -----
  const sellerRel = (cs) => {
    const before = cs.filter((cu) => { const ps = parentSellers(cu); return has(cu.prior, (x) => ps.has(x.s)); }).length;
    const beforeProd = cs.filter((cu) => { const pp = parentProducts(cu); return has(cu.prior, (x) => pp.has(x.p)); }).length;
    const after = cs.filter((cu) => { const ps = parentSellers(cu); return has(cu.after, (x) => ps.has(x.s)); }).length;
    const afterProd = cs.filter((cu) => { const pp = parentProducts(cu); return has(cu.after, (x) => pp.has(x.p)); }).length;
    const afterAny = cs.filter((cu) => cu.after.length).length;
    return { buyers: cs.length, beforePct: pct(before, cs.length), beforeProductPct: pct(beforeProd, cs.length), afterPct: pct(after, cs.length), afterProductPct: pct(afterProd, cs.length), afterAnyPct: pct(afterAny, cs.length) };
  };
  const parent = { ...sellerRel(custs), medianDaysSinceFirst: median(custs.map((cu) => (end - cu.fk) / DAY)) };
  const parentBySeller = [];
  {
    const m = new Map();
    for (const cu of custs) for (const s of parentSellers(cu)) (m.get(s) || m.set(s, []).get(s)).push(cu);
    for (const [s, cs] of m) parentBySeller.push({ key: s, ...sellerRel(cs) });
    parentBySeller.sort((a, b) => b.buyers - a.buyers);
  }

  // ----- price on Khoj vs the same product on the parent seller's site -----
  const siteUnit = new Map();   // seller product id → unit prices paid on the seller site (any of these customers)
  for (const x of rows) if (x.s !== K && x.st !== 'C' && x.q) (siteUnit.get(x.p) || siteUnit.set(x.p, []).get(x.p)).push(x.g / x.q);
  const priceByProduct = new Map();
  for (const x of khojAll) {
    if (x.st === 'C' || !x.q) continue;
    const p = kp(x); if (!p) continue;
    const sp = ctx.khojToSellerProduct.get(p.id); const site = sp && siteUnit.get(sp);
    if (!site?.length) continue;
    const cur = priceByProduct.get(p.id) || { p, khoj: [], site };
    cur.khoj.push(x.g / x.q); priceByProduct.set(p.id, cur);
  }
  const priceRows = [...priceByProduct.values()].map(({ p, khoj, site }) => {
    const k = median(khoj), sv = median(site);
    return { id: p.id, name: p.title, url: ctx.productUrl(p), cat: p.cat, khojOrders: khoj.length, siteOrders: site.length, khojPrice: k, sitePrice: sv, ratio: sv ? k / sv * 100 : null };
  }).filter((r) => r.ratio !== null).sort((a, b) => b.khojOrders - a.khojOrders);
  const weighted = (rs) => { const w = rs.reduce((a, r) => a + r.khojOrders, 0); return w ? rs.reduce((a, r) => a + r.ratio * r.khojOrders, 0) / w : null; };
  const priceByCat = [];
  {
    const m = new Map();
    for (const r of priceRows) (m.get(r.cat) || m.set(r.cat, []).get(r.cat)).push(r);
    for (const [k, rs] of m) priceByCat.push({ key: k, products: rs.length, khojOrders: rs.reduce((a, r) => a + r.khojOrders, 0), medianRatio: median(rs.map((r) => r.ratio)), weightedRatio: weighted(rs) });
    priceByCat.sort((a, b) => b.khojOrders - a.khojOrders);
  }
  const price = { products: priceRows.length, khojOrders: priceRows.reduce((a, r) => a + r.khojOrders, 0), medianRatio: median(priceRows.map((r) => r.ratio)), weightedRatio: weighted(priceRows), cheaperPct: pct(priceRows.filter((r) => r.ratio < 99).length, priceRows.length), byCat: priceByCat, top: priceRows.slice(0, 25) };

  // ----- Khoj vs the same customers on ShopDeck sellers -----
  const khojLines = rows.filter((x) => x.s === K), sdLines = rows.filter((x) => x.s !== K);
  const fkOf = new Map(custs.map((cu) => [cu.c, cu.fk]));
  const compare = { khoj: closedRates(khojLines), shopdeck: closedRates(sdLines), shopdeckBefore: closedRates(sdLines.filter((x) => fkOf.has(x.c) && x.t < fkOf.get(x.c))) };


  // ----- personalisation potential: share of Khoj orders that the customer's earlier orders pointed to -----
  // Signals = any earlier order (ShopDeck sellers and earlier Khoj visits), within N days before the Khoj order.
  const P_WINDOWS = [3, 7, 30, 365];
  const kOrders = [];
  for (const cu of custs) {
    const seenO = new Set();
    for (const x of cu.khoj) { if (seenO.has(x.o)) continue; seenO.add(x.o); const p = kp(x); if (p) kOrders.push({ cu, x, p }); }
  }
  const sigProduct = (sig) => (sig.s === K ? kp(sig) : null);
  const P_LEVELS = [
    ['product', 'The same product', (sig, p) => sig.p === ctx.khojToSellerProduct.get(p.id) || (sig.s === K && sig.p === p.id)],
    ['seller', 'The same parent seller', (sig, p) => sig.s === p.seller || (sig.s === K && sigProduct(sig)?.seller === p.seller)],
    ['l4', 'The same L4 category', (sig, p) => !!p.l4 && catOfLine(sig).l4 === p.l4],
    ['cat', 'The same test category', (sig, p) => p.cat !== 'Other' && catOfLine(sig).cat === p.cat],
    ['any', 'Any of the above', null]
  ];
  const signalsFor = (o, w) => o.cu.all.filter((s) => s.st !== 'C' && s.t < o.x.t - gap && o.x.t - s.t <= w * DAY);
  const hitAt = (o, w) => {
    const sigs = signalsFor(o, w);
    const out = {};
    for (const [k, , f] of P_LEVELS) if (f) out[k] = sigs.some((s) => f(s, o.p));
    out.any = Object.values(out).some(Boolean);
    out.active = sigs.length > 0;
    return out;
  };
  // Browsing on ShopDeck sites (product pages), when the browsing question is connected.
  const browse = new Map();
  for (const b of ctx.browsing || []) (browse.get(b.c) || browse.set(b.c, []).get(b.c)).push(b);
  const lineCat = new Map();
  for (const x of rows) if (x.s !== K && x.p && !lineCat.has(x.p)) { const c = catOfLine(x); if (c.cat || c.l4) lineCat.set(x.p, c); }
  const sellerToKhojP = new Map([...ctx.khojToSellerProduct.entries()].map(([k, sp]) => [sp, k]));
  const browseCat = (b) => {
    const kid = sellerToKhojP.get(b.p) || (ctx.idx.byId.get(b.p) ? b.p : null);
    if (kid && ctx.idx.byId.get(kid)) { const p = ctx.idx.byId.get(kid); return { l4: p.l4 || null, cat: p.cat }; }
    return ctx.sellerProductCat.get(b.p) || lineCat.get(b.p) || { l4: null, cat: null };
  };
  const B_LEVELS = [
    ['b_product', 'Browsed the same product', (b, p) => b.p === p.id || b.p === ctx.khojToSellerProduct.get(p.id)],
    ['b_seller', 'Browsed the same parent seller', (b, p) => b.s === p.seller],
    ['b_l4', 'Browsed the same L4 category', (b, p) => !!p.l4 && browseCat(b).l4 === p.l4],
    ['b_cat', 'Browsed the same test category', (b, p) => p.cat !== 'Other' && browseCat(b).cat === p.cat]
  ];
  const browseHit = (o, w) => {
    const bs = (browse.get(o.cu.c) || []).filter((b) => b.t < o.x.t && o.x.t - b.t <= w * DAY);
    const out = {};
    for (const [k, , f] of B_LEVELS) out[k] = bs.some((b) => f(b, o.p));
    out.b_any = Object.values(out).some(Boolean);
    out.b_active = bs.length > 0;
    return out;
  };
  const hasBrowsing = browse.size > 0;
  const hits = kOrders.map((o) => ({ o, w: Object.fromEntries(P_WINDOWS.map((w) => { const h = hitAt(o, w); if (hasBrowsing) { Object.assign(h, browseHit(o, w)); h.all_any = h.any || h.b_any; } return [w, h]; })) }));
  const personalisation = {
    orders: kOrders.length, windows: P_WINDOWS,
    levels: P_LEVELS.map(([key, label]) => ({ key, label, ...Object.fromEntries(P_WINDOWS.map((w) => [`d${w}`, pct(hits.filter((h) => h.w[w][key]).length, hits.length)])) })),
    browsing: !hasBrowsing ? null : {
      linkedBuyers: pct(custs.filter((cu) => browse.has(cu.c)).length, custs.length),
      levels: [...B_LEVELS, ['b_any', 'Browsed any of these'], ['all_any', 'Orders or browsing: any signal']].map(([key, label]) => ({ key, label, ...Object.fromEntries(P_WINDOWS.map((w) => [`d${w}`, pct(hits.filter((h) => h.w[w][key]).length, hits.length)])) })),
      active: Object.fromEntries(P_WINDOWS.map((w) => [`d${w}`, pct(hits.filter((h) => h.w[w].b_active).length, hits.length)]))
    },
    active: Object.fromEntries(P_WINDOWS.map((w) => [`d${w}`, pct(hits.filter((h) => h.w[w].active).length, hits.length)])),
    byCat: (() => {
      const m = new Map();
      for (const h of hits) { const k = h.o.p.cat || 'Other'; (m.get(k) || m.set(k, []).get(k)).push(h); }
      return [...m.entries()].map(([key, hs]) => ({ key, orders: hs.length,
        l4_30: pct(hs.filter((h) => h.w[30].l4).length, hs.length), cat_30: pct(hs.filter((h) => h.w[30].cat).length, hs.length),
        cat_365: pct(hs.filter((h) => h.w[365].cat).length, hs.length), seller_365: pct(hs.filter((h) => h.w[365].seller).length, hs.length),
        any_7: pct(hs.filter((h) => h.w[7].any).length, hs.length) })).sort((a, b) => b.orders - a.orders);
    })()
  };

  // ----- cross-category: what these buyers bought on ShopDeck before Khoj -----
  const CATSX = ['Saree', 'Kurti & Suits', 'Jewellery', 'Other'];
  const crossCat = [];
  {
    const m = new Map();
    for (const cu of withPrior) { const k = cu.first?.cat || 'Unmatched'; (m.get(k) || m.set(k, []).get(k)).push(cu); }
    for (const [k, cs] of m) {
      const known = cs.filter((cu) => cu.prior.some((x) => catOfLine(x).cat));
      const row = { key: k, buyers: cs.length, known: known.length };
      for (const c of CATSX) row[c] = pct(known.filter((cu) => cu.prior.some((x) => catOfLine(x).cat === c)).length, known.length);
      row.newCategory = pct(known.filter((cu) => !cu.prior.some((x) => catOfLine(x).cat === k)).length, known.length);
      crossCat.push(row);
    }
    crossCat.sort((a, b) => b.buyers - a.buyers);
  }

  // ----- recency: how long before Khoj was their last ShopDeck order -----
  const RECENCY = ['Within 7 days', '8–30 days', '31–90 days', '91+ days', 'None in 12 months'];
  const recencyOf = (cu) => { if (!cu.prior.length) return RECENCY[4]; const d = (cu.fk - cu.prior[cu.prior.length - 1].t) / DAY; return d <= 7 ? RECENCY[0] : d <= 30 ? RECENCY[1] : d <= 90 ? RECENCY[2] : RECENCY[3]; };
  const byRecency = groupBy(custs, recencyOf, RECENCY);

  // ----- journeys: category by month before Khoj, then the Khoj category -----
  const MONTH = (t) => new Date((t + 330) * 60000).toLocaleString('en-IN', { month: 'short', timeZone: 'UTC' });
  const monthKey = (t) => new Date((t + 330) * 60000).toISOString().slice(0, 7);
  const journeyOf = (cu, max = 3) => {
    const months = new Map();
    for (const x of cu.prior) {
      const c = catOfLine(x).cat; if (!c) continue;
      const k = monthKey(x.t); const m = months.get(k) || { label: MONTH(x.t), cats: new Map() };
      m.cats.set(c, (m.cats.get(c) || 0) + 1); months.set(k, m);
    }
    const steps = [...months.entries()].sort().map(([, m]) => ({ label: m.label, cat: [...m.cats.entries()].sort((a, b) => b[1] - a[1])[0][0] }));
    const collapsed = steps.filter((s, i) => i === 0 || s.cat !== steps[i - 1].cat);   // same category month after month = one step
    return collapsed.slice(-max);
  };
  const patterns = new Map();
  for (const cu of custs) {
    const khojCat = cu.first?.cat || 'Unmatched';
    const steps = journeyOf(cu, 2);
    const key = (steps.length ? steps.map((s) => s.cat).join(' → ') : cu.newToSd ? 'New to ShopDeck' : 'No ShopDeck order in 12 months') + ' ⇒ Khoj: ' + khojCat;
    const cur = patterns.get(key) || { key, buyers: 0, repeat: 0, example: null };
    cur.buyers++; if (repeatOf(cu)) cur.repeat++;
    if (!cur.example && steps.length) cur.example = steps.map((s) => `${s.cat} (${s.label})`).join(' → ') + ` ⇒ Khoj ${khojCat} (${MONTH(cu.fk)})`;
    patterns.set(key, cur);
  }
  const journeys = [...patterns.values()].map((x) => ({ ...x, share: pct(x.buyers, N) })).sort((a, b) => b.buyers - a.buyers).slice(0, 20);
  const sameCatAsLast = (() => {
    const cs = custs.filter((cu) => cu.prior.length && cu.first?.cat && catOfLine(cu.prior[cu.prior.length - 1]).cat);
    return { buyers: cs.length, pct: pct(cs.filter((cu) => catOfLine(cu.prior[cu.prior.length - 1]).cat === cu.first.cat).length, cs.length) };
  })();

  // ----- customer table: journey + a one-line read per buyer -----
  const sellerName = new Map();
  for (const x of rows) if (x.sn && !sellerName.has(x.s)) sellerName.set(x.s, x.sn);
  const table = custs.map((cu) => {
    const ps = parentSellers(cu), pp = parentProducts(cu);
    const priorN = priorOrders(cu), priorSellers = new Set(cu.prior.map((x) => x.s)).size;
    const priorCats = [...new Set(cu.prior.map((x) => catOfLine(x).cat).filter(Boolean))];
    const khojCat = cu.first?.cat || null;
    const sellerBefore = cu.prior.filter((x) => ps.has(x.s));
    const repeatLines = cu.khoj.filter((x) => x.t - cu.fk > gap);
    const otherAfter = new Set(cu.after.map((x) => x.s)).size;
    const lastGap = cu.prior.length ? Math.round((cu.fk - cu.prior[cu.prior.length - 1].t) / DAY) : null;
    const firstState = cu.firstLines.map((x) => x.st).includes('R') ? 'R' : cu.firstLines.every((x) => x.st === 'D') ? 'D' : 'O';
    const reads = [];
    if (cu.newToSd) reads.push('First ever ShopDeck order was on Khoj');
    else if (!priorN) reads.push('Lapsed: no ShopDeck order in the 12 months before Khoj');
    else if (priorN >= 4) reads.push(`Power buyer: ${priorN} ShopDeck orders from ${priorSellers} seller${priorSellers > 1 ? 's' : ''} before Khoj`);
    if (sellerBefore.length) { const n = new Set(sellerBefore.map((x) => x.o)).size; reads.push(sellerBefore.some((x) => pp.has(x.p)) ? 'Had bought this exact product on the seller\'s own site' : `Already a customer of this seller (${n} order${n > 1 ? 's' : ''})`); }
    if (khojCat && khojCat !== 'Other' && priorCats.length) reads.push(priorCats.includes(khojCat) ? `Already buys ${khojCat}` : `New category for them (bought ${priorCats.slice(0, 2).join(', ')} before)`);
    if (lastGap !== null && lastGap <= 7) reads.push(lastGap === 0 ? 'Bought on ShopDeck the same day, before Khoj' : `Bought on ShopDeck ${lastGap} day${lastGap > 1 ? 's' : ''} before Khoj`);
    if (repeatLines.length) { const rp = repeatLines.map(kp).filter(Boolean); reads.push(`Came back to Khoj${rp.some((p) => !ps.has(p.seller)) ? ' for another seller\'s product' : ''}`); }
    else if (otherAfter) reads.push(`Since bought from ${otherAfter} other ShopDeck seller${otherAfter > 1 ? 's' : ''}, not Khoj`);
    const bs = (browse.get(cu.c) || []).filter((b) => b.t < cu.fk && cu.fk - b.t <= 7 * DAY);
    if (bs.length) {
      const bc = [...new Set(bs.map((b) => browseCat(b).cat).filter((c) => c && c !== 'Other'))];
      const sameP = cu.firstProducts.some((p) => bs.some((b) => b.p === ctx.khojToSellerProduct.get(p.id) || b.p === p.id));
      reads.push(sameP ? 'Browsed this very product on a seller site in the week before' : `Browsed ${bc.length ? bc.join(', ') : 'products'} on ${new Set(bs.map((b) => b.s)).size} ShopDeck site${new Set(bs.map((b) => b.s)).size > 1 ? 's' : ''} in the week before`);
    }
    if (firstState === 'R') reads.push('First Khoj order returned (RTO)');
    const steps = cu.all.filter((x) => x.st !== 'C').slice(-12).map((x) => {
      const p = x.s === K ? kp(x) : null;
      const sid = x.s === K ? (p?.seller || '') : x.s;
      return { t: x.t, khoj: x.s === K, cat: catOfLine(x).cat, l4: catOfLine(x).l4, name: p ? p.title.slice(0, 70) : (x.n || null), seller: sellerName.get(sid) || (sid ? '…' + sid.slice(-6) : ''), st: x.st, g: Math.round(x.g) };
    });
    const browseSteps = (browse.get(cu.c) || []).filter((b) => b.t < cu.fk).slice(-6).map((b) => {
      const kid = sellerToKhojP.get(b.p); const kpp = kid ? ctx.idx.byId.get(kid) : null; const c = browseCat(b);
      return { t: b.t, khoj: false, browse: true, cat: c.cat, l4: c.l4, name: kpp ? kpp.title.slice(0, 70) : null, seller: sellerName.get(b.s) || (b.s ? '…' + b.s.slice(-6) : ''), st: 'B', g: 0, views: b.v };
    });
    steps.push(...browseSteps); steps.sort((a, b) => a.t - b.t);
    return {
      id: cu.c, type: userType(cu), state: cu.reg, khojCat, firstKhoj: cu.fk, khojOrders: new Set(cu.khoj.map((x) => x.o)).size,
      khojGmv: Math.round(cu.khoj.reduce((a, x) => a + x.g, 0)), pay: isCod(cu.firstLines[0].pm) ? 'COD' : 'Prepaid', firstState,
      priorOrders: priorN, priorSellers, priorCats, lastGap, sellerBefore: sellerBefore.length > 0, repeat: repeatLines.length > 0, otherAfter,
      journey: journeyOf(cu, 4).map((s) => `${s.cat} (${s.label})`).join(' → '), steps, read: reads.slice(0, 4).join(' · ')
    };
  }).sort((a, b) => b.firstKhoj - a.firstKhoj);

  const audience = {
    buyers: N, end, sinceFirst: Math.min(...custs.map((cu) => cu.fk)),
    newToSdPct: pct(custs.filter((cu) => cu.newToSd).length, N),
    noPriorPct: pct(custs.filter((cu) => !cu.prior.length).length, N),
    powerPct: pct(custs.filter((cu) => priorOrders(cu) >= 4).length, N),
    withPrior: withPrior.length,
    medianPriorOrders: median(withPrior.map(priorOrders)),
    medianPriorSellers: median(withPrior.map((cu) => new Set(cu.prior.map((x) => x.s)).size)),
    byPrior, byUserType, byCategory, byState, byPayment,
    predict: predict(withPrior), predictByCat, personalisation, crossCat, byRecency, journeys, sameCatAsLast,
    parent, parentBySeller: parentBySeller.slice(0, 12),
    price, compare
  };

  // ----- repeat -----
  const WINDOWS = [7, 14, 28];
  const within = (cs, w, hit) => { const el = cs.filter((cu) => end - cu.fk >= w * DAY); return { eligible: el.length, pct: el.length ? pct(el.filter((cu) => hit(cu, w)).length, el.length) : null }; };
  const khojRepeat = (cu, w) => cu.khoj.some((x) => x.t - cu.fk > gap && x.t - cu.fk <= w * DAY);
  const sdAfter = (cu, w) => cu.after.some((x) => x.t - cu.fk <= w * DAY);
  const parentAfter = (cu, w) => { const ps = parentSellers(cu); return cu.after.some((x) => ps.has(x.s) && x.t - cu.fk <= w * DAY); };
  const curves = WINDOWS.map((w) => ({ days: w, khoj: within(custs, w, khojRepeat), otherSellers: within(custs, w, sdAfter), parentSeller: within(custs, w, parentAfter) }));

  // Benchmark: the same customers on ShopDeck sellers, from their first seller order in the 12 months:
  // came back to that same seller (a seller site's own repeat) or to any seller, Khoj excluded.
  const bench = WINDOWS.map((w) => {
    let el = 0, same = 0, any = 0;
    for (const cu of custs) {
      const sd = cu.sd; if (!sd.length) continue;
      const f = sd[0]; if (end - f.t < w * DAY) continue;
      el++;
      const later = sd.filter((x) => x.t - f.t > gap && x.t - f.t <= w * DAY);
      if (later.some((x) => x.s === f.s)) same++;
      if (later.length) any++;
    }
    return { days: w, eligible: el, sameSellerPct: pct(same, el), anySellerPct: pct(any, el) };
  });

  // Cohorts by week of first Khoj order (weeks start Monday, IST).
  const weekOf = (t) => { const d = new Date((t + 330) * 60000); const dow = (d.getUTCDay() + 6) % 7; return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow)).toISOString().slice(0, 10); };
  const cohortMap = new Map();
  for (const cu of custs) { const k = weekOf(cu.fk); (cohortMap.get(k) || cohortMap.set(k, []).get(k)).push(cu); }
  const cohorts = [...cohortMap.entries()].sort().map(([week, cs]) => ({ week, customers: cs.length, ...Object.fromEntries(WINDOWS.map((w) => [`w${w}`, within(cs, w, khojRepeat)])) }));

  // What repeat Khoj orders were.
  const repeatLines = custs.flatMap((cu) => cu.khoj.filter((x) => x.t - cu.fk > gap).map((x) => ({ x, cu })));
  const kind = { sameProduct: 0, sameL4: 0, otherL4: 0, unknown: 0, sameParent: 0, otherParent: 0 };
  for (const { x, cu } of repeatLines) {
    const p = kp(x);
    if (!p) { kind.unknown++; continue; }
    if (cu.firstProducts.some((f) => f.id === p.id)) kind.sameProduct++;
    else if (p.l4 && l4s(cu).has(p.l4)) kind.sameL4++;
    else kind.otherL4++;
    if (parentSellers(cu).has(p.seller)) kind.sameParent++; else kind.otherParent++;
  }
  const deliveredFirst = custs.filter((cu) => cu.firstLines.some((x) => x.st === 'D' && x.dt));
  const afterDelivery = (() => {
    const w = 14;
    const el = deliveredFirst.filter((cu) => { const dt = Math.min(...cu.firstLines.filter((x) => x.dt).map((x) => x.dt)); return end - dt >= w * DAY; });
    const hit = el.filter((cu) => { const dt = Math.min(...cu.firstLines.filter((x) => x.dt).map((x) => x.dt)); return cu.khoj.some((x) => x.t > dt && x.t - dt <= w * DAY); });
    return { days: w, eligible: el.length, pct: el.length ? pct(hit.length, el.length) : null, delivered: deliveredFirst.length };
  })();
  const value = WINDOWS.map((w) => {
    const el = custs.filter((cu) => end - cu.fk >= w * DAY);
    const ords = el.map((cu) => new Set(cu.khoj.filter((x) => x.t - cu.fk <= w * DAY).map((x) => x.o)).size);
    const gmv = el.map((cu) => cu.khoj.filter((x) => x.t - cu.fk <= w * DAY).reduce((a, x) => a + x.g, 0));
    return { days: w, eligible: el.length, ordersPerCustomer: el.length ? ords.reduce((a, b) => a + b, 0) / el.length : null, gmvPerCustomer: el.length ? gmv.reduce((a, b) => a + b, 0) / el.length : null };
  });
  const seg14 = {
    COD: within(custs.filter((cu) => isCod(cu.firstLines[0].pm)), 14, khojRepeat),
    Prepaid: within(custs.filter((cu) => !isCod(cu.firstLines[0].pm)), 14, khojRepeat),
    'New to ShopDeck': within(custs.filter((cu) => cu.newToSd), 14, khojRepeat),
    'Returning to ShopDeck': within(custs.filter((cu) => !cu.newToSd), 14, khojRepeat)
  };
  const repeat = {
    seg14,
    customers: N, end, curves, bench, cohorts, kinds: { lines: repeatLines.length, ...kind }, afterDelivery, value,
    repeaters: custs.filter(repeatOf).length, sessionMinutes: gap
  };

  // ----- cross-selling -----
  const sessions = (lines) => {   // a customer's lines with gaps of at most `gap` minutes = one visit
    const out = []; let cur = null;
    for (const x of lines) { if (cur && x.t - cur.last <= gap) { cur.lines.push(x); cur.last = x.t; } else { cur = { lines: [x], last: x.t }; out.push(cur); } }
    return out;
  };
  const basket = (lineSets, parentOf, catOf) => {
    let visits = 0, multi = 0, multiSeller = 0, multiCat = 0, items = 0, gm = [0, 0], gs = [0, 0];
    for (const ls of lineSets) for (const v of sessions(ls)) {
      visits++; items += v.lines.reduce((a, x) => a + x.q, 0);
      const prods = new Set(v.lines.map((x) => x.p)); const g = v.lines.reduce((a, x) => a + x.g, 0);
      if (prods.size > 1) { multi++; gm[0] += g; gm[1]++; } else { gs[0] += g; gs[1]++; }
      if (new Set(v.lines.map(parentOf)).size > 1) multiSeller++;
      const cats = new Set(v.lines.map(catOf).filter(Boolean)); if (cats.size > 1) multiCat++;
    }
    return { visits, itemsPerVisit: visits ? items / visits : null, multiProductPct: pct(multi, visits), multiSellerPct: pct(multiSeller, visits), multiCatPct: pct(multiCat, visits), aovMulti: gm[1] ? gm[0] / gm[1] : null, aovSingle: gs[1] ? gs[0] / gs[1] : null };
  };
  const khojBasket = basket(custs.map((cu) => cu.khoj), (x) => kp(x)?.seller || x.p, (x) => catOfLine(x).l4);
  const sdBasket = basket(custs.map((cu) => cu.sd).filter((l) => l.length), (x) => x.s, (x) => catOfLine(x).l4);
  const breadth = (cs) => ({
    customers: cs.length,
    multiProductPct: pct(cs.filter((cu) => new Set(cu.khoj.map((x) => x.p)).size > 1).length, cs.length),
    multiParentPct: pct(cs.filter((cu) => new Set(cu.khoj.map((x) => kp(x)?.seller).filter(Boolean)).size > 1).length, cs.length),
    multiCatPct: pct(cs.filter((cu) => new Set(cu.khoj.map((x) => catOfLine(x).l4).filter(Boolean)).size > 1).length, cs.length)
  });
  const pairs = new Map();
  for (const cu of custs) {
    const cs = [...new Set(cu.khoj.map((x) => catOfLine(x).l4).filter(Boolean))].sort();
    for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) { const k = `${cs[i]} + ${cs[j]}`; pairs.set(k, (pairs.get(k) || 0) + 1); }
  }
  const cross = {
    khoj: khojBasket, shopdeck: sdBasket, breadth: breadth(custs),
    pairs: [...pairs.entries()].map(([key, customers]) => ({ key, customers })).sort((a, b) => b.customers - a.customers).slice(0, 12),
    sessionMinutes: gap
  };

  return {
    audience, repeat, cross, table,
    coverage: {
      rows: rows.length, khojLines: khojAll.length, customers: N,
      khojMatched: pct(khojAll.filter((x) => kp(x)).length, khojAll.length),
      sdCategoryKnown: pct(sdLines.filter((x) => catOfLine(x).l4).length, sdLines.length),
      from: Math.min(...rows.map((x) => x.t)), to: end
    }
  };
}
