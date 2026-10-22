// Turns a Metabase export of the universe question (Q16457, ~240k rows) into the same compact rows the server keeps,
// in the browser, so a stale copy can be uploaded as the fallback when Metabase can't return it in time.
// Mirrors server/universe.js (compactUniverse) and server/csv.js.
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[,₹%\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const normKey = (k) => String(k).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); field = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map(normKey);
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

export function compactUniverseCsv(text, minPq = 3) {
  const rows = parseCsv(text);
  if (!rows.length || !('seller_product_id' in rows[0] || 'sd_products' in rows[0])) throw new Error('This doesn\'t look like the universe question (no seller_product_id column)');
  const out = [], agg = new Map();
  for (const r of rows) {
    if (String(r.seller_id || '').toUpperCase() === 'TOTAL') continue;
    const pq = num(r.seller_product_pq);
    if (pq !== null && pq < minPq) continue;
    const l2 = r.category_l2 || '', l3 = r.category_l3 || '', l4 = r.category_l4 || '';
    const uploaded = r.khoj_product_id ? 1 : 0;
    const live = String(r.current_status || '').toLowerCase() === 'live' ? 1 : 0;
    const orders = num(r.l30d_orders) || 0;
    if (orders >= 10 || uploaded) {
      out.push({ category_l2: l2, category_l3: l3, category_l4: l4, n: 1, uploaded, live, l30d_orders: orders, l30d_spend: num(r.l30d_spend) || 0,
        profit_pct_d40_d10: num(r.profit_pct_d40_d10), pq: pq ?? undefined, seller_product_id: r.seller_product_id || undefined,
        khoj_product_id: r.khoj_product_id || undefined, product_title: uploaded ? undefined : r.product_title });
      continue;
    }
    const w = num(r.n) || 1;
    const key = [l2, l3, l4, uploaded, live].join('|');
    const a = agg.get(key) || { category_l2: l2, category_l3: l3, category_l4: l4, n: 0, uploaded: 0, live: 0 };
    a.n += w; a.uploaded += uploaded * w; a.live += live * w;
    agg.set(key, a);
  }
  return { rows: out.concat([...agg.values()]), rawRows: rows.length };
}

// gzip in the browser so the upload stays well under the 6 MB function limit.
export async function gzipJson(obj) {
  const stream = new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
