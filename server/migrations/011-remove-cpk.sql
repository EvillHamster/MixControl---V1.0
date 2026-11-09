-- Cpk had no tables, persisted results, cache or scheduler. This index served only its window queries.
-- Journal filters retain their existing date, mixture, status and author indexes.
DROP INDEX IF EXISTS measurements_cpk_order_idx;
