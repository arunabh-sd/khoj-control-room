// Minimal Metabase client: runs a saved question (card) and returns rows as objects
// with normalised snake_case keys, so "Seller ID" and "seller_id" both become seller_id.

export function normKey(k) {
  return String(k).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function normRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[normKey(k)] = v;
  return out;
}

// Uses the export endpoint (no 2,000-row cap) with format_rows=false, so numbers arrive raw
// (12000, not "12,000", "₹12k" or "1.2K") and column keys are the question's column names.
// "min_pq=3&min_orders=" → Metabase parameters for the question's SQL variables (empty values are skipped).
export function parseParams(str) {
  const out = [];
  for (const part of String(str || '').split(/[&,]/)) {
    const [k, ...rest] = part.split('=');
    const v = rest.join('=').trim();
    if (!k || !k.trim() || v === '') continue;
    const n = Number(v);
    out.push({ type: 'category', target: ['variable', ['template-tag', k.trim()]], value: Number.isFinite(n) && v !== '' ? n : v });
  }
  return out;
}

// { parent_sellers: 'a,b,c' } → text variables, passed as is (commas included).
function textParams(obj) {
  return Object.entries(obj || {}).filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => ({ type: 'category', target: ['variable', ['template-tag', k]], value: String(v) }));
}

export async function runCard(cardId, paramStr = '', opts = {}) {
  const base = (process.env.METABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.METABASE_API_KEY;
  if (!base || !key) throw new Error('METABASE_URL and METABASE_API_KEY must be set');
  // Netlify stops a function at 10 s with a bare 504. Give up a little before that so the page gets a clear message
  // and the rest of the sources still load.
  const timeoutMs = Number(opts.timeoutMs || process.env.MB_TIMEOUT_MS || 7500);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${base}/api/card/${encodeURIComponent(cardId)}/query/json`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ format_rows: false, pivot_results: false, parameters: [...parseParams(paramStr), ...textParams(opts.params)] }),
      signal: ctrl.signal
    });
    if (res.ok) {
      const data = await res.json();
      clearTimeout(timer);
      return toRows(cardId, data);
    }
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error(`Metabase Q${cardId} took longer than ${(timeoutMs / 1000).toFixed(1)} s${opts.timeoutMs ? '' : " (Netlify's limit is 10 s)"}`);
    throw e;
  }
  clearTimeout(timer);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Metabase card ${cardId} returned ${res.status}: ${text.slice(0, 200)}`);
  }
}

function toRows(cardId, data) {
  if (!Array.isArray(data)) {
    const hint = data && typeof data === 'object' ? ` (got keys: ${Object.keys(data).slice(0, 8).join(', ')})` : '';
    throw new Error(`Metabase card ${cardId} did not return a row list${hint}`);
  }
  return data.map(normRow);
}
