CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY);
CREATE TABLE IF NOT EXISTS mixtures (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(120) NOT NULL CHECK(length(trim(name))>0),
 t_min double precision NOT NULL CHECK(t_min >= -273.15 AND t_min <=10000),
 t_max double precision NOT NULL CHECK(t_max >= t_min AND t_max <=10000),
 archived boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS measurements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), date date NOT NULL DEFAULT CURRENT_DATE,
 sup varchar(80) NOT NULL UNIQUE CHECK(sup=upper(trim(sup)) AND length(sup)>0),
 mixture_id uuid NOT NULL REFERENCES mixtures(id) ON DELETE RESTRICT,
 mixture_name varchar(120) NOT NULL,
 t_min double precision NOT NULL CHECK(t_min >= -273.15 AND t_min <=10000),
 t_max double precision NOT NULL CHECK(t_max >= t_min AND t_max <=10000),
 actual_min double precision CHECK(actual_min >= -273.15 AND actual_min <=10000),
 actual_max double precision CHECK(actual_max >= -273.15 AND actual_max <=10000),
 status text GENERATED ALWAYS AS (CASE WHEN actual_min IS NULL OR actual_max IS NULL THEN NULL WHEN actual_min >= t_min AND actual_max <= t_max AND actual_min <= actual_max THEN 'OK' ELSE 'NOK' END) STORED,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS measurements_date_idx ON measurements(date DESC,created_at DESC);
CREATE INDEX IF NOT EXISTS measurements_mixture_idx ON measurements(mixture_id);
CREATE INDEX IF NOT EXISTS measurements_status_idx ON measurements(status);
