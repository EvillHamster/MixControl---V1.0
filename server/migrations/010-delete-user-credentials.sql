-- Retain only the immutable historical identity; deleted accounts have no credentials.
ALTER TABLE users ALTER COLUMN login DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE deleted_at IS NOT NULL);
DELETE FROM import_jobs WHERE actor_id IN (SELECT id FROM users WHERE deleted_at IS NOT NULL);
UPDATE users SET login=NULL,password_hash=NULL,active=false WHERE deleted_at IS NOT NULL;
-- Existing UNIQUE(login) still rejects duplicates of all non-deleted accounts, including disabled ones.
-- PostgreSQL permits multiple NULL values, so historical identities never reserve a login.
ALTER TABLE users ADD CONSTRAINT users_credentials_lifecycle CHECK (
 (deleted_at IS NULL AND login IS NOT NULL AND password_hash IS NOT NULL)
 OR (deleted_at IS NOT NULL AND login IS NULL AND password_hash IS NULL AND NOT active)
);
