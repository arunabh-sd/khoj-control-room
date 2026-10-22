-- Which columns each event table has (one row per table). Used to find a customer key for browsing → customer,
-- and traffic-source / device columns for the explore RCA.
SELECT table_name, STRING_AGG(CONCAT(column_name, ' ', data_type), ', ' ORDER BY ordinal_position) AS columns
FROM `blitzscale-prod-project.events.INFORMATION_SCHEMA.COLUMNS`
GROUP BY table_name
ORDER BY table_name
