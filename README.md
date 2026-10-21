# Khoj Control Room

The operating dashboard for Khoj product testing. It reads Metabase, applies the testing rules, and tells you what to do: which trials to kill, which winners to graduate, how to move scale budgets, and which products to trial next. You execute the tasks in Ads Manager and tick them off; later the tasks get automated.

**Tabs**

- **Control room**: headline numbers, hero pipeline and Success% (by category and by product source), live trials with the engine's decision and reason, the scale ladder, the catalog signal, the decision log and data-source health.
- **Hero coverage**: uploaded vs live vs hero products per test category, and the relisting backlog.
- **Task log**: New trials to start, Kills, Scales. Tick when done; tasks also close themselves once the data shows the change (ad set paused, budget moved, trial started).
- **Rules**: every threshold the engine uses, editable and saved to Postgres.

## Deploy on Railway

1. Push this repo to GitHub and create a Railway project from it.
2. Add the **PostgreSQL** plugin to the project. Railway sets `DATABASE_URL` for you.
3. Set variables on the service:

| Variable | Value |
|---|---|
| `METABASE_URL` | `https://metabase.kaip.in` |
| `METABASE_API_KEY` | your Metabase API key |
| `MB_Q_PRODUCTS` | `16450` |
| `MB_Q_ADS` | `16659` |
| `MB_Q_CATALOG` | ID of the catalog product-spend question (below) |
| `CACHE_TTL_MIN` | optional, default `30` |
| `DASHBOARD_PASSWORD` | optional; set it to put the dashboard behind a password |

4. Deploy. Railway runs `npm install` and `npm start`; the health check is `/healthz`.

Railway's outbound IPs must be able to reach your Metabase. If Metabase is behind an IP allowlist, add Railway's egress IPs (or use a Railway static outbound IP).

The API key never reaches the browser: only the server calls Metabase.

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

### 3. Catalog product spend (`MB_Q_CATALOG`, to build)

One row **per product ID per day** from catalog campaigns (Ads Manager breakdown: Dynamic creative element → Product ID; or the Marketing API insights `product_id` breakdown), last 14+ days.

`date, campaign_name, product_id, spend, impressions, link_clicks, purchases, gmv` (`product_id` = Meta's product id, i.e. the Khoj SKU id). The same ×0.9 GMV correction applies.

## Rules (defaults)

| Area | Rule |
|---|---|
| Hero | L30D seller orders ≥ 300: all. 30–299: profit % (D40–D10) > 0 and L30D spend > ₹5,000 |
| Test categories | Saree; Kurti & Suits (kurta sets, kurtas, maternity kurtis, salwar suits, dress material); Jewellery (women's) |
| Early kill | At ₹1,500: CTR < 0.8% or zero add-to-carts. Zero orders after 3 × target CPP (target CPP = 30% × product AOV) |
| Verdict at ₹7,000 | Spend/GMV ≤ 30% → graduate; 30–36% → extend once to ₹14,000; above 36% → kill |
| Ladder | ₹1,000 → 1,500 → 2,250 → 3,400 → 5,000/day. After 3 days at a step: marginal Spend/GMV < 25% step up; 25–30% hold; > 30% step down (ceiling recorded) |
| Lifecycle | 14 days above 30% Spend/GMV at the floor budget → lifecycle ended |
| New trials | 4 live trials per test category; free slots refilled from live untested hero products: catalog hits first, then 300+ order products, then 30–299; about 15% go to control products |
| Catalog signal | Product IDs with ≥ ₹1,500 catalog spend in 14 days: Spend/GMV ≤ 30% = directional hit (queues the product), otherwise a miss. Never counted in Success%. |

## Local development

```bash
npm install
cp .env.example .env      # fill in, or use DATA_DIR for offline work
node --env-file=.env server/index.js
```

Offline: put a Metabase CSV export of Q16450 at `data/products.csv`, run `DATA_DIR=./data npm run fixtures` to generate synthetic `ads.csv` and `catalog.csv`, then `DATA_DIR=./data npm start`. `data/` is git-ignored; never commit real seller data.

Tests: `npm test`.

## Layout

```
server/index.js       HTTP server and API (/api/state, /api/tasks/:id, /api/settings)
server/engine.js      rules engine: hero, trials, ladder, catalog, pipeline, tasks
server/rules.js       default settings and labels
server/metabase.js    Metabase card runner
server/sources.js     loads Metabase questions (or CSVs in DATA_DIR)
server/store.js       Postgres (or in-memory) store for tasks, decisions, settings
web/                  front end (no build step)
```
