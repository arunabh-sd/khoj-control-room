-- Khoj buyers' browsing on ShopDeck seller sites (product pages), from 30 days before their first Khoj order.
-- One row per customer × seller × product × day, with the first view that day. Khoj's own site is left out.
-- A browser is tied to a customer when it is seen with that customer's user_id: on product pages, checkout,
-- OTP or ShopDeck sign-in events, either as the same id or through an order the user placed.
WITH khoj_buyers AS (
  SELECT customer_id, MIN(createdat) AS first_khoj
  FROM `nushop.orderitems`
  WHERE seller_id = '6aad1869bcb80ce92eb3389b'
    AND customer_id IS NOT NULL
    AND createdat >= TIMESTAMP "2026-09-01 00:00:00Z"
    AND COALESCE(seller_last_status, '') NOT IN ('enqueued', 'invalid', 'initiated')
  GROUP BY 1
),
order_users AS (
  SELECT DISTINCT e.user_id, oi.customer_id
  FROM `events.order_success_opened` e
  JOIN `nushop.orderitems` oi ON oi.order_id = e.order_id
  JOIN khoj_buyers k ON k.customer_id = oi.customer_id
  WHERE COALESCE(e.user_id, '') <> ''
    AND e.created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 365 DAY)
    AND oi.createdat >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 365 DAY)
),
users AS (
  SELECT customer_id AS user_id, customer_id FROM khoj_buyers
  UNION DISTINCT
  SELECT user_id, customer_id FROM order_users
),
seen AS (
  SELECT visitor_id, user_id FROM `events.product_page_opened`
  WHERE DATE(created_at, 'Asia/Kolkata') >= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 90 DAY) AND COALESCE(user_id, '') <> '' AND COALESCE(visitor_id, '') <> ''
  UNION DISTINCT
  SELECT visitor_id, user_id FROM `events.checkout_initiated`
  WHERE DATE(created_at, 'Asia/Kolkata') >= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 90 DAY) AND COALESCE(user_id, '') <> '' AND COALESCE(visitor_id, '') <> ''
  UNION DISTINCT
  SELECT visitor_id, user_id FROM `events.otp_verification`
  WHERE DATE(created_at, 'Asia/Kolkata') >= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 90 DAY) AND COALESCE(user_id, '') <> '' AND COALESCE(visitor_id, '') <> ''
  UNION DISTINCT
  SELECT visitor_id, user_id FROM `events.sd_sso_token_exists`
  WHERE DATE(created_at, 'Asia/Kolkata') >= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 90 DAY) AND COALESCE(user_id, '') <> '' AND COALESCE(visitor_id, '') <> ''
),
visitors AS (
  SELECT DISTINCT s.visitor_id, u.customer_id
  FROM seen s
  JOIN users u ON u.user_id = s.user_id
)
SELECT
  v.customer_id, p.seller_id, CAST(p.product_id AS STRING) AS product_id,
  FORMAT_TIMESTAMP('%Y-%m-%d %H:%M', MIN(p.created_at), 'Asia/Kolkata') AS first_view,
  COUNT(*) AS views
FROM `events.product_page_opened` p
JOIN visitors v ON v.visitor_id = p.visitor_id
JOIN khoj_buyers k ON k.customer_id = v.customer_id
WHERE DATE(p.created_at, 'Asia/Kolkata') >= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 90 DAY)
  AND p.created_at >= TIMESTAMP_SUB(k.first_khoj, INTERVAL 30 DAY)
  AND p.seller_id != '6aad1869bcb80ce92eb3389b'
GROUP BY v.customer_id, p.seller_id, CAST(p.product_id AS STRING), DATE(p.created_at, 'Asia/Kolkata')
