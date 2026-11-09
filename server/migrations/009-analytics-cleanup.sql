-- Derived comments must disappear together with the deleted task, as must its history.
WITH removed AS (DELETE FROM correction_comments WHERE correction_id IS NULL RETURNING id)
INSERT INTO audit_log(actor_login,action,entity,details)
SELECT 'system','correction.related_cleanup','correction_comments',jsonb_build_object('reason','Deleted corrective action','count',count(*)) FROM removed HAVING count(*)>0;
ALTER TABLE correction_comments DROP CONSTRAINT correction_comments_correction_id_fkey;
ALTER TABLE correction_comments ALTER COLUMN correction_id SET NOT NULL;
ALTER TABLE correction_comments ADD CONSTRAINT correction_comments_correction_id_fkey FOREIGN KEY(correction_id) REFERENCES corrective_actions(id) ON DELETE CASCADE;
CREATE INDEX measurements_cpk_order_idx ON measurements(mixture_id,date,created_at,id);
