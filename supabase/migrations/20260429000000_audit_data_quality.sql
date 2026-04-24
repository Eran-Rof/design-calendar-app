-- Phase 6: audit trail + data quality issues
-- audit_logs: immutable event trail for all GS1 actions
CREATE TABLE IF NOT EXISTS audit_logs (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text        NOT NULL,
  entity_id   text,
  action      text        NOT NULL,
  old_values  jsonb,
  new_values  jsonb,
  user_label  text,
  source      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_logs_entity_type_idx ON audit_logs (entity_type);
CREATE INDEX IF NOT EXISTS audit_logs_entity_id_idx   ON audit_logs (entity_id);
CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx  ON audit_logs (created_at DESC);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon select audit_logs" ON audit_logs FOR SELECT USING (true);
CREATE POLICY "anon insert audit_logs" ON audit_logs FOR INSERT WITH CHECK (true);

-- data_quality_issues: findings from runDataQualityChecks(); never deleted, only resolved
CREATE TABLE IF NOT EXISTS data_quality_issues (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_type      text        NOT NULL,
  severity        text        NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  entity_type     text,
  entity_id       text,
  message         text        NOT NULL,
  status          text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  context         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  resolution_note text
);

CREATE INDEX IF NOT EXISTS dqi_issue_type_idx  ON data_quality_issues (issue_type);
CREATE INDEX IF NOT EXISTS dqi_status_idx      ON data_quality_issues (status);
CREATE INDEX IF NOT EXISTS dqi_entity_type_idx ON data_quality_issues (entity_type);
CREATE INDEX IF NOT EXISTS dqi_created_at_idx  ON data_quality_issues (created_at DESC);

ALTER TABLE data_quality_issues ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon select data_quality_issues" ON data_quality_issues FOR SELECT USING (true);
CREATE POLICY "anon insert data_quality_issues" ON data_quality_issues FOR INSERT WITH CHECK (true);
CREATE POLICY "anon update data_quality_issues" ON data_quality_issues FOR UPDATE USING (true);
CREATE POLICY "anon delete data_quality_issues" ON data_quality_issues FOR DELETE USING (true);
