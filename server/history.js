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
    if (/(^|,)first_order(,|$)/.test(meta)) row.ff = 1;
    const l2 = r.category_l2 ?? r.khoj_category_l2, l3 = r.category_l3 ?? r.khoj_category_l3, l4 = r.category_l4 ?? r.khoj_category_l4;
    if (l4) { row.l2 = l2; row.l3 = l3; row.l4 = l4; }
    out.push(row);
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
    return ctx.sellerProductCat.get(x.p) || { l4: null, cat: null };
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

  const audience = {
    buyers: N, end, sinceFirst: Math.min(...custs.map((cu) => cu.fk)),
    newToSdPct: pct(custs.filter((cu) => cu.newToSd).length, N),
    noPriorPct: pct(custs.filter((cu) => !cu.prior.length).length, N),
    powerPct: pct(custs.filter((cu) => priorOrders(cu) >= 4).length, N),
    withPrior: withPrior.length,
    medianPriorOrders: median(withPrior.map(priorOrders)),
    medianPriorSellers: median(withPrior.map((cu) => new Set(cu.prior.map((x) => x.s)).size)),
    byPrior, byUserType, byCategory, byState, byPayment,
    predict: predict(withPrior), predictByCat,
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
  const repeat = {
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
    audience, repeat, cross,
    coverage: {
      rows: rows.length, khojLines: khojAll.length, customers: N,
      khojMatched: pct(khojAll.filter((x) => kp(x)).length, khojAll.length),
      sdCategoryKnown: pct(sdLines.filter((x) => catOfLine(x).l4).length, sdLines.length),
      from: Math.min(...rows.map((x) => x.t)), to: end
    }
  };
}
