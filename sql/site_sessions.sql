-- Site sessions · Khoj vs the parent sellers' own sites, last 28 days (Q16724)
-- {{parent_sellers}}: Metabase variable of type Text, not required. The dashboard fills it with the parent sellers
-- of what Khoj has sold (comma-separated seller ids). Run by hand without it, only Khoj comes back.
--
-- kind = 'seller'     : one row per seller, the session funnel (all visitors, and new visitors only)
-- kind = 'landing'    : per seller × landing product (first product page opened) × new/returning visitor
-- kind = 'depth'      : per seller × products viewed in the session (1, 2, 3-5, 6+)
-- kind = 'khoj_next'  : Khoj only, landing product → second product viewed
-- kind = 'khoj_click' : Khoj only, landing product → product that got the buy-now click
-- A visitor is "returning" if they opened a product page on the same site in the 90 days before the session.
WITH sellers AS (
  SELECT '6aad1869bcb80ce92eb3389b' AS seller_id
  [[UNION DISTINCT SELECT TRIM(x) FROM UNNEST(SPLIT({{parent_sellers}}, ',')) AS x WHERE TRIM(x) <> '']]
),
ppo AS (
  SELECT p.seller_id, p.session_id, p.visitor_id, CAST(p.product_id AS STRING) AS product_id, p.created_at
  FROM `events.product_page_opened` p
  JOIN sellers s ON p.seller_id = s.seller_id
  WHERE COALESCE(p.session_id, '') <> '' AND COALESCE(p.visitor_id, '') <> ''
    AND DATE(p.created_at, 'Asia/Kolkata') >= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 118 DAY)
),
seen AS (
  SELECT seller_id, visitor_id, ARRAY_AGG(created_at ORDER BY created_at) AS opens_at
  FROM (SELECT seller_id, visitor_id, TIMESTAMP_TRUNC(created_at, HOUR) AS created_at FROM ppo GROUP BY 1, 2, 3)
  GROUP BY 1, 2
),
views AS (
  SELECT seller_id, session_id, ANY_VALUE(visitor_id) AS visitor_id, product_id,
         MIN(created_at) AS first_at, MAX(created_at) AS last_at, COUNT(*) AS opens
  FROM ppo
  WHERE DATE(created_at, 'Asia/Kolkata') >= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 28 DAY)
  GROUP BY seller_id, session_id, product_id
),
sessions0 AS (
  SELECT seller_id, session_id, ANY_VALUE(visitor_id) AS visitor_id,
         SUM(opens) AS ppo, COUNT(*) AS products, MIN(first_at) AS start_at,
         TIMESTAMP_DIFF(MAX(last_at), MIN(first_at), SECOND) AS secs,
         ARRAY_AGG(product_id ORDER BY first_at LIMIT 2) AS first_two
  FROM views
  GROUP BY seller_id, session_id
),
sessions AS (
  SELECT se.seller_id, se.session_id, se.ppo, se.products, se.secs,
         se.first_two[OFFSET(0)] AS landing_product,
         IF(ARRAY_LENGTH(se.first_two) > 1, se.first_two[OFFSET(1)], NULL) AS second_product,
         IF(EXISTS (SELECT 1 FROM UNNEST(sn.opens_at) t
                    WHERE t < TIMESTAMP_SUB(se.start_at, INTERVAL 1 HOUR)
                      AND t >= TIMESTAMP_SUB(se.start_at, INTERVAL 90 DAY)), 'returning', 'new') AS visitor_type
  FROM sessions0 se
  LEFT JOIN seen sn ON sn.seller_id = se.seller_id AND sn.visitor_id = se.visitor_id
),
buy_now AS (
  SELECT b.seller_id, b.session_id, CAST(b.product_id AS STRING) AS product_id
  FROM `blitzscale-prod-project.events.buy_now_clicked` b
  JOIN sellers s ON b.seller_id = s.seller_id
  WHERE COALESCE(b.session_id, '') <> '' AND COALESCE(b.visitor_id, '') <> ''
    AND DATE(b.created_at, 'Asia/Kolkata') >= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 28 DAY)
  GROUP BY 1, 2, 3
),
buy_now_sessions AS (
  SELECT seller_id, session_id, COUNT(DISTINCT product_id) AS products FROM buy_now GROUP BY 1, 2
),
checkouts AS (
  SELECT DISTINCT c.seller_id, c.session_id
  FROM `events.checkout_initiated` c
  JOIN sellers s ON c.seller_id = s.seller_id
  WHERE COALESCE(c.session_id, '') <> '' AND COALESCE(c.visitor_id, '') <> ''
    AND DATE(c.created_at, 'Asia/Kolkata') >= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 28 DAY)
),
orders AS (
  SELECT oi.seller_id, COUNT(DISTINCT oi.seller_group_id) AS orders
  FROM `nushop.orderitems` oi
  JOIN sellers s ON oi.seller_id = s.seller_id
  WHERE DATE(oi.createdat, 'Asia/Kolkata') >= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 28 DAY)
    AND oi.seller_last_status NOT IN ('invalid', 'initiated', 'enqueued')
    AND oi.awb_no != 'None' AND oi.in_house_status != 'awb_expired'
    AND oi.reseller_id IS NULL
  GROUP BY 1
),
s AS (
  SELECT se.*, b.session_id IS NOT NULL AS bn, COALESCE(b.products, 0) AS bn_products, c.session_id IS NOT NULL AS co
  FROM sessions se
  LEFT JOIN buy_now_sessions b ON b.seller_id = se.seller_id AND b.session_id = se.session_id
  LEFT JOIN checkouts c ON c.seller_id = se.seller_id AND c.session_id = se.session_id
)

SELECT 'seller' AS kind, s.seller_id,
  CAST(NULL AS STRING) AS landing_product, CAST(NULL AS STRING) AS other_product, CAST(NULL AS STRING) AS bucket, CAST(NULL AS STRING) AS visitor_type,
  COUNT(*) AS sessions, SUM(ppo) AS ppo, SUM(products) AS products_viewed, COUNTIF(products >= 2) AS multi_product_sessions, SUM(secs) AS secs,
  COUNTIF(bn) AS buy_now_sessions, COUNTIF(bn_products >= 2) AS multi_buy_now_sessions, COUNTIF(co) AS checkout_sessions, ANY_VALUE(o.orders) AS orders,
  COUNTIF(visitor_type = 'new') AS new_sessions,
  SUM(IF(visitor_type = 'new', products, 0)) AS new_products_viewed,
  COUNTIF(visitor_type = 'new' AND products >= 2) AS new_multi_product_sessions,
  COUNTIF(visitor_type = 'new' AND bn) AS new_buy_now_sessions,
  SUM(IF(visitor_type = 'new', secs, 0)) AS new_secs
FROM s LEFT JOIN orders o ON o.seller_id = s.seller_id
GROUP BY s.seller_id

UNION ALL
SELECT 'landing', seller_id, landing_product, NULL, NULL, visitor_type,
  COUNT(*), SUM(ppo), SUM(products), COUNTIF(products >= 2), SUM(secs),
  COUNTIF(bn), COUNTIF(bn_products >= 2), COUNTIF(co), NULL, NULL, NULL, NULL, NULL, NULL
FROM s
GROUP BY seller_id, landing_product, visitor_type
HAVING COUNT(*) >= 3 OR seller_id = '6aad1869bcb80ce92eb3389b'

UNION ALL
SELECT 'depth', seller_id, NULL, NULL,
  CASE WHEN products = 1 THEN '1' WHEN products = 2 THEN '2' WHEN products <= 5 THEN '3-5' ELSE '6+' END, visitor_type,
  COUNT(*), NULL, NULL, NULL, NULL, COUNTIF(bn), NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
FROM s
GROUP BY 2, 5, 6

UNION ALL
SELECT 'khoj_next', seller_id, landing_product, second_product, NULL, NULL,
  COUNT(*), NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
FROM s
WHERE seller_id = '6aad1869bcb80ce92eb3389b' AND second_product IS NOT NULL
GROUP BY 2, 3, 4

UNION ALL
SELECT 'khoj_click', se.seller_id, se.landing_product, b.product_id, NULL, NULL,
  COUNT(DISTINCT se.session_id), NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
FROM sessions se
JOIN buy_now b ON b.seller_id = se.seller_id AND b.session_id = se.session_id
WHERE se.seller_id = '6aad1869bcb80ce92eb3389b'
GROUP BY 2, 3, 4
