-- Site sessions · Khoj vs the parent sellers' own sites, last 28 days
-- {{parent_sellers}}: add as a Metabase variable of type Text, not required. The dashboard fills it with the
-- parent sellers of what Khoj has sold (comma-separated seller ids). Run by hand without it, only Khoj comes back.
-- kind = 'seller'     : one row per seller, the session funnel
-- kind = 'khoj_click' : Khoj buy-now clicks by the session's landing product (first product page opened)
WITH sellers AS (
  SELECT '6aad1869bcb80ce92eb3389b' AS seller_id
  [[UNION DISTINCT SELECT TRIM(x) FROM UNNEST(SPLIT({{parent_sellers}}, ',')) AS x WHERE TRIM(x) <> '']]
),
views AS (
  SELECT p.seller_id, p.session_id, CAST(p.product_id AS STRING) AS product_id,
         MIN(p.created_at) AS first_at, MAX(p.created_at) AS last_at, COUNT(*) AS opens
  FROM `events.product_page_opened` p
  JOIN sellers s ON p.seller_id = s.seller_id
  WHERE COALESCE(p.session_id, '') <> '' AND COALESCE(p.visitor_id, '') <> ''
    AND DATE(p.created_at, 'Asia/Kolkata') >= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 28 DAY)
  GROUP BY 1, 2, 3
),
sessions AS (
  SELECT seller_id, session_id,
         SUM(opens) AS ppo,
         COUNT(DISTINCT product_id) AS products,
         TIMESTAMP_DIFF(MAX(last_at), MIN(first_at), SECOND) AS secs,
         ARRAY_AGG(product_id ORDER BY first_at LIMIT 1)[OFFSET(0)] AS landing_product
  FROM views
  GROUP BY 1, 2
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
)
SELECT
  'seller' AS kind, se.seller_id,
  COUNT(*) AS sessions,
  SUM(se.ppo) AS ppo,
  SUM(se.products) AS products_viewed,
  COUNTIF(se.products >= 2) AS multi_product_sessions,
  SUM(se.secs) AS secs,
  COUNTIF(b.session_id IS NOT NULL) AS buy_now_sessions,
  COUNTIF(b.products >= 2) AS multi_buy_now_sessions,
  COUNTIF(c.session_id IS NOT NULL) AS checkout_sessions,
  ANY_VALUE(o.orders) AS orders,
  CAST(NULL AS STRING) AS landing_product,
  CAST(NULL AS STRING) AS clicked_product
FROM sessions se
LEFT JOIN buy_now_sessions b ON b.seller_id = se.seller_id AND b.session_id = se.session_id
LEFT JOIN checkouts c ON c.seller_id = se.seller_id AND c.session_id = se.session_id
LEFT JOIN orders o ON o.seller_id = se.seller_id
GROUP BY se.seller_id

UNION ALL

SELECT
  'khoj_click', se.seller_id, COUNT(DISTINCT se.session_id),
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  se.landing_product, b.product_id
FROM sessions se
JOIN buy_now b ON b.seller_id = se.seller_id AND b.session_id = se.session_id
WHERE se.seller_id = '6aad1869bcb80ce92eb3389b'
GROUP BY se.seller_id, se.landing_product, b.product_id
