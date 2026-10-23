-- Personalisation potential for Khoj visitors (last 14 days of Khoj sessions; signals from the 30 days before each).
-- Windows are kept short and filtered on the raw timestamps so BigQuery only reads ~45 days of event partitions.
-- For each Khoj session: is the visitor a known ShopDeck customer, did they order or browse on ShopDeck seller sites
-- in the 30 days before, and did the product they landed on match that (same product, same seller, same test
-- category)? Then buy-now and order rates by group. One row per group, so the result is small.
--
-- {{khoj_products}}: Metabase variable of type Text, not required. Filled by the dashboard:
--   "khoj_product_id|parent_seller_id|parent_seller_product_id|test_category;..."  (test_category: Saree,
--   Kurti & Suits, Jewellery, Other). Without it, landing products have no seller or category and only
--   "any signal" can be measured.
WITH params AS (
  SELECT CONCAT('' [[, {{khoj_products}}]]) AS kp_text
),
kp AS (
  SELECT SPLIT(x, '|')[SAFE_OFFSET(0)] AS product_id, SPLIT(x, '|')[SAFE_OFFSET(1)] AS parent_seller,
         SPLIT(x, '|')[SAFE_OFFSET(2)] AS parent_product, SPLIT(x, '|')[SAFE_OFFSET(3)] AS cat
  FROM params, UNNEST(SPLIT(kp_text, ';')) AS x
  WHERE x <> ''
),
khoj_ppo AS (
  SELECT session_id, visitor_id, user_id, CAST(product_id AS STRING) AS product_id, created_at
  FROM `events.product_page_opened`
  WHERE seller_id = '6aad1869bcb80ce92eb3389b'
    AND COALESCE(session_id, '') <> '' AND COALESCE(visitor_id, '') <> ''
    AND created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 14 DAY)
),
sess AS (
  SELECT session_id, ANY_VALUE(visitor_id) AS visitor_id, MIN(created_at) AS start_at,
         ARRAY_AGG(product_id ORDER BY created_at LIMIT 1)[OFFSET(0)] AS landing_product
  FROM khoj_ppo
  GROUP BY 1
),
bn AS (
  SELECT DISTINCT session_id FROM `blitzscale-prod-project.events.buy_now_clicked`
  WHERE seller_id = '6aad1869bcb80ce92eb3389b' AND COALESCE(session_id, '') <> ''
    AND created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 14 DAY)
),
ordered AS (
  SELECT DISTINCT session_id FROM `events.order_success_opened`
  WHERE seller_id = '6aad1869bcb80ce92eb3389b' AND COALESCE(session_id, '') <> ''
    AND created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 14 DAY)
),
-- Who is behind each Khoj session, as known WHEN THE SESSION STARTS (that is all a personalised landing could use):
-- a user_id seen with that visitor on Khoj at or before the first page, from product pages or ShopDeck sign-in
-- (an existing ShopDeck login on the device). Checkout and OTP are left out on purpose: they happen while buying,
-- so counting them would make almost every buyer "known" and inflate known visitors' conversion.
khoj_ids AS (
  SELECT visitor_id, user_id, created_at FROM khoj_ppo WHERE COALESCE(user_id, '') <> ''
  UNION ALL
  SELECT visitor_id, user_id, created_at FROM `events.sd_sso_token_exists`
  WHERE seller_id = '6aad1869bcb80ce92eb3389b' AND COALESCE(user_id, '') <> '' AND COALESCE(visitor_id, '') <> ''
    AND created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 45 DAY)
  UNION ALL
  SELECT visitor_id, user_id, created_at FROM `events.sd_sso_user_details_exists`
  WHERE seller_id = '6aad1869bcb80ce92eb3389b' AND COALESCE(user_id, '') <> '' AND COALESCE(visitor_id, '') <> ''
    AND created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 45 DAY)
),
session_user AS (
  SELECT s.session_id, ARRAY_AGG(i.user_id ORDER BY i.created_at DESC LIMIT 1)[OFFSET(0)] AS user_id
  FROM sess s
  JOIN khoj_ids i ON i.visitor_id = s.visitor_id AND i.created_at <= TIMESTAMP_ADD(s.start_at, INTERVAL 2 MINUTE)
  GROUP BY 1
),
-- user_id → ShopDeck customer: the same id, or through an order the user placed.
user_customer AS (
  SELECT e.user_id, ANY_VALUE(oi.customer_id) AS customer_id
  FROM `events.order_success_opened` e
  JOIN `nushop.orderitems` oi ON oi.order_id = e.order_id
  WHERE e.created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 45 DAY)
    AND oi.createdat >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 45 DAY)
    AND e.user_id IN (SELECT user_id FROM session_user)
  GROUP BY 1
),
visitor_customer AS (   -- one row per known user
  SELECT su.user_id, ANY_VALUE(COALESCE(uc.customer_id, su.user_id)) AS customer_id
  FROM (SELECT DISTINCT user_id FROM session_user) su
  LEFT JOIN user_customer uc ON uc.user_id = su.user_id
  GROUP BY 1
),
-- Signals before the session: orders on ShopDeck seller sites, and product pages browsed on them.
sig_orders AS (
  SELECT oi.customer_id, oi.seller_id, oi.customer_product_short_id AS product_id, oi.createdat AS signal_at, oi.product_name AS name, 'order' AS kind
  FROM `nushop.orderitems` oi
  WHERE oi.createdat >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 45 DAY)
    AND oi.seller_id != '6aad1869bcb80ce92eb3389b'
    AND oi.customer_id IN (SELECT customer_id FROM visitor_customer)
    AND COALESCE(oi.seller_last_status, '') NOT IN ('enqueued', 'invalid', 'initiated')
),
-- Browsers on other ShopDeck sites tied to these users through ShopDeck sign-in (small table); product pages
-- carry user_id themselves when signed in. One pass over product pages.
sso_visitors AS (
  SELECT visitor_id, ANY_VALUE(user_id) AS user_id
  FROM `events.sd_sso_token_exists`
  WHERE seller_id != '6aad1869bcb80ce92eb3389b' AND COALESCE(visitor_id, '') <> '' AND COALESCE(user_id, '') <> ''
    AND created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 45 DAY)
    AND user_id IN (SELECT user_id FROM visitor_customer)
  GROUP BY 1
),
browse0 AS (
  SELECT vc.customer_id, p.seller_id, CAST(p.product_id AS STRING) AS product_id, MIN(p.created_at) AS signal_at
  FROM `events.product_page_opened` p
  LEFT JOIN sso_visitors sv ON sv.visitor_id = p.visitor_id
  JOIN (SELECT DISTINCT user_id, customer_id FROM visitor_customer) vc ON vc.user_id = COALESCE(NULLIF(p.user_id, ''), sv.user_id)
  WHERE p.seller_id != '6aad1869bcb80ce92eb3389b'
    AND p.created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 45 DAY)
  GROUP BY 1, 2, 3, TIMESTAMP_TRUNC(p.created_at, DAY, 'Asia/Kolkata')
),
names AS (
  SELECT customer_product_short_id AS product_id, ANY_VALUE(product_name) AS name
  FROM `nushop.orderitems`
  WHERE createdat >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 45 DAY)
    AND customer_product_short_id IN (SELECT product_id FROM browse0)
  GROUP BY 1
),
sigs AS (
  SELECT customer_id, seller_id, product_id, signal_at, kind,
    CASE
      WHEN REGEXP_CONTAINS(LOWER(COALESCE(name, '')), r'\bsar(ee|i)s?\b|saaree') THEN 'Saree'
      WHEN REGEXP_CONTAINS(LOWER(COALESCE(name, '')), r'kurt[aiy]|salwar|anarkali|churidar|dress material|\bsuits?\b|palazzo set|co-?ord') THEN 'Kurti & Suits'
      WHEN REGEXP_CONTAINS(LOWER(COALESCE(name, '')), r'necklace|earring|jhumk|bangle|bracelet|pendant|mangalsutra|jewel|\brings?\b|\bchains?\b|anklet|payal|nose ?pin|maang|\bkada\b|choker|\bhaar\b|kamarband|toe ring') THEN 'Jewellery'
      WHEN name IS NULL THEN NULL
      ELSE 'Other'
    END AS cat
  FROM (
    SELECT customer_id, seller_id, product_id, signal_at, kind, name FROM sig_orders
    UNION ALL
    SELECT b.customer_id, b.seller_id, b.product_id, b.signal_at, 'browse', n.name FROM browse0 b LEFT JOIN names n USING (product_id)
  )
),
scored AS (
  SELECT
    s.session_id,
    COALESCE(kp.cat, 'Unknown') AS landing_cat,
    vc.customer_id IS NOT NULL AS linked,
    LOGICAL_OR(g.signal_at IS NOT NULL) AS has_signal,
    LOGICAL_OR(g.kind = 'order') AS order_signal,
    LOGICAL_OR(g.kind = 'browse') AS browse_signal,
    LOGICAL_OR(g.product_id = kp.parent_product OR g.product_id = s.landing_product) AS m_product,
    LOGICAL_OR(g.seller_id = kp.parent_seller) AS m_seller,
    LOGICAL_OR(g.cat = kp.cat AND kp.cat != 'Other') AS m_cat
  FROM sess s
  LEFT JOIN session_user su ON su.session_id = s.session_id
  LEFT JOIN visitor_customer vc ON vc.user_id = su.user_id
  LEFT JOIN kp ON kp.product_id = s.landing_product
  LEFT JOIN sigs g ON g.customer_id = vc.customer_id
                  AND g.signal_at < s.start_at AND g.signal_at >= TIMESTAMP_SUB(s.start_at, INTERVAL 30 DAY)
  GROUP BY 1, 2, 3
)
SELECT
  landing_cat,
  linked,
  COALESCE(has_signal, FALSE) AS has_signal,
  CASE
    WHEN NOT linked THEN 'not known'
    WHEN COALESCE(m_product, FALSE) THEN 'same product'
    WHEN COALESCE(m_seller, FALSE) THEN 'same seller'
    WHEN COALESCE(m_cat, FALSE) THEN 'same category'
    WHEN COALESCE(has_signal, FALSE) THEN 'no match'
    ELSE 'no signal'
  END AS match_level,
  COALESCE(order_signal, FALSE) AS order_signal,
  COALESCE(browse_signal, FALSE) AS browse_signal,
  COUNT(*) AS sessions,
  COUNTIF(b.session_id IS NOT NULL) AS buy_now_sessions,
  COUNTIF(o.session_id IS NOT NULL) AS order_sessions
FROM scored
LEFT JOIN bn b USING (session_id)
LEFT JOIN ordered o USING (session_id)
GROUP BY 1, 2, 3, 4, 5, 6
