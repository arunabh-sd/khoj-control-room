-- Order quality: Khoj vs the SAME products on their own seller sites (product-matched)
-- {{khoj_products}}: Metabase variable of type Text, not required. Filled by the dashboard (same format as the
--   personalisation question): "khoj_product_or_sku_id|parent_seller_id|parent_seller_product_id|category;..."
-- Two windows, IST order dates:
--   l15: D-15 to D-1, for online share and cancellation
--   rto: D-17 to D-10 (old enough to have settled), for RTO = 1 − delivered ÷ non-cancelled
-- One row per side (khoj / seller) × window × parent product × payment (COD / Online). Reads ~19 days of orderitems.
WITH params AS (
  SELECT CONCAT('' [[, {{khoj_products}}]]) AS kp_text
),
kp AS (
  SELECT DISTINCT
    SPLIT(x, '|')[SAFE_OFFSET(0)] AS khoj_key,
    SPLIT(x, '|')[SAFE_OFFSET(1)] AS parent_seller,
    SPLIT(x, '|')[SAFE_OFFSET(2)] AS parent_product,
    SPLIT(x, '|')[SAFE_OFFSET(3)] AS cat
  FROM params, UNNEST(SPLIT(kp_text, ';')) AS x
  WHERE x <> ''
),
matched AS (
  SELECT * FROM kp WHERE COALESCE(parent_seller, '') <> '' AND COALESCE(parent_product, '') <> ''
),
parents AS (
  SELECT DISTINCT parent_seller, parent_product, cat FROM matched
),
oi AS (
  SELECT
    o.order_id, o.seller_id, o.customer_product_short_id AS product_id,
    IF(o.payment_mode IN ('cod', 'partial-cod'), 'COD', 'Online') AS pay,
    DATE(o.createdat, 'Asia/Kolkata') AS d,
    STARTS_WITH(COALESCE(o.seller_last_status, ''), 'cancel') AS is_cancel,
    (COALESCE(o.in_house_status, '') = 'delivered' OR COALESCE(o.seller_last_status, '') = 'delivered') AS is_delivered
  FROM `nushop.orderitems` o
  WHERE o.createdat >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 19 DAY)
    AND o.reseller_id IS NULL
    AND COALESCE(o.seller_last_status, '') NOT IN ('enqueued', 'invalid', 'initiated')
    AND (o.seller_id = '6aad1869bcb80ce92eb3389b' OR o.seller_id IN (SELECT parent_seller FROM parents))
),
tagged AS (
  SELECT 'khoj' AS side, m.parent_product, m.cat, o.order_id, o.pay, o.d, o.is_cancel, o.is_delivered
  FROM oi o
  JOIN (SELECT DISTINCT khoj_key, parent_product, cat FROM matched) m ON o.product_id = m.khoj_key
  WHERE o.seller_id = '6aad1869bcb80ce92eb3389b'
  UNION ALL
  SELECT 'seller' AS side, p.parent_product, p.cat, o.order_id, o.pay, o.d, o.is_cancel, o.is_delivered
  FROM oi o
  JOIN parents p ON o.seller_id = p.parent_seller AND o.product_id = p.parent_product
),
win AS (
  SELECT 'l15' AS window_key, t.* FROM tagged t
  WHERE t.d BETWEEN DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 15 DAY) AND DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY)
  UNION ALL
  SELECT 'rto' AS window_key, t.* FROM tagged t
  WHERE t.d BETWEEN DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 17 DAY) AND DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 10 DAY)
)
SELECT
  side, window_key, parent_product, ANY_VALUE(cat) AS cat, pay,
  COUNT(DISTINCT order_id) AS orders,
  COUNT(DISTINCT IF(is_cancel, order_id, NULL)) AS cancelled,
  COUNT(DISTINCT IF(NOT is_cancel, order_id, NULL)) AS non_cancelled,
  COUNT(DISTINCT IF(NOT is_cancel AND is_delivered, order_id, NULL)) AS delivered
FROM win
GROUP BY side, window_key, parent_product, pay
