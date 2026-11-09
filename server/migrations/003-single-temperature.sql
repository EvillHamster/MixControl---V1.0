ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('ADMIN','KEYUSER','EMPLOYEE'));
ALTER TABLE measurements ADD COLUMN actual double precision CHECK(actual >= -273.15 AND actual <=10000);
ALTER TABLE measurements ADD COLUMN legacy_pending boolean NOT NULL DEFAULT false;
-- Preserve legacy SUPs while migrating existing rows within this transaction.
ALTER TABLE measurements DROP CONSTRAINT measurements_sup_seven_digits;
UPDATE measurements SET actual=CASE WHEN actual_min=actual_max THEN actual_min ELSE NULL END,
 legacy_pending=(actual_min IS DISTINCT FROM actual_max);
ALTER TABLE measurements ADD CONSTRAINT measurements_sup_seven_digits CHECK(sup ~ '^[0-9]{7}$') NOT VALID;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM measurements WHERE sup !~ '^[0-9]{7}$') THEN
  ALTER TABLE measurements VALIDATE CONSTRAINT measurements_sup_seven_digits;
 END IF;
END $$;
-- Original pairs remain untouched. No averaging of ambiguous values.
DROP INDEX IF EXISTS measurements_status_idx;
ALTER TABLE measurements DROP COLUMN status;
ALTER TABLE measurements ADD COLUMN status text GENERATED ALWAYS AS (
 CASE WHEN legacy_pending THEN
   CASE WHEN actual_min IS NULL OR actual_max IS NULL THEN NULL
     WHEN actual_min>=t_min AND actual_max<=t_max AND actual_min<=actual_max THEN 'OK' ELSE 'NOK' END
 ELSE CASE WHEN actual IS NULL THEN NULL WHEN actual>=t_min AND actual<=t_max THEN 'OK' ELSE 'NOK' END END
) STORED;
CREATE INDEX measurements_status_idx ON measurements(status);
