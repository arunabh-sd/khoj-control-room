-- Khoj orders since launch, one row per order: new vs repeat orders by day (the dashboard works out which order is a
-- customer's first on Khoj). Small: reads orderitems from 1 Sep 2026 for one seller. Pulled every hour.
SELECT
  order_id,
  ANY_VALUE(customer_id) AS customer_id,
  FORMAT_TIMESTAMP('%Y-%m-%d %H:%M', MIN(createdat), 'Asia/Kolkata') AS createdat,
  ANY_VALUE(payment_mode) AS payment_mode,
  LOGICAL_AND(STARTS_WITH(COALESCE(seller_last_status, ''), 'cancel')) AS cancelled,
  SUM(selling_price * quantity) AS gmv
FROM `nushop.orderitems`
WHERE createdat >= TIMESTAMP "2026-09-01 00:00:00Z"
  AND seller_id = '6aad1869bcb80ce92eb3389b'
  AND customer_id IS NOT NULL
  AND reseller_id IS NULL
  AND COALESCE(seller_last_status, '') NOT IN ('enqueued', 'invalid', 'initiated')
GROUP BY order_id
