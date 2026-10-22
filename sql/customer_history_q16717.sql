-- Q16717 · Khoj buyers' ShopDeck order history, last 12 months (Khoj's own orders included)
WITH target_customers AS (
  SELECT DISTINCT customer_id
  FROM `nushop.orderitems`
  WHERE createdat >= TIMESTAMP "2020-01-01 00:00:00Z"
    AND seller_id = '6aad1869bcb80ce92eb3389b'            -- Khoj by ShopDeck
    AND customer_id IS NOT NULL
    AND COALESCE(seller_last_status, '') NOT IN ('enqueued', 'invalid', 'initiated')
)
SELECT
  o.order_id, o.customer_id, o.seller_id, o.seller_name,
  o.customer_product_short_id, o.product_name,
  FORMAT_TIMESTAMP('%Y-%m-%d %H:%M', o.createdat, 'Asia/Kolkata')     AS createdat,
  FORMAT_TIMESTAMP('%Y-%m-%d %H:%M', o.delivery_time, 'Asia/Kolkata') AS delivery_time,
  o.selling_price, o.quantity, o.payment_mode, o.in_house_status, o.seller_last_status, o.pincode, o.meta
FROM `nushop.orderitems` o
JOIN target_customers t ON o.customer_id = t.customer_id
WHERE o.createdat >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 365 DAY)
  AND COALESCE(o.seller_last_status, '') NOT IN ('enqueued', 'invalid', 'initiated')
