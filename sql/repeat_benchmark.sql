-- Repeat benchmark · each seller site's own repeat, for Khoj and the parent sellers of what Khoj has sold
-- {{parent_sellers}}: Metabase variable of type Text, not required (filled by the dashboard).
-- Cohort: customers whose first order with the seller (ever) was in the last 120 days.
-- Repeat: another order with the same seller more than 30 minutes after that first order (same rule as Khoj).
-- Each window only counts customers whose first order is at least that old.
WITH sellers AS (
  SELECT '6aad1869bcb80ce92eb3389b' AS seller_id
  [[UNION DISTINCT SELECT TRIM(x) FROM UNNEST(SPLIT({{parent_sellers}}, ',')) AS x WHERE TRIM(x) <> '']]
),
orders AS (
  SELECT oi.seller_id, oi.customer_id, oi.customer_product_short_id AS product_id, oi.createdat, oi.payment_mode,
         REGEXP_CONTAINS(COALESCE(oi.meta, ''), r'(^|,)first_order(,|$)') AS first_ever
  FROM `nushop.orderitems` oi
  JOIN sellers s ON oi.seller_id = s.seller_id
  WHERE oi.createdat >= TIMESTAMP "2020-01-01 00:00:00Z"
    AND oi.customer_id IS NOT NULL
    AND oi.reseller_id IS NULL
    AND COALESCE(oi.seller_last_status, '') NOT IN ('enqueued', 'invalid', 'initiated')
    AND NOT STARTS_WITH(COALESCE(oi.seller_last_status, ''), 'cancel')
),
firsts AS (
  SELECT seller_id, customer_id,
         ARRAY_AGG(STRUCT(createdat, product_id, payment_mode, first_ever) ORDER BY createdat LIMIT 1)[OFFSET(0)] AS f
  FROM orders
  GROUP BY 1, 2
),
cohort AS (
  SELECT seller_id, customer_id,
         f.createdat AS first_at, f.product_id AS first_product, f.first_ever,
         IF(f.payment_mode IN ('cod', 'partial-cod'), 'COD', 'Prepaid') AS pay,
         TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), f.createdat, DAY) AS age_days
  FROM firsts
  WHERE f.createdat >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 120 DAY)
),
repeats AS (
  SELECT c.seller_id, c.customer_id,
         MIN(TIMESTAMP_DIFF(o.createdat, c.first_at, MINUTE)) AS first_repeat_min,
         COUNTIF(TIMESTAMP_DIFF(o.createdat, c.first_at, DAY) < 28) AS lines_28,
         COUNTIF(TIMESTAMP_DIFF(o.createdat, c.first_at, DAY) < 28 AND o.product_id = c.first_product) AS same_product_28
  FROM cohort c
  JOIN orders o ON o.seller_id = c.seller_id AND o.customer_id = c.customer_id
  WHERE o.createdat > TIMESTAMP_ADD(c.first_at, INTERVAL 30 MINUTE)
  GROUP BY 1, 2
),
x AS (
  SELECT c.*, r.first_repeat_min, COALESCE(r.lines_28, 0) AS lines_28, COALESCE(r.same_product_28, 0) AS same_product_28
  FROM cohort c
  LEFT JOIN repeats r USING (seller_id, customer_id)
)
SELECT
  seller_id,
  COUNT(*) AS customers,
  COUNTIF(age_days >= 7)  AS eligible_7,  COUNTIF(age_days >= 7  AND first_repeat_min <= 7 * 1440)  AS repeat_7,
  COUNTIF(age_days >= 14) AS eligible_14, COUNTIF(age_days >= 14 AND first_repeat_min <= 14 * 1440) AS repeat_14,
  COUNTIF(age_days >= 28) AS eligible_28, COUNTIF(age_days >= 28 AND first_repeat_min <= 28 * 1440) AS repeat_28,
  SUM(IF(age_days >= 28, lines_28, 0))        AS repeat_lines_28,
  SUM(IF(age_days >= 28, same_product_28, 0)) AS repeat_same_product_28,
  COUNTIF(age_days >= 14 AND pay = 'COD')     AS cod_eligible_14,
  COUNTIF(age_days >= 14 AND pay = 'COD'     AND first_repeat_min <= 14 * 1440) AS cod_repeat_14,
  COUNTIF(age_days >= 14 AND pay = 'Prepaid') AS prepaid_eligible_14,
  COUNTIF(age_days >= 14 AND pay = 'Prepaid' AND first_repeat_min <= 14 * 1440) AS prepaid_repeat_14,
  COUNTIF(age_days >= 14 AND first_ever)      AS new_eligible_14,
  COUNTIF(age_days >= 14 AND first_ever      AND first_repeat_min <= 14 * 1440) AS new_repeat_14,
  COUNTIF(age_days >= 14 AND NOT first_ever)  AS returning_eligible_14,
  COUNTIF(age_days >= 14 AND NOT first_ever  AND first_repeat_min <= 14 * 1440) AS returning_repeat_14
FROM x
GROUP BY seller_id
