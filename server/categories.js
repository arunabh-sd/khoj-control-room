// Test categories, mapped from Khoj's L2/L3/L4 taxonomy.
export const TEST_CATEGORIES = ['Saree', 'Kurti & Suits', 'Jewellery'];

const KURTI_L4 = new Set(['kurtas', 'kurta-set', 'kurtas-and-kurtis', 'salwar-suit', 'dress-material']);

export function categoryOf(p) {
  const l2 = p.khoj_category_l2 ?? p.category_l2, l3 = p.khoj_category_l3 ?? p.category_l3, l4 = p.khoj_category_l4 ?? p.category_l4;
  if (l2 === 'womens-clothing' && l4 === 'sarees') return 'Saree';
  if (l2 === 'womens-clothing' && KURTI_L4.has(l4)) return 'Kurti & Suits';
  if (l2 === 'womens-accessories' && l3 === 'jewellery') return 'Jewellery';
  return 'Other';
}
