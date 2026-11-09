-- Existing OK/NOK and legacy temperature columns are deliberately preserved.
ALTER TABLE measurements ADD COLUMN delta double precision GENERATED ALWAYS AS (abs(actual::numeric-equipment::numeric)::double precision) STORED;
CREATE TABLE corrective_actions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 measurement_key uuid NOT NULL UNIQUE,
 measurement_id uuid REFERENCES measurements(id) ON DELETE SET NULL,
 date date NOT NULL, sup text NOT NULL, mixture_name text NOT NULL,
 actual double precision, equipment double precision, delta double precision,
 initial_data jsonb NOT NULL,
 source_deleted boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'NOT_STARTED' CHECK(status IN ('NOT_STARTED','IN_PROGRESS','DONE')),
 responsible_id uuid REFERENCES users(id) ON DELETE RESTRICT,
 work_done text NOT NULL DEFAULT '' CHECK(length(work_done)<=10000),
 detected_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
 version integer NOT NULL DEFAULT 1
);
CREATE INDEX corrective_date_idx ON corrective_actions(date DESC,id);
CREATE INDEX corrective_status_idx ON corrective_actions(status,date DESC);
CREATE INDEX corrective_responsible_idx ON corrective_actions(responsible_id,date DESC);
CREATE INDEX corrective_sup_idx ON corrective_actions(sup);
CREATE TABLE correction_events (
 id bigserial PRIMARY KEY, correction_id uuid NOT NULL REFERENCES corrective_actions(id) ON DELETE CASCADE,
 kind text NOT NULL, actor_id uuid REFERENCES users(id) ON DELETE RESTRICT,
 actor_login text NOT NULL, actor_name text NOT NULL,
 before_data jsonb, after_data jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX correction_events_parent_idx ON correction_events(correction_id,id DESC);
CREATE TABLE correction_comments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), correction_id uuid NOT NULL REFERENCES corrective_actions(id) ON DELETE CASCADE,
 author_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT, author_name text NOT NULL, author_login text NOT NULL,
 text text NOT NULL CHECK(length(trim(text)) BETWEEN 1 AND 5000), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX correction_comments_parent_idx ON correction_comments(correction_id,created_at DESC,id);
CREATE TABLE daily_reports (
 date date PRIMARY KEY, total integer NOT NULL, ok integer NOT NULL, nok integer NOT NULL, pending integer NOT NULL,
 nok_percent numeric(5,2) NOT NULL, nok_rows jsonb NOT NULL DEFAULT '[]',
 version integer NOT NULL DEFAULT 1, generated_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE report_dirty_days (date date PRIMARY KEY);
CREATE TABLE report_scheduler (id integer PRIMARY KEY CHECK(id=1), last_day date);
INSERT INTO report_scheduler(id) VALUES(1);

CREATE FUNCTION correction_event(p_id uuid,p_kind text,p_before jsonb,p_after jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE aid uuid; alog text; aname text; csup text;
BEGIN
 aid:=nullif(current_setting('mixcontrol.actor_id',true),'')::uuid;
 alog:=coalesce(nullif(current_setting('mixcontrol.actor_login',true),''),'system');
 aname:=coalesce(nullif(current_setting('mixcontrol.actor_name',true),''),'Система');
 INSERT INTO correction_events(correction_id,kind,actor_id,actor_login,actor_name,before_data,after_data)
 VALUES(p_id,p_kind,aid,alog,aname,p_before,p_after);
 SELECT sup INTO csup FROM corrective_actions WHERE id=p_id;
 INSERT INTO audit_log(actor_id,actor_login,action,entity,entity_id,sup,before_data,after_data)
 VALUES(aid,alog,'correction.'||p_kind,'corrective_actions',p_id::text,csup,p_before,p_after);
END $$;

CREATE FUNCTION sync_measurement_correction(m measurements) RETURNS void LANGUAGE plpgsql AS $$
DECLARE cid uuid; previous corrective_actions; snapshot jsonb; fresh corrective_actions;
BEGIN
 snapshot:=jsonb_build_object('date',m.date,'sup',m.sup,'mixtureName',m.mixture_name,'actual',m.actual,'equipment',m.equipment,'delta',m.delta);
 IF m.delta>3 THEN
   INSERT INTO corrective_actions(measurement_key,measurement_id,date,sup,mixture_name,actual,equipment,delta,initial_data)
   VALUES(m.id,m.id,m.date,m.sup,m.mixture_name,m.actual,m.equipment,m.delta,snapshot)
   ON CONFLICT(measurement_key) DO NOTHING RETURNING id INTO cid;
   IF cid IS NOT NULL THEN
     PERFORM correction_event(cid,'detected',NULL,snapshot);
     RETURN;
   END IF;
 END IF;
 SELECT * INTO previous FROM corrective_actions WHERE measurement_key=m.id FOR UPDATE;
 IF FOUND AND ROW(previous.date,previous.sup,previous.mixture_name,previous.actual,previous.equipment,previous.delta)
    IS DISTINCT FROM ROW(m.date,m.sup,m.mixture_name,m.actual,m.equipment,m.delta) THEN
   UPDATE corrective_actions SET date=m.date,sup=m.sup,mixture_name=m.mixture_name,actual=m.actual,equipment=m.equipment,delta=m.delta,
    version=version+1,updated_at=now() WHERE id=previous.id RETURNING * INTO fresh;
   PERFORM correction_event(previous.id,'measurement_changed',to_jsonb(previous),to_jsonb(fresh));
 END IF;
END $$;

CREATE FUNCTION measurement_workflow_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous corrective_actions; fresh corrective_actions;
BEGIN
 IF current_setting('mixcontrol.restoring',true)='true' THEN RETURN NULL; END IF;
 PERFORM pg_advisory_xact_lock(847207,(d-'2000-01-01'::date)::int) FROM (SELECT DISTINCT d FROM unnest(ARRAY[CASE WHEN TG_OP<>'INSERT' THEN OLD.date ELSE NULL END,CASE WHEN TG_OP<>'DELETE' THEN NEW.date ELSE NULL END]) AS d WHERE d IS NOT NULL ORDER BY d) days;
 IF TG_OP<>'INSERT' THEN INSERT INTO report_dirty_days(date) VALUES(OLD.date) ON CONFLICT DO NOTHING; END IF;
 IF TG_OP<>'DELETE' THEN
   INSERT INTO report_dirty_days(date) VALUES(NEW.date) ON CONFLICT DO NOTHING;
   PERFORM sync_measurement_correction(NEW);
 ELSE
   SELECT * INTO previous FROM corrective_actions WHERE measurement_key=OLD.id FOR UPDATE;
   IF FOUND THEN
     UPDATE corrective_actions SET source_deleted=true,version=version+1,updated_at=now() WHERE id=previous.id RETURNING * INTO fresh;
     PERFORM correction_event(previous.id,'measurement_deleted',to_jsonb(previous),to_jsonb(fresh));
   END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER measurement_workflow_changed AFTER INSERT OR UPDATE OR DELETE ON measurements FOR EACH ROW EXECUTE FUNCTION measurement_workflow_changed();

CREATE FUNCTION notify_workflow_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM pg_notify('mixcontrol_changes',TG_ARGV[0]); RETURN NULL; END $$;
CREATE TRIGGER correction_changes AFTER INSERT OR UPDATE ON corrective_actions FOR EACH STATEMENT EXECUTE FUNCTION notify_workflow_changed('corrections');
CREATE TRIGGER comment_changes AFTER INSERT ON correction_comments FOR EACH STATEMENT EXECUTE FUNCTION notify_workflow_changed('corrections');
CREATE TRIGGER report_changes AFTER INSERT OR UPDATE ON daily_reports FOR EACH STATEMENT EXECUTE FUNCTION notify_workflow_changed('reports');
-- Backfill only derived data; measurements and historical results are never changed.
SELECT sync_measurement_correction(m) FROM measurements m;
INSERT INTO report_dirty_days(date) SELECT DISTINCT date FROM measurements ON CONFLICT DO NOTHING;
