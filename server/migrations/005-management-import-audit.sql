ALTER TABLE users ADD COLUMN deleted_at timestamptz;
CREATE TABLE audit_log (
 id bigserial PRIMARY KEY, actor_id uuid REFERENCES users(id) ON DELETE RESTRICT,
 actor_login text NOT NULL, action text NOT NULL, entity text NOT NULL, entity_id text, sup text,
 before_data jsonb, after_data jsonb, details jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_idx ON audit_log(created_at DESC,id DESC);
CREATE INDEX audit_log_sup_idx ON audit_log(sup);
CREATE TABLE import_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 kind text NOT NULL CHECK(kind IN ('records','mixtures')), payload jsonb NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes', consumed_at timestamptz
);
CREATE INDEX import_jobs_expiry_idx ON import_jobs(expires_at);
-- Preserve the unique KEYUSER index from migration 004.
-- Existing installations without KEYUSER keep their first active administrator's credentials.
WITH promoted AS (
 UPDATE users SET role='KEYUSER',version=version+1
 WHERE id=(SELECT id FROM users WHERE role='ADMIN' AND active AND deleted_at IS NULL ORDER BY created_at,id LIMIT 1)
 AND NOT EXISTS(SELECT 1 FROM users WHERE role='KEYUSER')
 RETURNING id,login
)
INSERT INTO audit_log(actor_login,action,entity,entity_id,after_data,details)
 SELECT 'system','security.bootstrap_keyuser','users',id::text,jsonb_build_object('id',id,'login',login,'role','KEYUSER'),
 '{"reason":"Hierarchy KEYUSER > ADMIN > EMPLOYEE"}'::jsonb FROM promoted;
