-- Visit rate after delivery: Khoj vs the parent sellers of what Khoj has sold (the dashboard weights sellers by
-- Khoj orders). {{parent_sellers}}: Metabase variable of type Text, not required (filled by the dashboard).
-- Customers with an order delivered 8–37 days ago; "visited" = opened any product page on the SAME site within
-- 7 (and 14, for those delivered 15+ days ago) days after delivery. A visit counts when the visitor is tied to the
-- customer: the customer id or a user id seen on that customer's order-success page, matched to the visitor through
-- product pages, checkout, OTP or ShopDeck sign-in. Logged-out visits on unknown devices can't be seen, on both sides.
WITH sellers AS (
  SELECT '6aad1869bcb80ce92eb3389b' AS seller_id
  [[UNION DISTINCT SELECT TRIM(x) FROM UNNEST(SPLIT({{parent_sellers}}, ',')) AS x WHERE TRIM(x) <> '']]
),
deliv AS (
  SELECT oi.seller_id, oi.customer_id, MIN(oi.delivery_time) AS delivered_at, ARRAY_AGG(DISTINCT oi.order_id) AS orders
  FROM `nushop.orderitems` oi
  JOIN sellers s ON s.seller_id = oi.seller_id
  WHERE oi.createdat >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 60 DAY)
    AND oi.customer_id IS NOT NULL
    AND oi.reseller_id IS NULL
    AND oi.delivery_time IS NOT NULL
    AND oi.delivery_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 37 DAY)
    AND oi.delivery_time <  TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 8 DAY)
    AND (COALESCE(oi.in_house_status, '') = 'delivered' OR COALESCE(oi.seller_last_status, '') = 'delivered')
  GROUP BY 1, 2
),
users AS (
  SELECT DISTINCT d.customer_id, d.customer_id AS user_id FROM deliv d
  UNION DISTINCT
  SELECT DISTINCT d.customer_id, e.user_id
  FROM deliv d
  CROSS JOIN UNNEST(d.orders) AS oid
  JOIN `events.order_success_opened` e ON e.order_id = oid
  WHERE COALESCE(e.user_id, '') <> ''
    AND e.created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 60 DAY)
),
seen AS (
  SELECT visitor_id, user_id FROM `events.product_page_opened`
  WHERE created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 60 DAY) AND COALESCE(user_id, '') <> '' AND COALESCE(visitor_id, '') <> ''
  UNION DISTINCT
  SELECT visitor_id, user_id FROM `events.checkout_initiated`
  WHERE created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 60 DAY) AND COALESCE(user_id, '') <> '' AND COALESCE(visitor_id, '') <> ''
  UNION DISTINCT
  SELECT visitor_id, user_id FROM `events.otp_verification`
  WHERE created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 60 DAY) AND COALESCE(user_id, '') <> '' AND COALESCE(visitor_id, '') <> ''
  UNION DISTINCT
  SELECT visitor_id, user_id FROM `events.sd_sso_token_exists`
  WHERE created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 60 DAY) AND COALESCE(user_id, '') <> '' AND COALESCE(visitor_id, '') <> ''
),
cust_visitors AS (
  SELECT DISTINCT u.customer_id, s.visitor_id FROM users u JOIN seen s ON s.user_id = u.user_id
),
visits AS (
  SELECT p.seller_id, cv.customer_id, p.created_at
  FROM `events.product_page_opened` p
  JOIN cust_visitors cv ON cv.visitor_id = p.visitor_id
  WHERE p.created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 37 DAY)
    AND p.seller_id IN (SELECT seller_id FROM sellers)
),
x AS (
  SELECT d.seller_id, d.customer_id, d.delivered_at,
    LOGICAL_OR(v.created_at > d.delivered_at AND v.created_at <= TIMESTAMP_ADD(d.delivered_at, INTERVAL 7 DAY))  AS v7,
    LOGICAL_OR(v.created_at > d.delivered_at AND v.created_at <= TIMESTAMP_ADD(d.delivered_at, INTERVAL 14 DAY)) AS v14
  FROM deliv d
  LEFT JOIN visits v ON v.seller_id = d.seller_id AND v.customer_id = d.customer_id
  GROUP BY 1, 2, 3
)
SELECT
  seller_id,
  COUNT(*) AS delivered_customers,
  COUNTIF(v7) AS visited_7d,
  COUNTIF(delivered_at < TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 15 DAY)) AS eligible_14d,
  COUNTIF(delivered_at < TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 15 DAY) AND v14) AS visited_14d
FROM x
GROUP BY seller_id
