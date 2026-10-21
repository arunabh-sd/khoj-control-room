// Loads the three data sources, from Metabase in production or CSV files in DATA_DIR for local work.
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseCsv } from './csv.js';
import { runCard, normRow } from './metabase.js';

const SOURCES = {
  products: { env: 'MB_Q_PRODUCTS', file: 'products.csv' },
  ads: { env: 'MB_Q_ADS', file: 'ads.csv' },
  catalog: { env: 'MB_Q_CATALOG', file: 'catalog.csv' }
};

async function loadOne(name) {
  const src = SOURCES[name];
  const dir = process.env.DATA_DIR;
  if (dir) {
    const file = path.join(dir, src.file);
    try {
      const text = await fs.readFile(file, 'utf8');
      const rows = parseCsv(text);
      return { status: 'ok', origin: `file ${src.file}`, rows: rows.map(normRow) };
    } catch (e) {
      if (e.code === 'ENOENT') return { status: 'missing', origin: `file ${src.file}`, rows: [] };
      throw e;
    }
  }
  const id = process.env[src.env];
  if (!id) return { status: 'missing', origin: `${src.env} not set`, rows: [] };
  const rows = await runCard(id);
  return { status: 'ok', origin: `Metabase Q${id}`, rows };
}

export async function loadSources() {
  const out = {};
  for (const name of Object.keys(SOURCES)) {
    try {
      out[name] = await loadOne(name);
    } catch (e) {
      out[name] = { status: 'error', origin: SOURCES[name].env, error: e.message, rows: [] };
    }
  }
  out.loadedAt = new Date().toISOString();
  return out;
}
