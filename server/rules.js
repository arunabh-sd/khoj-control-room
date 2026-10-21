// Default rules. Every value can be overridden from the Rules tab (stored in Postgres).

export const DEFAULT_SETTINGS = {
  // Hero rule (seller data, last 30 days)
  heroOrdersAll: 300,           // L30D orders >= this: hero regardless of profit/spend
  heroOrdersMin: 30,            // L30D orders between this and heroOrdersAll: hero only if...
  heroMinProfitPct: 0,          // ...profit % (D40–D10) > this
  heroMinSpend: 5000,           // ...and L30D spend > this

  // Trial protocol
  winBar: 30,                   // Spend/GMV % at or below this = winner
  retestMax: 36,                // Spend/GMV % above winBar and at or below this at the first verdict = extend once
  verdictSpend: 7000,           // first verdict
  extendedVerdictSpend: 14000,  // verdict after one extension
  earlyGateSpend: 1500,         // first kill gate
  minCtr: 0.8,                  // % link CTR at the early gate
  zeroOrderCppMultiple: 3,      // kill if 0 orders after this many × target CPP
  trialDailyBudget: 1000,
  slotsPerCategory: 4,          // live trials to keep running per test category
  controlShare: 15,             // % of new trial slots given to control (non-hero) products

  // Scale ladder
  ladder: [1000, 1500, 2250, 3400, 5000],
  stepDays: 3,                  // minimum days at a step before moving
  stepUpBelow: 25,              // marginal Spend/GMV % below this = step up
  graduateBudget: 1500,         // first scale budget after graduation
  overlapDays: 3,               // days to keep the trial ad set on after graduating
  lifecycleDays: 14,            // days above winBar at the floor budget = lifecycle ended

  // Catalog signal
  catalogMinSpend: 1500,        // minimum spend on a product ID to read it
  catalogWindowDays: 14,

  // Meta reporting correction: actual Spend/GMV = reported × this (Q16659 reads ~10% high)
  metaSgmvFactor: 0.9,

  // Campaign naming
  testingMatch: 'testing',      // campaign name contains this = trial campaign
  scaleMatch: 'scale'           // campaign name contains this = scale campaign
};

export const SETTING_LABELS = {
  heroOrdersAll: ['Hero', 'L30D orders: take all at or above'],
  heroOrdersMin: ['Hero', 'L30D orders: lower tier starts at'],
  heroMinProfitPct: ['Hero', 'Lower tier: profit % (D40–D10) above'],
  heroMinSpend: ['Hero', 'Lower tier: L30D spend above (₹)'],
  winBar: ['Trial', 'Winning bar: Spend/GMV % at or below'],
  retestMax: ['Trial', 'Retest band upper limit: Spend/GMV %'],
  verdictSpend: ['Trial', 'First verdict at spend (₹)'],
  extendedVerdictSpend: ['Trial', 'Verdict after extension (₹)'],
  earlyGateSpend: ['Trial', 'Early kill gate at spend (₹)'],
  minCtr: ['Trial', 'Minimum link CTR % at the early gate'],
  zeroOrderCppMultiple: ['Trial', 'Kill at 0 orders after N × target CPP'],
  trialDailyBudget: ['Trial', 'Trial daily budget (₹)'],
  slotsPerCategory: ['Trial', 'Live trials per test category'],
  controlShare: ['Trial', 'Control group share of new trials (%)'],
  stepDays: ['Ladder', 'Minimum days at a step'],
  stepUpBelow: ['Ladder', 'Step up while marginal Spend/GMV % below'],
  graduateBudget: ['Ladder', 'First scale budget after graduation (₹)'],
  overlapDays: ['Ladder', 'Days to keep the trial on after graduating'],
  lifecycleDays: ['Ladder', 'Lifecycle ends after N days above the bar at the floor'],
  catalogMinSpend: ['Catalog', 'Minimum product spend to read (₹)'],
  catalogWindowDays: ['Catalog', 'Look-back window (days)'],
  metaSgmvFactor: ['Data', 'Meta Spend/GMV correction: actual = reported × this'],
  testingMatch: ['Naming', 'Trial campaigns contain'],
  scaleMatch: ['Naming', 'Scale campaigns contain']
};

export function mergeSettings(overrides) {
  const s = { ...DEFAULT_SETTINGS };
  for (const [k, v] of Object.entries(overrides || {})) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    const def = DEFAULT_SETTINGS[k];
    if (Array.isArray(def)) {
      if (Array.isArray(v) && v.every((x) => Number.isFinite(Number(x)))) s[k] = v.map(Number);
    } else if (typeof def === 'number') {
      const n = Number(v);
      if (Number.isFinite(n)) s[k] = n;
    } else if (typeof v === 'string' && v.trim()) {
      s[k] = v.trim();
    }
  }
  return s;
}
