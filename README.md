# Khoj Control Room

The operating dashboard for Khoj product testing. It reads Metabase, applies the testing rules, and tells you what to do: which trials to kill, which winners to graduate, how to move scale budgets, and which products to trial next. You execute the tasks in Ads Manager and tick them off; later the tasks get automated.

**Tabs**

- **Control room**: headline numbers, hero pipeline and Success% (by category and by product source), live trials with the engine's decision and reason, the scale ladder, the catalog signal, the decision log and data-source health.
- **Hero coverage**: uploaded vs live vs hero products per test category, and the relisting backlog.
- **Task log**: New trials to start, Kills, Scales. Tick when done; tasks also close themselves once the data shows the change (ad set paused, budget moved, trial started).
- **Rules**: every threshold the engine uses, editable and saved to Postgres.

## Deploy on Netlify

1. In Netlify: **Add new site → Import an existing project → GitHub →** `arunabh-sd/khoj-control-room`. The settings come from `netlify.toml` (publish `web/`, functions in `netlify/functions/`, no build step).
2. **Site configuration → Environment variables**, add:

| Variable | Value |
|---|---|
| `METABASE_URL` | `https://metabase.kaip.in` |
| `METABASE_API_KEY` | your Metabase API key |
| `MB_Q_PRODUCTS` | `16450` |
| `MB_Q_ADS` | `16659` |
| `MB_Q_ADSET_MAP` | `16676` (ad set → product) |
| `MB_Q_UNIVERSE` | ShopDeck hero universe, when it exists |
| `MB_Q_PRODUCT_SPEND` | `16674` (product-wise spend, all campaigns) |
| `DASHBOARD_PASSWORD` | optional; set it to put the dashboard behind a password |

3. Deploy. Storage is **Netlify Blobs**, which needs no setup: task ticks, the decision log, rule edits and the last Metabase pull live there.

**When Metabase is called:** only when the page opens and when you click "Refresh from Metabase". Each question runs as its own request, with a progress bar per step. Ticking tasks and saving rules reuse the last pull and never query Metabase.

**Limits to know:**
- Netlify functions time out at 10 seconds by default (26 s on paid plans, set per site under Functions). Each Metabase question has to return within that. If Q16450 gets slow, trim its columns or add a filter.
- Netlify's outbound IPs aren't fixed. If Metabase only accepts allowlisted IPs, it will refuse Netlify; open the API to the internet behind the API key, or put a small proxy with a static IP in front.

### Any other Node host (Railway, Render, a VM)

`npm install && npm start`, set the same variables plus `DATABASE_URL` for Postgres (without it, ticks live in memory). `railway.json` is included for Railway.

## Metabase questions

Column names are matched case-insensitively with spaces and punctuation turned into `_`, so `Seller ID` and `seller_id` both work.

### 1. Products (`MB_Q_PRODUCTS`, already exists: Q16450)

One row per Khoj product: `seller_id, khoj_product_id, khoj_product_code, khoj_cust_sku_ids, product_title, current_status, l30d_spend, l30d_orders, l30d_s_gmv, rto_pct_d40_d10, profit_pct_d40_d10, khoj_category_l1, khoj_category_l2, khoj_category_l3, khoj_category_l4`.

### 2. Trial and scale ads (`MB_Q_ADS`: Q16659)

One row **per ad set per day**. Q16659 today has `campaign_id, campaign_name, adset_id, adset_name, date, spend, gmv, speng_gmv`, which is enough for the verdicts. The engine also uses these if you add them:

| Column | Why |
|---|---|
| `sku_id` (or `product_id`) | **Most important.** Links a trial to its Khoj product, which drives hero coverage, Success% by source, and stops the queue suggesting products already tested. Meta's product id = the Khoj SKU id (the values in `khoj_cust_sku_ids` in Q16450). Without it, trials are matched by ad set name only. |
| `adset_status` | Exact live/paused state. Without it, an ad set counts as live if it spent on the latest day with real account spend, or the day before. |
| `daily_budget` | Exact ladder step. Without it, spend is snapped to the nearest ladder step. |
| `impressions`, `link_clicks`, `add_to_cart`, `purchases` | Turns on the CTR and add-to-cart early kill gates and CPP. Without them, only the zero-GMV gate and the Spend/GMV verdicts run. |

How the engine reads it:

- Campaigns containing `testing` are trials; `scale` are scale ad sets.
- One trial = one product: the original ad set and any `– Copy` duplicates (same ad set name) are summed.
- Reported GMV is corrected: actual Spend/GMV = reported × 0.9 (Rules → Data).
- Trials paused before their verdict are closed as "Stopped early" and count as losses in Success%.
- Trailing days with almost no account spend are treated as data lag; ad sets are judged as of the last real day.

### Ad set → product map (`MB_Q_ADSET_MAP`: Q16676)

Top-spend product per ad set from `nushop.fb_true_spend`: `campaign_id, adset_id, product_id, product_spend, adset_spend, share_of_adset`. `product_id` here is the Khoj product id (`khoj_product_id`); SKU ids are accepted too.

A row links an ad set to a product only if that product took **at least 50% of the ad set's spend**, or its title shares at least two distinctive words with the ad set name. Low-share "top products" (around 4–5%) are usually the same few products showing up in every ad set and are ignored. A link on a copy also applies to the original ad set with the same name.

Better: drop the `QUALIFY … = 1` so every product per ad set comes through; the title check can then find the right product even when the top one is noise.

### Product-wise spend, all campaigns (`MB_Q_PRODUCT_SPEND`: Q16674)

Product-wise, day-wise spend and GMV across every campaign, catalog included: `seller_id, product_id, spend_date, product_spend, product_gmv, product_spend_gmv`. `product_id` is the Khoj product id. This Spend/GMV is accurate, so the ×0.9 correction (ads question only) is not applied.

1. **Eligibility:** lifetime spend on the product (every day in the question) of at least ₹1,500.
2. **Performance:** Spend/GMV over the most recent half of that spend (at least ₹1,000), so early days don't decide the read. Lifetime Spend/GMV is shown alongside.

Eligible products with recent Spend/GMV ≤ 30% are directional hits and go to the front of the trial queue. Never counted in Success%.

### ShopDeck universe (`MB_Q_UNIVERSE`)

Feeds "Universe coverage (hero)" and the Hero coverage funnel. Either counts by category (`khoj_category_l2, khoj_category_l3, khoj_category_l4, sd_products, sd_hero_products`) or one row per ShopDeck product with the category columns plus `is_hero` (or `l30d_orders, l30d_spend, profit_pct_d40_d10`, and the hero rule is applied). Until it's connected, the funnel uses products uploaded to Khoj as the universe.

### Meta product breakdown (CSV upload)

Product signal → "Not distributed · Meta" takes a daily CSV from Ads Manager (Breakdown → By dynamic creative element → Product ID, by Day). Columns used: Product ID (= Khoj SKU id), Day, Amount spent, Purchases conversion value. Re-uploading a day replaces it; 120 days are kept. Meta-reported GMV, so the ×0.9 correction applies.

## Rules (defaults)

| Area | Rule |
|---|---|
| Hero | L30D seller orders ≥ 300: all. 30–299: profit % (D40–D10) > 0 and L30D spend > ₹5,000 |
| Test categories | Saree; Kurti & Suits (kurta sets, kurtas, maternity kurtis, salwar suits, dress material); Jewellery (women's) |
| Early kill | At ₹1,500: CTR < 0.8% or zero add-to-carts. Zero orders after 3 × target CPP (target CPP = 30% × product AOV) |
| Verdict at ₹7,000 | Judged on the **better of lifetime and recent Spend/GMV** (recent = last half of spend, at least ₹3,500), so neither a slow start nor a late dip sinks a product. ≤ 30% → graduate; 30–36% → extend (graduates as soon as recent ≤ 30%, verdict by ₹14,000); above 36% → kill. Overall Spend/GMV is shown alongside. |
| Ladder | ₹1,000 → 1,500 → 2,250 → 3,400 → 5,000/day. After 3 days at a step: marginal Spend/GMV < 25% step up; 25–30% hold; > 30% step down (ceiling recorded) |
| Kill review | Each closed trial that didn't graduate: Right if both lifetime and recent were above 36% and it wasn't improving; Recheck if the last half of its spend was within 36% when stopped before ₹7,000; Premature if in the 30–36% band; Wrong if at or under 30%, or it did that well after the stop. |
| Lifecycle | 14 days above 30% Spend/GMV at the floor budget → lifecycle ended |
| New trials | 4 live trials per test category; free slots refilled from live untested hero products: catalog hits first, then 300+ order products, then 30–299; about 15% go to control products |
| Product signal | Products not already in testing. Eligible after ₹1,500 lifetime spend; read on the better of lifetime and recent (last half of spend, min ₹1,000): Spend/GMV ≤ 30% = directional hit (queues the product), otherwise a miss. Never counted in Success%. |

## Local development

```bash
npm install
cp .env.example .env      # fill in, or use DATA_DIR for offline work
node --env-file=.env server/index.js   # or: npx netlify dev
```

Offline: put a Metabase CSV export of Q16450 at `data/products.csv`, run `DATA_DIR=./data npm run fixtures` to generate synthetic `ads.csv` and `catalog.csv`, then `DATA_DIR=./data npm start`. `data/` is git-ignored; never commit real seller data.

Tests: `npm test`.

## Layout

```
server/app.js         API as Request → Response (/api/sources/:name, /api/state, /api/tasks/:id, /api/settings)
server/index.js       local Node server: serves web/ and the API
netlify/functions/    Netlify Function wrapping the same API
server/engine.js      rules engine: hero, trials, ladder, catalog, pipeline, tasks
server/rules.js       default settings and labels
server/metabase.js    Metabase card runner
server/sources.js     loads Metabase questions (or CSVs in DATA_DIR)
server/store.js       Netlify Blobs, Postgres or in-memory store for tasks, decisions, settings, last pull
web/                  front end (no build step)
```
