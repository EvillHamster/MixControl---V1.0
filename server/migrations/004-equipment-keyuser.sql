-- Includes disabled accounts: the KEYUSER role can belong to only one user.
CREATE UNIQUE INDEX users_single_keyuser ON users(role) WHERE role='KEYUSER';
ALTER TABLE measurements ADD COLUMN equipment double precision CHECK(equipment >= -273.15 AND equipment <=10000);
DROP INDEX measurements_status_idx;
ALTER TABLE measurements DROP COLUMN status;
ALTER TABLE measurements ADD COLUMN status text GENERATED ALWAYS AS (
 CASE WHEN (actual IS NOT NULL AND (actual<t_min OR actual>t_max))
        OR (equipment IS NOT NULL AND (equipment<t_min OR equipment>t_max)) THEN 'NOK'
 WHEN legacy_pending THEN
   CASE WHEN actual_min IS NULL OR actual_max IS NULL THEN NULL
     WHEN actual_min>=t_min AND actual_max<=t_max AND actual_min<=actual_max THEN 'OK' ELSE 'NOK' END
 WHEN actual IS NULL OR equipment IS NULL THEN NULL
 ELSE 'OK' END
) STORED;
CREATE INDEX measurements_status_idx ON measurements(status);
