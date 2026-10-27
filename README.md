# Khoj Control Room

The operating dashboard for Khoj product testing. It reads Metabase, applies the testing rules, and tells you what to do: which trials to kill, which winners to graduate, how to move scale budgets, and which products to trial next. You execute the tasks in Ads Manager and tick them off; later the tasks get automated.

**Tabs**

- **Overall Status**: executive summary for founders. Last 7 days vs the 7 before (orders, GMV, spend, Spend/GMV, AOV, online %, cancellations, RTO, profit), flags, daily trends, week-by-week table, unit economics per shipped order with the breakeven Spend/GMV, why Spend/GMV moved (CPM, CTR, click→order, AOV), a PMF snapshot and operations. From the day-wise question (Q16083) and the P&L question (Q16167, pulled per date window).
- **Scaling Plan & Status**: a week-wise plan (daily spend by bucket: Meta catalog, Meta winners, product testing, other Meta, Google; Spend/GMV per bucket and overall; GMV, AOV, orders; trials tested, in testing, winners, killed, success %) against actuals, which assumptions are holding, and the risks to the plan. The plan is edited on the page and saved.
- **PMF View**, with sub-tabs: Overall summary · Hit % & Scalability (product testing, hero coverage at the bottom) · Customer Quality · Early signs on repeats & likability (to come) · Actual Repeats · Cross Selling · Using ShopDeck's data advantage (personalisation potential for buyers and visitors).
- **Rules** and **Task log**.

## Deploy on Netlify

1. In Netlify: **Add new site → Import an existing project → GitHub →** `arunabh-sd/khoj-control-room`. The settings come from `netlify.toml` (publish `web/`, functions in `netlify/functions/`, no build step).
2. **Site configuration → Environment variables**, add:

| Variable | Value |
|---|---|
| `METABASE_URL` | `https://metabase.kaip.in` |
| `METABASE_API_KEY` | your Metabase API key |
| `MB_Q_DAYWISE` | `16083` (Khoj day-wise: orders, GMV, spend, ad funnel) |
| `MB_Q_PNL` | `16167` (Khoj P&L; the dashboard passes `start_date`, `end_date`, `rto_pct` per window) |
| `MB_Q_PRODUCTS` | `16450` |
| `MB_Q_ADS` | `16659` |
| `MB_Q_ADSET_MAP` | `16676` (ad set → product) |
| `MB_Q_UNIVERSE` | `16457` (all ShopDeck products, PQ ≥ 3) |
| `MB_Q_UNIVERSE_PARAMS` | `min_pq=3` (passed to the question's filters) |
| `MB_Q_PRODUCT_SPEND` | `16674` (product-wise spend, all campaigns) |
| `MB_Q_OVERLAP` | `16494` (Khoj × parent seller buyer overlap) |
| `MB_Q_CUSTOMER_HISTORY` | `16717` (Khoj buyers' ShopDeck order history, 12 months) |
| `MB_Q_EVENTS` | `16724` (site sessions, `sql/site_sessions.sql`) |
| `MB_Q_BENCHMARK` | `16725` (repeat benchmark, `sql/repeat_benchmark.sql`) |
| `MB_Q_KHOJ_ORDERS` | default 17017: Khoj orders since launch, for new vs repeat orders (`sql/khoj_orders.sql`), pulled hourly; until set, the daily order history is used |
| `MB_Q_REVISIT` | visits after delivery, Khoj vs parent sellers (`sql/revisit_after_delivery.sql`, variable `parent_sellers`, Text) |
| `MB_Q_RATING` / `MB_Q_RETURNS` / `MB_Q_BUMPER` | default to 16826 / 16859 / 16830 (rating, return requests, bumper coupon: Khoj vs parent) |
| `MB_Q_PRODUCT_QUALITY` | default 17003: order quality, Khoj vs the same products on their seller sites (`sql/product_quality.sql`, variable `khoj_products`, Text) |
| `MB_Q_BROWSING` | Khoj buyers' browsing on ShopDeck sites (`sql/khoj_buyer_browsing.sql`) |
| `MB_Q_PERSONALISE` | Khoj visitors' personalisation potential (`sql/visitor_personalisation.sql`) |
| `DASHBOARD_PASSWORD` | optional; set it to put the dashboard behind a password |

3. Deploy. Storage is **Netlify Blobs**, which needs no setup: task ticks, the decision log, rule edits and the last Metabase pull live there.

**When Metabase is called:**
- Ads, ad set map and product-wise spend: when you click "Refresh from Metabase", and when the page opens if the last pull is over 30 minutes old (`PAGE_PULL_MINUTES`).
- Products (Q16450): **every 6 hours** (its seller L30D numbers take Metabase more than the page's 10 seconds).
- Universe (Q16457), order history (Q16717) and buyer overlap (Q16494): **once a day**, by the scheduled function `netlify/functions/daily.mjs`. It checks every 5 minutes but only calls Metabase for a question not yet pulled in its window (IST), with a 25-second limit (`MB_DAILY_TIMEOUT_MS`) and at most 3 tries a day. Page loads use the last daily pull. The first check after a deploy pulls every scheduled question once. Scheduled functions run on the published production deploy only. The scheduled functions don't query Metabase themselves: they hand each due question to the background function `netlify/functions/pull-background.mjs` (up to 15 minutes, `MB_BG_TIMEOUT_MS`, default 13 min), authorised with a token derived from `METABASE_API_KEY`. If Netlify won't start a background function, the scheduled function falls back to pulling inline with the 25-second limit. Set `KHOJ_NO_BACKGROUND=1` to force the inline path. Each question runs as its own request, with a progress bar per step. Ticking tasks and saving rules reuse the last pull and never query Metabase.

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

1. **Eligibility:** lifetime spend on the product (every day in the question) of at least ₹1,000.
2. **Performance:** Spend/GMV over the most recent half of that spend (at least ₹1,000), so early days don't decide the read. Lifetime Spend/GMV is shown alongside.

Eligible products with recent Spend/GMV ≤ 30% are directional hits and go to the front of the trial queue. Never counted in Success%.

### ShopDeck universe (`MB_Q_UNIVERSE`: Q16457)

All ShopDeck products with PQ ≥ 3: `seller_id, seller_product_id, product_title, khoj_product_id, current_status, seller_product_pq, l30d_spend, l30d_orders, l30d_s_gmv, profit_pct_d40_d10, category_l1..l4`. The TOTAL row is skipped and rows under PQ 3 are dropped. The same hero rule applies, and it is also where Khoj products get their PQ for the hero PQ bar. Feeds "Universe coverage (hero)" and the Hero coverage funnel: Universe → Live on Khoj → Hero universe → Hero live on Khoj, plus the two backlogs (hero not uploaded, hero uploaded but not live).

**Use the lighter version on Netlify.** The full question is ~240k rows (~47 MB) and can't come back inside a 10-second function. Wrap the current SQL so products that matter come back one per row and the rest come back as counts (`n`) per category; the funnel numbers come out the same:

```sql
WITH u AS (
  -- Q16457's current SQL, unchanged (keep {{min_pq}})
)
SELECT seller_id, seller_product_id, product_title, khoj_product_id, current_status, seller_product_pq,
       l30d_spend, l30d_orders, profit_pct_d40_d10, category_l1, category_l2, category_l3, category_l4, 1 AS n
FROM u
WHERE COALESCE(CAST(seller_id AS STRING), '') != 'TOTAL'
  AND (khoj_product_id IS NOT NULL OR COALESCE(l30d_orders, 0) >= 10)
UNION ALL
SELECT NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, category_l1, category_l2, category_l3, category_l4, COUNT(*)
FROM u
WHERE COALESCE(CAST(seller_id AS STRING), '') != 'TOTAL'
  AND khoj_product_id IS NULL AND COALESCE(l30d_orders, 0) < 10
GROUP BY category_l1, category_l2, category_l3, category_l4
```

Each Metabase call gives up after 7.5 s (`MB_TIMEOUT_MS`) so the page still loads; a question that fails keeps its last good pull and the page says which one failed.

Without the lighter version, it's ~240k rows, so it's shrunk on load (products with 10+ orders keep their numbers; the rest become counts). For speed, a question that returns counts by category is better, and the dashboard reads it as is: `category_l2, category_l3, category_l4, sd_products, uploaded, live, sd_hero_products, hero_uploaded, hero_live`. With that version the hero rule lives in the SQL, so Rules edits don't change the universe, and Khoj products get no PQ (the PQ bar is then skipped, with a note). Hero expression for that SQL:

```sql
seller_product_pq >= 3 AND (l30d_orders >= 300 OR (l30d_orders >= 30 AND l30d_spend > 3000 AND profit_pct_d40_d10 > -10))
```

### Buyer overlap (`MB_Q_OVERLAP`: Q16494)

Khoj buyers who also bought from the product's parent seller: `seller_id, product_id, khoj_buyers, overlapping_buyers` (`product_id` = seller product id, mapped to Khoj through the universe question). Feeds Audience intelligence → Cannibalisation and the overlap tag on live trials.

### Khoj buyers' order history (`MB_Q_CUSTOMER_HISTORY`: Q16717)

Every ShopDeck order in the last 12 months by anyone who has ordered on Khoj, Khoj's own orders included (Khoj's seller id is under Rules → Customers). Feeds Audience intelligence, Repeat behaviour and Cross-selling.

Columns used: `order_id, customer_id, seller_id, customer_product_short_id, createdat, delivery_time, selling_price, quantity, payment_mode, in_house_status, seller_last_status, pincode, meta, product_name, seller_name` (`first_order` in `meta` = the customer's first ever ShopDeck order). Add `category_l2, category_l3, category_l4` to cover every history line's category (otherwise the universe question supplies it where it can). On load the rows are cut to these columns; names, addresses, coordinates, AWBs and labels are dropped and never cached.

**Trim the question to these columns.** The first version returned ~90 columns (12 MB for 10k rows), too slow for a 10-second Netlify function. Trimmed version (rolling 12 months, times in IST):

```sql
WITH target_customers AS (
  SELECT DISTINCT customer_id
  FROM `nushop.orderitems`
  WHERE createdat >= TIMESTAMP "2020-01-01 00:00:00Z"
    AND seller_id = '6aad1869bcb80ce92eb3389b'            -- Khoj by ShopDeck
    AND customer_id IS NOT NULL
    AND COALESCE(seller_last_status, '') NOT IN ('enqueued', 'invalid', 'initiated')
)
SELECT
  o.order_id, o.customer_id, o.seller_id, o.customer_product_short_id,
  FORMAT_TIMESTAMP('%Y-%m-%d %H:%M', o.createdat, 'Asia/Kolkata')     AS createdat,
  FORMAT_TIMESTAMP('%Y-%m-%d %H:%M', o.delivery_time, 'Asia/Kolkata') AS delivery_time,
  o.selling_price, o.quantity, o.payment_mode, o.in_house_status, o.seller_last_status, o.pincode, o.meta,
  o.product_name, o.seller_name
  -- , c.category_l2, c.category_l3, c.category_l4
FROM `nushop.orderitems` o
JOIN target_customers t ON o.customer_id = t.customer_id
-- LEFT JOIN <product catalogue table used by Q16457> c ON c.<seller product id> = o.customer_product_short_id
WHERE o.createdat >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 365 DAY)
  AND COALESCE(o.seller_last_status, '') NOT IN ('enqueued', 'invalid', 'initiated')
```

- A Khoj order = an order on Khoj's seller id; cancelled orders are left out; RTO is of delivered + returned.
- A visit = a buyer's orders within 30 minutes (buy-now places one order per item); a repeat is a Khoj order after that.
- Repeat windows count only buyers whose first Khoj order is at least that old.
- Seller-site benchmark: the same customers from their first seller order in the 12 months, back to the same seller (Khoj excluded).
- Khoj vs site price: Khoj unit price ÷ the median unit price these customers paid for the same product on the parent seller's site (product mapped through the universe question).
- State comes from the pincode's first three digits.


### Khoj vs the parent sellers' own sites (`MB_Q_EVENTS`, `MB_Q_BENCHMARK`)

`sql/site_sessions.sql` (last 28 days of product page opens, buy-now clicks, checkouts and orders) and `sql/repeat_benchmark.sql` (each seller site's own 7/14/28-day repeat) are asked about Khoj plus the **parent sellers** of the products Khoj has sold. Both need a Metabase variable `parent_sellers` of type Text, not required. The dashboard fills it from the order history and products questions, so these two run from `netlify/functions/daily-sellers.mjs` (checked every 5 minutes, 2 minutes after the others), once a day.

Each parent seller counts in the comparison in proportion to the Khoj orders of its products, so the benchmark is "what these products' own storefronts do". Sellers with under 100 sessions (events) or 20 customers in a window (repeat) are left out; the page shows how much of Khoj's orders the benchmark covers.

The order history question is `sql/customer_history_q16717.sql`.

### Khoj buyers' browsing (`MB_Q_BROWSING`)

`sql/khoj_buyer_browsing.sql`: product pages Khoj buyers opened on ShopDeck seller sites (Khoj left out), from 30 days before their first Khoj order, one row per customer × seller × product × day. A browser is tied to a customer through `user_id` on product page, checkout, OTP and ShopDeck sign-in events. Feeds the browsing rows of "Could we have predicted the order?" and the customer timelines. Scheduled once a day.

### Visitor personalisation (`MB_Q_PERSONALISE`)

`sql/visitor_personalisation.sql`: every Khoj session in the last 14 days, grouped by whether the visitor was identifiable when the session started (user_id on Khoj product pages or ShopDeck sign-in at or before the first page; checkout and OTP left out so buyers are not counted as known after the fact), whether they ordered or browsed on ShopDeck seller sites in the 30 days before, and whether the first product matched (same product, seller or test category). Needs a Metabase Text variable `khoj_products` (not required), filled by the dashboard with each Khoj product's parent seller, parent seller product and test category. The estimate gives "signal but unrelated landing" sessions the conversion of matched sessions; it is an upper bound until an A/B test.

### Fallback copy of the universe

`server/fallback/universe.json.gz` is a compacted copy of a Q16457 export (Oct 22). Whenever Metabase hasn't delivered Q16457, the dashboard uses it and says how old it is; a fresh pull replaces it automatically. To refresh the copy, regenerate it from a new CSV export (see the commit that added it).

## Rules (defaults)

| Area | Rule |
|---|---|
| Hero | Type 1: L30D seller orders ≥ 300. Type 2: 30–299 orders with profit % (D40–D10) > −10% and L30D spend > ₹3,000. Both need product PQ ≥ 3 (read from the universe question: a Khoj product missing from it is under PQ 3) |
| Test categories | Saree; Kurti & Suits (kurta sets, kurtas, maternity kurtis, salwar suits, dress material); Jewellery (women's) |
| Early kill | At ₹1,500: CTR < 0.8% or zero add-to-carts. Zero orders after 3 × target CPP (target CPP = 30% × product AOV) |
| Verdict at ₹7,000 | Judged on the **better of lifetime and recent Spend/GMV** (recent = last half of spend, at least ₹3,500), so neither a slow start nor a late dip sinks a product. ≤ 30% → graduate; 30–36% → extend (graduates as soon as recent ≤ 30%, verdict by ₹14,000); above 36% → kill. Overall Spend/GMV is shown alongside. |
| Ladder | ₹1,000 → 1,500 → 2,250 → 3,400 → 5,000/day. After 3 days at a step: marginal Spend/GMV < 25% step up; 25–30% hold; > 30% step down (ceiling recorded) |
| Kill review | Each closed trial that didn't graduate: Right if both lifetime and recent were above 36% and it wasn't improving; Recheck if the last half of its spend was within 36% when stopped before ₹7,000; Premature if in the 30–36% band; Wrong if at or under 30%, or it did that well after the stop. |
| Lifecycle | 14 days above 30% Spend/GMV at the floor budget → lifecycle ended |
| New trials | 4 live trials per test category; free slots refilled from live untested hero products: catalog hits first, then 300+ order products, then 30–299; about 15% go to control products |
| Product signal | Products not already in testing. Eligible after ₹1,000 lifetime spend; read on the better of lifetime and recent (last half of spend, min ₹1,000): Spend/GMV ≤ 30% = directional hit (queues the product), otherwise a miss. Never counted in Success%. |

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
