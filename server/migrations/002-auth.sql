CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 login varchar(64) NOT NULL UNIQUE CHECK(login=lower(login) AND login ~ '^[a-z0-9._-]{3,64}$'),
 name varchar(120) NOT NULL CHECK(length(trim(name))>0),
 password_hash text NOT NULL,
 role text NOT NULL CHECK(role IN ('ADMIN','EMPLOYEE')),
 active boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
 token_hash char(64) PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
ALTER TABLE measurements ADD COLUMN created_by uuid REFERENCES users(id) ON DELETE RESTRICT;
CREATE INDEX measurements_author_idx ON measurements(created_by);
-- Existing rows are retained verbatim. New writes must satisfy the new rule.
ALTER TABLE measurements ADD CONSTRAINT measurements_sup_seven_digits CHECK(sup ~ '^[0-9]{7}$') NOT VALID;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM measurements WHERE sup !~ '^[0-9]{7}$') THEN
  ALTER TABLE measurements VALIDATE CONSTRAINT measurements_sup_seven_digits;
 END IF;
END $$;
CREATE FUNCTION mixcontrol_notify_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_notify('mixcontrol_changes', TG_TABLE_NAME);
 RETURN NULL;
END $$;
CREATE TRIGGER measurements_changed AFTER INSERT OR UPDATE OR DELETE ON measurements FOR EACH STATEMENT EXECUTE FUNCTION mixcontrol_notify_change();
CREATE TRIGGER mixtures_changed AFTER INSERT OR UPDATE OR DELETE ON mixtures FOR EACH STATEMENT EXECUTE FUNCTION mixcontrol_notify_change();
CREATE TRIGGER users_changed AFTER INSERT OR UPDATE OR DELETE ON users FOR EACH STATEMENT EXECUTE FUNCTION mixcontrol_notify_change();
