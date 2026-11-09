-- Remove obsolete derived tasks only; the immutable source UUID is the key.
WITH removed AS (
 DELETE FROM corrective_actions c
 WHERE NOT EXISTS (SELECT 1 FROM measurements m WHERE m.id=c.measurement_key)
 RETURNING c.*
)
INSERT INTO audit_log(actor_login,action,entity,entity_id,sup,before_data,details)
SELECT 'system','correction.orphan_deleted','corrective_actions',id::text,sup,to_jsonb(removed),
 jsonb_build_object('reason','Source measurement no longer exists','measurementId',measurement_key,'correctionId',id)
FROM removed;

-- The permanent UUID must always reference a real measurement, even for direct SQL writes.
ALTER TABLE corrective_actions ADD CONSTRAINT corrective_actions_source_fkey
 FOREIGN KEY(measurement_key) REFERENCES measurements(id) ON DELETE CASCADE;

-- Audit and remove before referential actions, in the same transaction as source deletion.
CREATE FUNCTION delete_measurement_correction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous corrective_actions; aid uuid; alog text; aname text;
BEGIN
 SELECT * INTO previous FROM corrective_actions WHERE measurement_key=OLD.id FOR UPDATE;
 IF FOUND THEN
  aid:=nullif(current_setting('mixcontrol.actor_id',true),'')::uuid;
  alog:=coalesce(nullif(current_setting('mixcontrol.actor_login',true),''),'system');
  aname:=coalesce(nullif(current_setting('mixcontrol.actor_name',true),''),'Система');
  INSERT INTO audit_log(actor_id,actor_login,action,entity,entity_id,sup,before_data,details)
  VALUES(aid,alog,'correction.source_deleted','corrective_actions',previous.id::text,previous.sup,to_jsonb(previous),
   jsonb_build_object('reason','Source measurement deleted','measurementId',OLD.id,'correctionId',previous.id,'actorName',aname));
  DELETE FROM corrective_actions WHERE id=previous.id;
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER delete_measurement_correction BEFORE DELETE ON measurements
 FOR EACH ROW EXECUTE FUNCTION delete_measurement_correction();
