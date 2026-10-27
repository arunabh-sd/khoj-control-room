// Loads the data sources, from Metabase in production or CSV files in DATA_DIR for local work.
// Metabase is only called when the page asks for it (page load or Refresh), one question per request.
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseCsv } from './csv.js';
import { runCard, normRow } from './metabase.js';
import { compactUniverse } from './universe.js';
import { compactHistory, compactBrowsing } from './history.js';

const SOURCES = {
  // Overall Status: Khoj day-wise orders, GMV, spend and ad funnel (Q16083). Too slow for a page load, so it's
// pre-pulled every hour by the scheduled job.
  daywise: { env: 'MB_Q_DAYWISE', file: 'daywise.csv', label: 'Khoj day-wise (orders, GMV, spend)', everyHours: 1 },
  // P&L (Q16167), run once per date window at that window's predicted RTO: today, yesterday, L3D, L7D and the 7
  // days before, every 2 hours; each week since launch and since launch, once a day.
  pnl: { env: 'MB_Q_PNL', file: 'pnl.csv', label: 'Khoj P&L: today, yesterday, L3D, L7D', everyHours: 2 },
  pnlWeeks: { env: 'MB_Q_PNL', file: 'pnl_weeks.csv', label: 'Khoj P&L: weeks since launch', everyHours: 24 },
  // Khoj's own orders since launch (sql/khoj_orders.sql): new vs repeat orders by day. Small; every hour.
  khojOrders: { env: 'MB_Q_KHOJ_ORDERS', file: 'khoj_orders.csv', label: 'Khoj orders (new vs repeat)', everyHours: 1 },
  // Early signs of likability, Khoj vs parent sellers on comparable products, weighted by Khoj orders (the questions
  // compute the weighting themselves and return an "ALL" row).
  rating: { env: 'MB_Q_RATING', id: '16826', file: 'rating.csv', label: 'User rating: Khoj vs parent (comparable products)', everyHours: 24 },
  returns: { env: 'MB_Q_RETURNS', id: '16859', file: 'returns.csv', label: 'Return requests per delivered order: Khoj vs parent', everyHours: 24 },
  bumper: { env: 'MB_Q_BUMPER', id: '16830', file: 'bumper.csv', label: 'Bumper coupon use: Khoj vs parent', everyHours: 24 },
  products: { env: 'MB_Q_PRODUCTS', file: 'products.csv', label: 'Products', everyHours: 6 },
  ads: { env: 'MB_Q_ADS', file: 'ads.csv', label: 'Trial and scale ads' },
  catalog: { env: 'MB_Q_PRODUCT_SPEND', alt: 'MB_Q_CATALOG', file: 'catalog.csv', label: 'Product-wise spend (all campaigns)' },
  adsetMap: { env: 'MB_Q_ADSET_MAP', file: 'adset_map.csv', label: 'Ad set → product map' },
  overlap: { env: 'MB_Q_OVERLAP', file: 'overlap.csv', label: 'Khoj × parent seller buyer overlap', everyHours: 24 },
  history: { env: 'MB_Q_CUSTOMER_HISTORY', file: 'history.csv', label: 'Khoj buyers\' ShopDeck order history (12 months)', compact: compactHistory, everyHours: 24 },
  browsing: { env: 'MB_Q_BROWSING', file: 'browsing.csv', label: 'Khoj buyers\' browsing on ShopDeck sites', compact: compactBrowsing, everyHours: 24 },
  // Phase 2: asked about Khoj plus the parent sellers of Khoj's ordered products (passed as {{parent_sellers}}),
  // so they run after products and order history, at half past the hour.
  events: { env: 'MB_Q_EVENTS', file: 'events.csv', label: 'Site sessions: Khoj vs parent sellers', everyHours: 24, phase: 2 },
  personalise: { env: 'MB_Q_PERSONALISE', file: 'personalise.csv', label: 'Khoj visitors: personalisation potential', everyHours: 24, phase: 2 },
  prodQuality: { env: 'MB_Q_PRODUCT_QUALITY', file: 'prod_quality.csv', label: 'Order quality: Khoj vs the same products on seller sites', everyHours: 24, phase: 2 },
  revisit: { env: 'MB_Q_REVISIT', file: 'revisit.csv', label: 'Visits after delivery: Khoj vs parent sellers', everyHours: 24, phase: 2 },
  benchmark: { env: 'MB_Q_BENCHMARK', file: 'benchmark.csv', label: 'Repeat benchmark: parent sellers', everyHours: 24, phase: 2 },
  // Phase 3: the heaviest question gets its own scheduled function, so if it runs out of time it can't take the
  // others down with it.
  universe: { env: 'MB_Q_UNIVERSE', params: 'MB_Q_UNIVERSE_PARAMS', file: 'universe.csv', label: 'ShopDeck universe (PQ ≥ 3)', everyHours: 24, phase: 3,
    compact: (rows) => compactUniverse(rows, { minPq: Number(process.env.UNIVERSE_MIN_PQ ?? 3) }) }
};
export const SOURCE_NAMES = Object.keys(SOURCES);
export const SOURCE_LABELS = Object.fromEntries(SOURCE_NAMES.map((k) => [k, SOURCES[k].label]));
// Slow questions on a schedule (netlify/functions/daily.mjs), never on page load or Refresh:
// universe, order history and overlap once a day; products (seller L30D numbers, slow to compute) every 6 hours.
export const DAILY_SOURCES = SOURCE_NAMES.filter((k) => SOURCES[k].everyHours);
export const EVERY_HOURS = Object.fromEntries(DAILY_SOURCES.map((k) => [k, SOURCES[k].everyHours]));
export const PHASE = Object.fromEntries(DAILY_SOURCES.map((k) => [k, SOURCES[k].phase || 1]));

export async function loadOne(name, { timeoutMs, params, paramSets } = {}) {
  const src = SOURCES[name];
  if (!src) throw new Error(`Unknown source ${name}`);
  const loadedAt = new Date().toISOString();
  if (process.env.DEV_DELAY_MS) await new Promise((r) => setTimeout(r, Number(process.env.DEV_DELAY_MS)));
  try {
    const dir = process.env.DATA_DIR;
    if (dir) {
      try {
        let rows = parseCsv(await fs.readFile(path.join(dir, src.file), 'utf8')).map(normRow);
        const rawRows = rows.length;
        if (src.compact) rows = src.compact(rows);
        return { status: 'ok', origin: `file ${src.file}`, rows, rawRows, loadedAt };
      } catch (e) {
        if (e.code === 'ENOENT') return { status: 'missing', origin: `file ${src.file}`, rows: [], loadedAt };
        throw e;
      }
    }
    const id = process.env[src.env] || (src.alt && process.env[src.alt]) || src.id || '';
    if (!id) return { status: 'missing', origin: `${src.env} not set`, rows: [], loadedAt };
    let rows;
    if (paramSets?.length) {
      // One question, several parameter sets (e.g. P&L per date window): run them together, tag each row.
      const parts = await Promise.all(paramSets.map(async (ps) => (await runCard(id, '', { timeoutMs, params: ps.params })).map((r) => ({ ...r, window: ps.label, window_start: ps.params.start_date, window_end: ps.params.end_date, window_rto: ps.params.rto_pct }))));
      rows = parts.flat();
    } else rows = await runCard(id, src.params ? process.env[src.params] : '', { timeoutMs, params });
    const rawRows = rows.length;
    if (src.compact) rows = src.compact(rows);
    return { status: 'ok', origin: `Metabase Q${id}`, rows, rawRows, loadedAt };
  } catch (e) {
    const id = process.env[src.env] || (src.alt && process.env[src.alt]) || src.id || '';
    return { status: 'error', origin: id ? `Metabase Q${id}` : src.env, error: e.message, rows: [], loadedAt };
  }
}
