import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compute } from '../server/engine.js';
import { DEFAULT_SETTINGS } from '../server/rules.js';
const S = { ...DEFAULT_SETTINGS, metaSgmvFactor: 1 };
import { parseCsv } from '../server/csv.js';

const product = (id, extra = {}) => ({
  khoj_product_id: id, khoj_product_code: 'CODE' + id, product_title: 'P ' + id, current_status: 'live',
  l30d_spend: '20000', l30d_orders: '400', l30d_s_gmv: '0.2', profit_pct_d40_d10: '5',
  khoj_category_l2: 'womens-clothing', khoj_category_l3: 'ethnic-wear', khoj_category_l4: 'sarees', ...extra
});
const day = (adset, spend, gmv, extra = {}) => ({
  date: '2026-10-20', campaign_name: 'KHJ | Testing | Saree', adset_id: adset, adset_name: 'Trial ' + adset,
  product_id: adset.replace('a', ''), adset_status: 'ACTIVE', spend, impressions: 10000, link_clicks: 150,
  add_to_cart: 20, purchases: gmv ? 5 : 0, gmv, ...extra
});
const src = (products, ads = [], catalog = []) => ({
  products: { status: 'ok', rows: products }, ads: { status: 'ok', rows: ads }, catalog: { status: 'ok', rows: catalog }
});
const actionOf = (r, id) => r.trials.find((t) => t.id === 'p:' + id.replace('a', '')).action;

test('hero rule: 300+ all, 30–299 needs profit > 0 and spend > 5000', () => {
  const r = compute(src([
    product('1', { l30d_orders: '300', profit_pct_d40_d10: '-20' }),
    product('2', { l30d_orders: '30', l30d_spend: '6000', profit_pct_d40_d10: '1' }),
    product('3', { l30d_orders: '30', l30d_spend: '5000', profit_pct_d40_d10: '1' }),
    product('4', { l30d_orders: '29' })
  ]), S, []);
  const saree = r.coverage.find((c) => c.key === 'Saree');
  assert.equal(saree.hero, 2);
  assert.equal(saree.tierA, 1);
  assert.equal(saree.tierB, 1);
});

test('trial verdicts at 7k: graduate ≤ 30%, extend ≤ 36%, kill above', () => {
  const r = compute(src([product('1'), product('2'), product('3')], [
    day('a1', 7000, 7000 / 0.29), day('a2', 7000, 7000 / 0.33), day('a3', 7000, 7000 / 0.40)
  ]), S, []);
  assert.equal(actionOf(r, 'a1'), 'graduate');
  assert.equal(actionOf(r, 'a2'), 'extend');
  assert.equal(actionOf(r, 'a3'), 'kill');
});

test('extended trial waits for 14k, then graduates or kills', () => {
  const history = [{ action: 'extend', adset_id: 'p:1' }, { action: 'extend', adset_id: 'p:2' }];
  const r1 = compute(src([product('1')], [day('a1', 9000, 9000 / 0.33)]), S, history);
  assert.equal(actionOf(r1, 'a1'), 'continue');
  const r2 = compute(src([product('1'), product('2')], [day('a1', 14000, 14000 / 0.29), day('a2', 14000, 14000 / 0.33)]), S, history);
  assert.equal(actionOf(r2, 'a1'), 'graduate');
  assert.equal(actionOf(r2, 'a2'), 'kill');
});

test('early gates: low CTR, no add-to-carts, zero orders past 3x target CPP', () => {
  const r = compute(src([product('1'), product('2'), product('3'), product('4')], [
    day('a1', 1600, 0, { link_clicks: 50 }),
    day('a2', 1600, 0, { add_to_cart: 0 }),
    day('a3', 1000, 0),
    day('a4', 1000, 3000)
  ]), S, []);
  assert.equal(actionOf(r, 'a1'), 'kill');
  assert.equal(actionOf(r, 'a2'), 'kill');
  assert.equal(actionOf(r, 'a3'), 'kill'); // target CPP = 30% × AOV(₹250) = ₹75; 3× = ₹225
  assert.equal(actionOf(r, 'a4'), 'continue');
});

test('free trial slots create new-trial tasks from live, untested hero products', () => {
  const r = compute(src([product('1'), product('2'), product('3'), product('9', { current_status: 'delive' })]), S, []);
  const trials = r.tasks.filter((t) => t.segment === 'trial' && t.category === 'Saree');
  assert.ok(trials.length >= 1);
  assert.ok(trials.every((t) => !t.id.endsWith(':9')));
});

test('csv parser handles quotes, commas and newlines', () => {
  const rows = parseCsv('a,b\n"1,000","say ""hi""\nthere"\n');
  assert.deepEqual(rows, [{ a: '1,000', b: 'say "hi"\nthere' }]);
});

test('Meta Spend/GMV correction: reported 40% is judged as 36%', () => {
  const r = compute(src([product('1')], [day('a1', 7000, 7000 / 0.40)]), DEFAULT_SETTINGS, []);
  const t = r.trials[0];
  assert.equal(Math.round(t.sgmv), 36);
  assert.equal(t.action, 'extend');
});

test('original and "– Copy" ad sets of one product are one trial', () => {
  const rows = [
    day('a1', 3000, 10000, { adset_name: 'Saree | X | Creatives', campaign_name: '[Testing] | Saree | ABO', product_id: '' }),
    day('a2', 4000, 14000, { adset_name: 'Saree | X | Creatives', campaign_name: '[Testing] | Saree | ABO – Copy', product_id: '' })
  ];
  const r = compute(src([product('1')], rows), S, []);
  assert.equal(r.trials.length, 1);
  assert.equal(r.trials[0].spend, 7000);
});

test('paused trial before verdict is closed as stopped and frees the slot', () => {
  const rows = [
    day('a1', 3000, 3000, { date: '2026-10-10' }),
    day('a2', 1000, 4000, { date: '2026-10-20' })
  ].map((r) => ({ ...r, adset_status: undefined }));
  const r = compute(src([product('1'), product('2'), product('3')], rows), S, []);
  assert.equal(actionOf(r, 'a1'), 'stopped');
  assert.equal(actionOf(r, 'a2'), 'continue');
});

test('ad set → product map: trusts ≥50% share or a title match, and links copies by name', () => {
  const prods = [product('1', { product_title: 'Banarasi Semi-Silk Saree' }), product('2', { product_title: 'Kota Doria Kurtis' }), product('3', { product_title: 'Magenta Shraddha Narayanpet Cotton' })];
  const ads = [
    day('x1', 4000, 9000, { adset_id: 'A1', adset_name: 'Saree | Banarasi Semi-Silk | Creatives', product_id: '' }),
    day('x2', 3000, 9000, { adset_id: 'A2', adset_name: 'Saree | Banarasi Semi-Silk | Creatives', product_id: '', campaign_name: 'KHJ | Testing | Saree – Copy' }),
    day('x3', 2000, 4000, { adset_id: 'B1', adset_name: 'Saree | Magenta Shraddha Narayanpet | Creatives', product_id: '' }),
    day('x4', 2000, 4000, { adset_id: 'C1', adset_name: 'Saree | Royal Blue | Creatives', product_id: '' })
  ];
  const map = [
    { adset_id: 'A2', product_id: '1', product_spend: 2700, share_of_adset: 0.9 },
    { adset_id: 'B1', product_id: '3', product_spend: 100, share_of_adset: 0.05 },
    { adset_id: 'C1', product_id: '2', product_spend: 90, share_of_adset: 0.04 }
  ];
  const r = compute({ ...src(prods, ads), adsetMap: { status: 'ok', rows: map } }, S, []);
  const by = (n) => r.trials.find((t) => t.name.includes(n));
  assert.equal(by('Banarasi').product, 'Banarasi Semi-Silk Saree');
  assert.equal(by('Banarasi').spend, 7000);           // original A1 linked through its copy's name
  assert.equal(by('Magenta').product, 'Magenta Shraddha Narayanpet Cotton'); // low share, title matches
  assert.equal(by('Royal Blue').product, null);        // low share, no title match → not trusted
});

test('verdict uses the recent half of spend: a slow start does not kill a product that recovered', () => {
  const d = (date, spend, gmv) => day('a1', spend, gmv, { date });
  const rows = [
    d('2026-10-04', 1500, 1500 / 1.5), d('2026-10-05', 1500, 1500 / 1.5),     // learning: 150%
    d('2026-10-15', 2000, 2000 / 0.24), d('2026-10-16', 2000, 2000 / 0.24)    // settled: 24%
  ];
  const r = compute(src([product('1')], rows), S, []);
  const t = r.trials[0];
  assert.ok(t.sgmv > 36);                 // overall would have killed it
  assert.equal(Math.round(t.recentSgmv), 24);
  assert.equal(t.action, 'graduate');
});

test('kills only when both lifetime and recent are bad', () => {
  const d = (date, spend, gmv) => day('a1', spend, gmv, { date });
  const r = compute(src([product('1')], [d('2026-10-04', 3500, 3500 / 0.40), d('2026-10-15', 3500, 3500 / 0.45)]), S, []);
  assert.equal(r.trials[0].action, 'kill');
});

test('lifetime better than recent: verdict takes lifetime', () => {
  const d = (date, spend, gmv) => day('a1', spend, gmv, { date });
  const r = compute(src([product('1')], [d('2026-10-04', 3500, 3500 / 0.20), d('2026-10-15', 3500, 3500 / 0.38)]), S, []);
  const t = r.trials[0];
  assert.equal(t.verdictBasis, 'lifetime');
  assert.equal(Math.round(t.verdictSgmv), 26);
  assert.equal(t.action, 'graduate');
});

test('product link format', async () => {
  const { productUrl } = await import('../server/engine.js');
  assert.equal(productUrl({ id: 'ngVJlfb6', title: 'Floral Print Daily Wear Cotton Linen Saree (Pink)', skus: ['QF9ZvCv7'] }),
    'https://khoj.shopdeck.com/Floral-Print-Daily-Wear-Cotton-Linen-Saree--Pink-/catalogue/ngVJlfb6/QF9ZvCv7');
});

test('kill review: improving when stopped is flagged, bad throughout is right', () => {
  const d = (adset, date, spend, gmv) => day(adset, spend, gmv, { date, adset_status: undefined });
  const rows = [
    d('a1', '2026-10-04', 2000, 2000 / 1.2), d('a1', '2026-10-06', 2000, 2000 / 0.31),   // bad start, good finish, paused
    d('a2', '2026-10-04', 2000, 2000 / 0.9), d('a2', '2026-10-06', 2000, 2000 / 0.8),    // bad throughout, paused
    d('a3', '2026-10-20', 1000, 4000)                                                  // live, sets the reference date
  ];
  const r = compute(src([product('1'), product('2'), product('3')], rows), S, []);
  const by = (id) => r.killReview.find((k) => k.product === 'P ' + id);
  assert.equal(by('1').verdict, 'recheck');
  assert.equal(by('2').verdict, 'right');
});

test('product signal: overall product spend with an accurate S/GMV column, no Meta correction', () => {
  const rows = [
    { product_id: '1', spend: '3000', s_gmv: '0.24' },   // fraction
    { product_id: '2', spend: '2000', s_gmv: '45' },     // percent
    { product_id: '3', spend: '800', s_gmv: '0.10' }     // too little spend to read
  ];
  const r = compute(src([product('1'), product('2'), product('3')], [], rows), DEFAULT_SETTINGS, []);
  const by = (id) => r.catalog.items.find((i) => i.productId === id);
  assert.equal(Math.round(by('1').sgmv), 24);
  assert.equal(by('1').read, 'hit');
  assert.equal(Math.round(by('2').sgmv), 45);
  assert.equal(by('2').read, 'miss');
  assert.equal(by('3').read, 'thin');
});

test('product signal (Q16674 shape): lifetime spend for eligibility, recent spend for the read', () => {
  const rows = [
    { product_id: '1', spend_date: '11-10-2026', product_spend: '1500', product_gmv: '1500' },   // early: 100%
    { product_id: '1', spend_date: '18-10-2026', product_spend: '1500', product_gmv: '6000' },   // recent: 25%
    { product_id: '2', spend_date: '18-10-2026', product_spend: '900', product_gmv: '9000' }     // under ₹1,500 lifetime
  ];
  const r = compute(src([product('1'), product('2')], [], rows), DEFAULT_SETTINGS, []);
  const p1 = r.catalog.items.find((i) => i.productId === '1');
  assert.equal(Math.round(p1.lifetimeSgmv), 40);
  assert.equal(Math.round(p1.sgmv), 25);
  assert.equal(p1.read, 'hit');
  assert.equal(r.catalog.items.find((i) => i.productId === '2').read, 'thin');
});

test('universe: product rows (Q16457 shape) and pre-aggregated rows give the same funnel', async () => {
  const { compactUniverse } = await import('../server/universe.js');
  const raw = [
    { seller_id: 'TOTAL', seller_product_id: '3 products' },
    { seller_id: 's', khoj_product_id: 'k1', current_status: 'live', seller_product_pq: '3.5', l30d_orders: '400', l30d_spend: '9000', profit_pct_d40_d10: '-5', category_l2: 'womens-clothing', category_l3: 'ethnic-wear', category_l4: 'sarees' },
    { seller_id: 's', khoj_product_id: 'k2', current_status: 'delive', seller_product_pq: '4', l30d_orders: '40', l30d_spend: '6000', profit_pct_d40_d10: '2', category_l2: 'womens-clothing', category_l3: 'ethnic-wear', category_l4: 'sarees' },
    { seller_id: 's', khoj_product_id: '', current_status: 'not uploaded', seller_product_pq: '3', l30d_orders: '2', category_l2: 'womens-clothing', category_l3: 'ethnic-wear', category_l4: 'sarees' },
    { seller_id: 's', khoj_product_id: '', current_status: 'not uploaded', seller_product_pq: '2.5', l30d_orders: '900', category_l2: 'womens-clothing', category_l3: 'ethnic-wear', category_l4: 'sarees' }
  ];
  const agg = [{ category_l2: 'womens-clothing', category_l3: 'ethnic-wear', category_l4: 'sarees', sd_products: 3, uploaded: 2, live: 1, sd_hero_products: 2, hero_uploaded: 2, hero_live: 1 }];
  for (const rows of [compactUniverse(raw), agg]) {
    const r = compute({ ...src([product('1')]), universe: { status: 'ok', rows } }, S, []);
    assert.deepEqual(r.universe.byCat.Saree, { all: 3, uploaded: 2, live: 1, hero: 2, heroUploaded: 2, heroLive: 1 });
  }
});
