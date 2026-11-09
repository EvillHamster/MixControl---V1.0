-- Keep historical comments even when an erroneous correction is physically removed.
ALTER TABLE correction_comments ADD COLUMN original_correction_id uuid;
UPDATE correction_comments SET original_correction_id=correction_id;
ALTER TABLE correction_comments DROP CONSTRAINT correction_comments_correction_id_fkey;
ALTER TABLE correction_comments ALTER COLUMN correction_id DROP NOT NULL;
ALTER TABLE correction_comments ADD CONSTRAINT correction_comments_correction_id_fkey FOREIGN KEY(correction_id) REFERENCES corrective_actions(id) ON DELETE SET NULL;
ALTER TABLE correction_comments ALTER COLUMN original_correction_id SET NOT NULL;

CREATE INDEX corrections_active_page_idx ON corrective_actions(date DESC,detected_at DESC,id) WHERE status IN ('NOT_STARTED','IN_PROGRESS');
CREATE INDEX corrections_archive_page_idx ON corrective_actions(date DESC,detected_at DESC,id) WHERE status='DONE';
CREATE OR REPLACE FUNCTION sync_measurement_correction(m measurements) RETURNS void LANGUAGE plpgsql AS $$
DECLARE cid uuid; previous corrective_actions; snapshot jsonb; fresh corrective_actions;
 aid uuid; alog text; aname text;
BEGIN
 snapshot:=jsonb_build_object('date',m.date,'sup',m.sup,'mixtureName',m.mixture_name,'actual',m.actual,'equipment',m.equipment,'delta',m.delta);
 SELECT * INTO previous FROM corrective_actions WHERE measurement_key=m.id FOR UPDATE;
 IF FOUND THEN
  IF m.delta<=3 AND ROW(previous.actual,previous.equipment) IS DISTINCT FROM ROW(m.actual,m.equipment) THEN
   aid:=nullif(current_setting('mixcontrol.actor_id',true),'')::uuid;
   alog:=coalesce(nullif(current_setting('mixcontrol.actor_login',true),''),'system');
   aname:=coalesce(nullif(current_setting('mixcontrol.actor_name',true),''),'Система');
   INSERT INTO audit_log(actor_id,actor_login,action,entity,entity_id,sup,before_data,after_data,details)
   VALUES(aid,alog,'correction.auto_deleted','corrective_actions',previous.id::text,m.sup,to_jsonb(previous),snapshot,
    jsonb_build_object('reason','Temperatures corrected: delta <= 3 C','measurementId',m.id,'correctionId',previous.id,'actorName',aname,'threshold',3));
   DELETE FROM corrective_actions WHERE id=previous.id;
   RETURN;
  END IF;
  IF ROW(previous.date,previous.sup,previous.mixture_name,previous.actual,previous.equipment,previous.delta)
    IS DISTINCT FROM ROW(m.date,m.sup,m.mixture_name,m.actual,m.equipment,m.delta) THEN
   UPDATE corrective_actions SET date=m.date,sup=m.sup,mixture_name=m.mixture_name,actual=m.actual,equipment=m.equipment,delta=m.delta,
    version=version+1,updated_at=now() WHERE id=previous.id RETURNING * INTO fresh;
   PERFORM correction_event(previous.id,'measurement_changed',to_jsonb(previous),to_jsonb(fresh));
  END IF;
  RETURN;
 END IF;
 IF m.delta>3 THEN
  INSERT INTO corrective_actions(measurement_key,measurement_id,date,sup,mixture_name,actual,equipment,delta,initial_data)
  VALUES(m.id,m.id,m.date,m.sup,m.mixture_name,m.actual,m.equipment,m.delta,snapshot)
  ON CONFLICT(measurement_key) DO NOTHING RETURNING id INTO cid;
  IF cid IS NOT NULL THEN PERFORM correction_event(cid,'detected',NULL,snapshot); END IF;
 END IF;
END $$;
DROP TRIGGER correction_changes ON corrective_actions;
CREATE TRIGGER correction_changes AFTER INSERT OR UPDATE OR DELETE ON corrective_actions FOR EACH STATEMENT EXECUTE FUNCTION notify_workflow_changed('corrections');
