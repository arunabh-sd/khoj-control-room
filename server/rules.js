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
  verdictWindowShare: 0.5,      // verdicts use the most recent share of spend (early learning drops out)...
  verdictWindowMin: 3500,       // ...covering at least this many rupees
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

  // Product signal (overall product-wise spend, all campaigns incl. catalog)
  catalogMinSpend: 1500,        // eligibility: lifetime spend on the product
  signalWindowShare: 0.5,       // performance: most recent share of that spend...
  signalWindowMin: 1000,        // ...covering at least this many rupees

  // Meta reporting correction for the ads question only: actual Spend/GMV = reported × this (Q16659 reads ~10% high).
  // Not applied to the product-wise spend question, whose Spend/GMV is accurate.
  metaSgmvFactor: 0.9,

  // Campaign naming
  khojBaseUrl: 'https://khoj.shopdeck.com',
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
  verdictWindowShare: ['Trial', 'Verdict window: most recent share of spend (0.5 = last half)'],
  verdictWindowMin: ['Trial', 'Verdict window: at least this much recent spend (₹)'],
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
  catalogMinSpend: ['Product signal', 'Eligible after lifetime spend of (₹)'],
  signalWindowShare: ['Product signal', 'Performance window: most recent share of spend (0.5 = last half)'],
  signalWindowMin: ['Product signal', 'Performance window: at least this much recent spend (₹)'],
  metaSgmvFactor: ['Data', 'Ads question Spend/GMV correction: actual = reported × this'],
  khojBaseUrl: ['Naming', 'Khoj site for product links'],
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
