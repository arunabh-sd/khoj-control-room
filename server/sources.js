// Loads the data sources, from Metabase in production or CSV files in DATA_DIR for local work.
// Metabase is only called when the page asks for it (page load or Refresh), one question per request.
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseCsv } from './csv.js';
import { runCard, normRow } from './metabase.js';
import { compactUniverse } from './universe.js';

const SOURCES = {
  products: { env: 'MB_Q_PRODUCTS', file: 'products.csv', label: 'Products' },
  ads: { env: 'MB_Q_ADS', file: 'ads.csv', label: 'Trial and scale ads' },
  catalog: { env: 'MB_Q_PRODUCT_SPEND', alt: 'MB_Q_CATALOG', file: 'catalog.csv', label: 'Product-wise spend (all campaigns)' },
  adsetMap: { env: 'MB_Q_ADSET_MAP', file: 'adset_map.csv', label: 'Ad set → product map' },
  overlap: { env: 'MB_Q_OVERLAP', file: 'overlap.csv', label: 'Khoj × parent seller buyer overlap' },
  universe: { env: 'MB_Q_UNIVERSE', params: 'MB_Q_UNIVERSE_PARAMS', file: 'universe.csv', label: 'ShopDeck universe (PQ ≥ 3)',
    compact: (rows) => compactUniverse(rows, { minPq: Number(process.env.UNIVERSE_MIN_PQ ?? 3) }) }
};
export const SOURCE_NAMES = Object.keys(SOURCES);
export const SOURCE_LABELS = Object.fromEntries(SOURCE_NAMES.map((k) => [k, SOURCES[k].label]));

export async function loadOne(name) {
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
    const id = process.env[src.env] || (src.alt && process.env[src.alt]);
    if (!id) return { status: 'missing', origin: `${src.env} not set`, rows: [], loadedAt };
    let rows = await runCard(id, src.params ? process.env[src.params] : '');
    const rawRows = rows.length;
    if (src.compact) rows = src.compact(rows);
    return { status: 'ok', origin: `Metabase Q${id}`, rows, rawRows, loadedAt };
  } catch (e) {
    const id = process.env[src.env] || (src.alt && process.env[src.alt]);
    return { status: 'error', origin: id ? `Metabase Q${id}` : src.env, error: e.message, rows: [], loadedAt };
  }
}
