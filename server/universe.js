// The ShopDeck universe (Q16457, all products with PQ ≥ 3) is ~240k rows. It is shrunk as soon as it loads so the cache
// stays small: products with at least DETAIL_MIN_ORDERS seller orders in 30 days keep their numbers (only they can be hero),
// everything else becomes counts per category and Khoj status.
import { num } from './engine.js';

export const DETAIL_MIN_ORDERS = 10;

export function compactUniverse(rows, { minPq = 3 } = {}) {
  // Already aggregated by the question (has count columns): keep as is.
  if (rows.length && ('sd_products' in rows[0] || 'sd_hero_products' in rows[0])) return rows;
  const out = [];
  const agg = new Map();
  for (const r of rows) {
    if (String(r.seller_id || '').toUpperCase() === 'TOTAL') continue;
    const pq = num(r.seller_product_pq);
    if (pq !== null && pq < minPq) continue;
    const l2 = r.category_l2 ?? r.khoj_category_l2 ?? '', l3 = r.category_l3 ?? r.khoj_category_l3 ?? '', l4 = r.category_l4 ?? r.khoj_category_l4 ?? '';
    const uploaded = r.khoj_product_id ? 1 : 0;
    const live = String(r.current_status || '').toLowerCase() === 'live' ? 1 : 0;
    const orders = num(r.l30d_orders) || 0;
    // Detail kept for products that could be hero and for every product on Khoj (its seller product id maps other
    // questions, like the buyer overlap one, to Khoj products).
    if (orders >= DETAIL_MIN_ORDERS || uploaded || r.is_hero !== undefined) {
      out.push({ category_l2: l2, category_l3: l3, category_l4: l4, n: 1, uploaded, live,
        l30d_orders: orders, l30d_spend: num(r.l30d_spend) || 0, profit_pct_d40_d10: num(r.profit_pct_d40_d10), is_hero: r.is_hero, pq: pq ?? undefined,
        seller_product_id: r.seller_product_id || undefined, khoj_product_id: r.khoj_product_id || undefined,
        product_title: uploaded ? undefined : r.product_title });
      continue;
    }
    // A row can already be a count (the lighter question returns small products grouped, with n = how many).
    const w = num(r.n) || 1;
    const key = [l2, l3, l4, uploaded, live].join('|');
    const a = agg.get(key) || { category_l2: l2, category_l3: l3, category_l4: l4, n: 0, uploaded: 0, live: 0 };
    a.n += w; a.uploaded += uploaded * w; a.live += live * w;
    agg.set(key, a);
  }
  return out.concat([...agg.values()]);
}
