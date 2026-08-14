-- 022 — RLS for the Phase 2 tables.
--
-- Migration 013 covered everything that existed then; these tables arrive
-- after it, so they get the same treatment here. The schema assertion in
-- T-023 enumerates the catalog rather than a maintained list, so it starts
-- failing the moment one of these is added without a policy — which is how
-- this migration came to be written in the same change as 010-012.

-- form_templates, versions and fields: company rows plus platform defaults,
-- the same split-policy shape as `roles` and `settings`. A company must READ
-- the platform default template; writes stay strictly tenant-scoped so it can
-- never modify one.
ALTER TABLE form_templates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE form_templates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_read_with_platform_defaults ON form_templates
  AS PERMISSIVE FOR SELECT TO findneo_app
  USING (
    company_id = nullif(current_setting('app.current_company_id', true), '')::uuid
    OR company_id IS NULL
  );
--> statement-breakpoint
CREATE POLICY tenant_insert ON form_templates
  AS PERMISSIVE FOR INSERT TO findneo_app
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_update ON form_templates
  AS PERMISSIVE FOR UPDATE TO findneo_app
  USING      (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_delete ON form_templates
  AS PERMISSIVE FOR DELETE TO findneo_app
  USING (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE form_template_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE form_template_versions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_read_with_platform_defaults ON form_template_versions
  AS PERMISSIVE FOR SELECT TO findneo_app
  USING (
    company_id = nullif(current_setting('app.current_company_id', true), '')::uuid
    OR company_id IS NULL
  );
--> statement-breakpoint
CREATE POLICY tenant_insert ON form_template_versions
  AS PERMISSIVE FOR INSERT TO findneo_app
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_update ON form_template_versions
  AS PERMISSIVE FOR UPDATE TO findneo_app
  USING      (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_delete ON form_template_versions
  AS PERMISSIVE FOR DELETE TO findneo_app
  USING (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE form_template_fields ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE form_template_fields FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_read_with_platform_defaults ON form_template_fields
  AS PERMISSIVE FOR SELECT TO findneo_app
  USING (
    company_id = nullif(current_setting('app.current_company_id', true), '')::uuid
    OR company_id IS NULL
  );
--> statement-breakpoint
CREATE POLICY tenant_insert ON form_template_fields
  AS PERMISSIVE FOR INSERT TO findneo_app
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_update ON form_template_fields
  AS PERMISSIVE FOR UPDATE TO findneo_app
  USING      (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_delete ON form_template_fields
  AS PERMISSIVE FOR DELETE TO findneo_app
  USING (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

-- skills and pipeline_templates: same shape again — platform-seeded rows are
-- readable by all, writable by none.
ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE skills FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_read_with_platform_defaults ON skills
  AS PERMISSIVE FOR SELECT TO findneo_app
  USING (
    company_id = nullif(current_setting('app.current_company_id', true), '')::uuid
    OR company_id IS NULL
  );
--> statement-breakpoint
CREATE POLICY tenant_insert ON skills
  AS PERMISSIVE FOR INSERT TO findneo_app
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_update ON skills
  AS PERMISSIVE FOR UPDATE TO findneo_app
  USING      (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_delete ON skills
  AS PERMISSIVE FOR DELETE TO findneo_app
  USING (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE pipeline_templates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pipeline_templates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_read_with_platform_defaults ON pipeline_templates
  AS PERMISSIVE FOR SELECT TO findneo_app
  USING (
    company_id = nullif(current_setting('app.current_company_id', true), '')::uuid
    OR company_id IS NULL
  );
--> statement-breakpoint
CREATE POLICY tenant_insert ON pipeline_templates
  AS PERMISSIVE FOR INSERT TO findneo_app
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_update ON pipeline_templates
  AS PERMISSIVE FOR UPDATE TO findneo_app
  USING      (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_delete ON pipeline_templates
  AS PERMISSIVE FOR DELETE TO findneo_app
  USING (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE pipeline_template_stages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pipeline_template_stages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_read_with_platform_defaults ON pipeline_template_stages
  AS PERMISSIVE FOR SELECT TO findneo_app
  USING (
    company_id = nullif(current_setting('app.current_company_id', true), '')::uuid
    OR company_id IS NULL
  );
--> statement-breakpoint
CREATE POLICY tenant_insert ON pipeline_template_stages
  AS PERMISSIVE FOR INSERT TO findneo_app
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_update ON pipeline_template_stages
  AS PERMISSIVE FOR UPDATE TO findneo_app
  USING      (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_delete ON pipeline_template_stages
  AS PERMISSIVE FOR DELETE TO findneo_app
  USING (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

-- jobs and its three children: the canonical policy, no platform rows.
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON jobs
  AS PERMISSIVE FOR ALL TO findneo_app
  USING      (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

-- The public surface's floor (06 §6).
--
-- The predicate lives in the POLICY, not in a query, so every current and
-- future public read path inherits it — the career site, a JSON feed, a
-- sitemap, an embeddable widget, job-board distribution. A developer adding a
-- public endpoint cannot forget the filter, because there is no filter to
-- write. This is what replaces the CHECK constraint that would otherwise
-- couple `confidential` and `publish_to_career_site`.
CREATE POLICY public_jobs_readable ON jobs
  AS PERMISSIVE FOR SELECT TO findneo_public
  USING (
    status = 'open'
    AND publish_to_career_site
    AND NOT confidential
    AND company_id = nullif(current_setting('app.public_company_id', true), '')::uuid
  );
--> statement-breakpoint

-- SELECT and nothing else. findneo_public's blast radius is bounded by grants
-- rather than by handler correctness (06 §2).
GRANT SELECT ON jobs TO findneo_public;
--> statement-breakpoint

ALTER TABLE job_skills ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE job_skills FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON job_skills
  AS PERMISSIVE FOR ALL TO findneo_app
  USING      (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE job_hiring_team ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE job_hiring_team FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON job_hiring_team
  AS PERMISSIVE FOR ALL TO findneo_app
  USING      (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE job_pipeline_stages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE job_pipeline_stages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON job_pipeline_stages
  AS PERMISSIVE FOR ALL TO findneo_app
  USING      (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
