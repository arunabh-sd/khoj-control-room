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

export async function runCard(cardId) {
  const base = (process.env.METABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.METABASE_API_KEY;
  if (!base || !key) throw new Error('METABASE_URL and METABASE_API_KEY must be set');
  const res = await fetch(`${base}/api/card/${encodeURIComponent(cardId)}/query/json`, {
    method: 'POST',
    headers: { 'x-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({})
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Metabase card ${cardId} returned ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`Metabase card ${cardId} did not return a row list`);
  return data.map(normRow);
}
