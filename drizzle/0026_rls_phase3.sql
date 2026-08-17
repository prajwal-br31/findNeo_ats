-- 026 — RLS for the Phase 3 tables.
--
-- The T-023 schema assertion enumerates the catalog rather than a maintained
-- list, so it starts failing the moment a tenant table is added without a
-- forced policy. That is why this migration is written in the same change as
-- 024 and 025 rather than after them.

ALTER TABLE candidates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE candidates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON candidates
  AS PERMISSIVE FOR ALL TO findneo_app
  USING      (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

-- The one table whose tenant column is not named `company_id` (06b §1). The
-- policy is otherwise identical — and it is spelled out here rather than
-- generated, so the deviation is visible to anyone auditing this file.
ALTER TABLE talent_pool_entries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE talent_pool_entries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON talent_pool_entries
  AS PERMISSIVE FOR ALL TO findneo_app
  USING      (owner_company_id = nullif(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (owner_company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE candidate_resumes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE candidate_resumes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON candidate_resumes
  AS PERMISSIVE FOR ALL TO findneo_app
  USING      (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE parsed_resume_data ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE parsed_resume_data FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON parsed_resume_data
  AS PERMISSIVE FOR ALL TO findneo_app
  USING      (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE applications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE applications FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON applications
  AS PERMISSIVE FOR ALL TO findneo_app
  USING      (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE stage_decisions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE stage_decisions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON stage_decisions
  AS PERMISSIVE FOR ALL TO findneo_app
  USING      (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

-- Split read/write, the same shape as `roles` and `settings`: a company must
-- READ the platform-default reasons, and must never be able to modify one.
ALTER TABLE decision_reasons ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE decision_reasons FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_read_with_platform_defaults ON decision_reasons
  AS PERMISSIVE FOR SELECT TO findneo_app
  USING (
    company_id = nullif(current_setting('app.current_company_id', true), '')::uuid
    OR company_id IS NULL
  );
--> statement-breakpoint
CREATE POLICY tenant_insert ON decision_reasons
  AS PERMISSIVE FOR INSERT TO findneo_app
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_update ON decision_reasons
  AS PERMISSIVE FOR UPDATE TO findneo_app
  USING      (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_delete ON decision_reasons
  AS PERMISSIVE FOR DELETE TO findneo_app
  USING (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE stage_decision_reasons ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE stage_decision_reasons FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON stage_decision_reasons
  AS PERMISSIVE FOR ALL TO findneo_app
  USING      (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
