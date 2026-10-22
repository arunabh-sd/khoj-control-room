// Daily Meta product-breakdown CSV (Ads Manager → Breakdown → By dynamic creative element → Product ID).
// Meta's product id is the Khoj SKU id. Rows are kept per date + SKU; a new upload replaces the dates it covers.
import { parseCsv } from './csv.js';
import { normRow } from './metabase.js';
import { num, day } from './engine.js';

const KEY = 'upload:meta-products';
const KEEP_DAYS = 120;

const pick = (r, keys) => { for (const k of keys) if (r[k] !== undefined && r[k] !== '') return r[k]; return undefined; };
const SPEND = ['amount_spent_inr', 'amount_spent', 'spend', 'cost'];
const GMV = ['purchases_conversion_value', 'website_purchases_conversion_value', 'purchase_conversion_value', 'conversion_value', 'gmv', 'purchase_value'];
const PURCH = ['purchases', 'website_purchases', 'results', 'orders'];
const SKU = ['product_id', 'sku_id', 'retailer_id', 'product_retailer_id', 'content_id', 'item_id'];
const DATE = ['day', 'date', 'reporting_starts', 'reporting_start'];

export function parseMetaCsv(text, uploadDate) {
  const rows = parseCsv(String(text || '').replace(/^﻿/, '')).map(normRow);
  if (!rows.length) throw new Error('The file has no rows');
  const cols = Object.keys(rows[0]);
  const has = (list) => list.some((k) => cols.includes(k));
  if (!has(SKU)) throw new Error(`No product ID column found. Columns: ${cols.join(', ')}`);
  if (!has(SPEND)) throw new Error(`No amount spent column found. Columns: ${cols.join(', ')}`);
  const out = [];
  for (const r of rows) {
    let sku = String(pick(r, SKU) ?? '').trim();
    if (!sku || /^(all|total|unknown)$/i.test(sku)) continue;
    sku = sku.split(/[\s,|]+/)[0];
    const spend = num(pick(r, SPEND)) ?? 0;
    const gmv = num(pick(r, GMV)) ?? 0;
    if (!spend && !gmv) continue;
    out.push({ date: day(pick(r, DATE)) || uploadDate, sku_id: sku, spend, gmv, purchases: num(pick(r, PURCH)) ?? 0 });
  }
  if (!out.length) throw new Error('No rows with a product ID and spend');
  return out;
}

export async function saveMetaUpload(store, { name, text }, today) {
  const rows = parseMetaCsv(text, today);
  const cur = (await store.getKV(KEY)) || { rows: [], files: [] };
  const dates = new Set(rows.map((r) => r.date));
  const cutoff = new Date(Date.parse(today) - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  const kept = cur.rows.filter((r) => !dates.has(r.date) && r.date >= cutoff);
  const merged = [...kept, ...rows];
  const sorted = [...dates].sort();
  const file = { name: String(name || 'upload.csv').slice(0, 120), at: new Date().toISOString(), rows: rows.length, from: sorted[0], to: sorted.at(-1) };
  await store.setKV(KEY, { rows: merged, files: [file, ...cur.files].slice(0, 60) });
  return file;
}

export async function loadMetaUpload(store) {
  const cur = store.getKV ? await store.getKV(KEY) : null;
  return { status: cur?.rows?.length ? 'ok' : 'missing', rows: cur?.rows || [], files: cur?.files || [] };
}

export async function clearMetaUpload(store) { await store.setKV(KEY, { rows: [], files: [] }); }
