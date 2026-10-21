// Local development only: builds synthetic ads.csv and catalog.csv in DATA_DIR from a real products.csv,
// so every section of the dashboard has something to show before the Metabase ad questions exist.
// Usage: DATA_DIR=./data node scripts/make-fixtures.js   (expects ./data/products.csv)
import fs from 'node:fs';
import path from 'node:path';
import { parseCsv } from '../server/csv.js';
import { categoryOf } from '../server/categories.js';
import { normRow } from '../server/metabase.js';
import { num } from '../server/engine.js';

const dir = process.env.DATA_DIR || './data';
const products = parseCsv(fs.readFileSync(path.join(dir, 'products.csv'), 'utf8')).map(normRow);
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const iso = (d) => d.toISOString().slice(0, 10);
const today = new Date();
const daysAgo = (n) => { const d = new Date(today); d.setUTCDate(d.getUTCDate() - n); return iso(d); };

const hero = (p) => {
  const o = num(p.l30d_orders) || 0, pr = num(p.profit_pct_d40_d10), sp = num(p.l30d_spend) || 0;
  return o >= 300 || (o >= 30 && pr !== null && pr > 0 && sp > 5000);
};
const live = products.filter((p) => p.current_status === 'live');
const pick = (cat, n, offset = 0) => live.filter((p) => categoryOf(p) === cat && hero(p)).slice(offset, offset + n);

// Trial profiles: [days, dailySpend, sgmv%, ctr%] — chosen to hit each rule once
const profiles = [
  [6, 980, 26, 1.4], [3, 800, 90, 0.9], [2, 780, null, 0.6], [7, 1000, 33, 1.2],
  [7, 1000, 24, 1.6], [4, 975, 76, 1.0], [3, 980, null, 0.9], [1, 840, 95, 1.1],
  [5, 996, 28, 1.8], [7, 1005, 24, 2.1], [2, 805, 85, 1.1], [7, 1001, 42, 1.3]
];
const ads = [];
const header = ['date', 'campaign_name', 'adset_id', 'adset_name', 'product_id', 'adset_status', 'daily_budget', 'spend', 'impressions', 'link_clicks', 'add_to_cart', 'purchases', 'gmv'];
let i = 0;
for (const cat of ['Saree', 'Kurti & Suits', 'Jewellery']) {
  for (const p of pick(cat, 4)) {
    const [days, spend, sg, ctr] = profiles[i];
    const id = `trial_${i}`;
    for (let d = days - 1; d >= 0; d--) {
      const imp = Math.round(spend * 9 + rnd() * 400);
      const clicks = Math.round((imp * ctr) / 100);
      const gmv = sg ? Math.round((spend / sg) * 100 * (0.85 + rnd() * 0.3)) : 0;
      const purchases = gmv ? Math.max(1, Math.round(gmv / 900)) : 0;
      ads.push([daysAgo(d), `KHJ | Testing | ${cat}`, id, `Trial | ${cat} | ${p.khoj_product_code}`, p.khoj_product_id, 'ACTIVE', 1000, spend, imp, clicks, sg ? Math.round(clicks * 0.12) + 1 : (i === 6 ? 0 : 2), purchases, gmv]);
    }
    i++;
  }
}
// Scale ad sets: budget histories ending at different steps
const scaleDefs = [
  ['Jewellery', [[1500, 3, 20], [2250, 3, 22], [3400, 4, 24], [5000, 4, 34]]],
  ['Jewellery', [[1500, 3, 18], [2250, 4, 19]]],
  ['Saree', [[1500, 3, 22], [2250, 3, 26], [3400, 4, 29]]],
  ['Saree', [[1000, 3, 27], [1500, 4, 39]]],
  ['Kurti & Suits', [[1500, 2, 27]]]
];
scaleDefs.forEach(([cat, steps], k) => {
  const p = pick(cat, 1, 4 + k)[0];
  if (!p) return;
  const total = steps.reduce((a, s) => a + s[1], 0);
  let back = total - 1;
  for (const [budget, n, marg] of steps) {
    for (let j = 0; j < n; j++) {
      const spend = budget * (0.95 + rnd() * 0.05);
      const gmv = Math.round((spend / marg) * 100);
      ads.push([daysAgo(back--), `KHJ | Scale | ${cat}`, `scale_${k}`, `Scale | ${cat} | ${p.khoj_product_code}`, p.khoj_product_id, 'ACTIVE', budget, Math.round(spend), Math.round(spend * 9), Math.round(spend * 0.15), 40, Math.round(gmv / 900), gmv]);
    }
  }
});
const csv = (rows) => rows.map((r) => r.map((v) => (typeof v === 'string' && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\n') + '\n';
fs.writeFileSync(path.join(dir, 'ads.csv'), csv([header, ...ads]));

// Catalog: 14 days of product-ID spend for ~250 live products
const cat = [['date', 'campaign_name', 'product_id', 'spend', 'impressions', 'link_clicks', 'purchases', 'gmv']];
live.slice(0, 250).forEach((p, k) => {
  const daily = k < 60 ? 150 + rnd() * 250 : rnd() * 60;
  const sg = 15 + rnd() * 50;
  for (let d = 13; d >= 0; d--) {
    const spend = Math.round(daily * (0.6 + rnd() * 0.8));
    const gmv = Math.round((spend / sg) * 100 * (rnd() > 0.3 ? 1 : 0));
    cat.push([daysAgo(d), 'KHJ | Catalog | ToF', p.khoj_product_id, spend, spend * 10, Math.round(spend * 0.12), Math.round(gmv / 900), gmv]);
  }
});
fs.writeFileSync(path.join(dir, 'catalog.csv'), csv(cat));
console.log(`Wrote ${ads.length} ad rows and ${cat.length - 1} catalog rows to ${dir}`);
