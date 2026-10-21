// Loads the data sources, from Metabase in production or CSV files in DATA_DIR for local work.
// Metabase is only called when the page asks for it (page load or Refresh), one question per request.
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseCsv } from './csv.js';
import { runCard, normRow } from './metabase.js';

const SOURCES = {
  products: { env: 'MB_Q_PRODUCTS', file: 'products.csv', label: 'Products' },
  ads: { env: 'MB_Q_ADS', file: 'ads.csv', label: 'Trial and scale ads' },
  catalog: { env: 'MB_Q_CATALOG', file: 'catalog.csv', label: 'Catalog product spend' }
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
        const rows = parseCsv(await fs.readFile(path.join(dir, src.file), 'utf8')).map(normRow);
        return { status: 'ok', origin: `file ${src.file}`, rows, loadedAt };
      } catch (e) {
        if (e.code === 'ENOENT') return { status: 'missing', origin: `file ${src.file}`, rows: [], loadedAt };
        throw e;
      }
    }
    const id = process.env[src.env];
    if (!id) return { status: 'missing', origin: `${src.env} not set`, rows: [], loadedAt };
    const rows = await runCard(id);
    return { status: 'ok', origin: `Metabase Q${id}`, rows, loadedAt };
  } catch (e) {
    return { status: 'error', origin: process.env[src.env] ? `Metabase Q${process.env[src.env]}` : src.env, error: e.message, rows: [], loadedAt };
  }
}
