-- 015 — seed: permission catalog, platform-default roles, role grants,
-- default settings, default field-visibility rules.
--
-- **This migration runs as `findneo_migrator` against tables that migration
-- 013 just put under FORCE ROW LEVEL SECURITY.** Under FORCE the owner is
-- subject to policies too, and no policy names the migrator — so every insert
-- below would be denied on tables the migrator itself owns. `BYPASSRLS`,
-- granted in migration 001, is what makes this work (D-047b, 06 §2).
--
-- That is not a weakening: the migrator owns these tables and could
-- `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY` at will. Withholding BYPASSRLS
-- would grant nothing it cannot grant itself, and would cost a per-table
-- migrator policy that someone eventually forgets to write. The control that
-- matters is that migrator credentials never reach a serving process.
--
-- Everything seeded here has `company_id IS NULL` — it is platform reference
-- data that every tenant reads and none can modify. Migration 013's split
-- read/write policies on `roles`, `settings` and `field_visibility_rules` are
-- what enforce the second half of that.

-- ---------------------------------------------------------------------------
-- Permission catalog (04 §2). Fixed and platform-wide: companies compose these
-- into roles, they cannot invent permission types.
-- ---------------------------------------------------------------------------

INSERT INTO permissions (key, category, description) VALUES
  ('company.read',                 'company',     'View company profile'),
  ('company.update',               'company',     'Edit company profile'),
  ('company.settings.manage',      'company',     'Change settings including the application cap'),
  ('company.billing.manage',       'company',     'Billing — Phase 2, reserved'),

  ('users.read',                   'users',       'List and view users'),
  ('users.invite',                 'users',       'Send invitations'),
  ('users.update',                 'users',       'Edit user profiles'),
  ('users.deactivate',             'users',       'Deactivate a user'),
  ('users.impersonate',            'users',       'Platform staff only, audited'),

  ('roles.read',                   'roles',       'View roles and their permissions'),
  ('roles.create',                 'roles',       'Create custom roles'),
  ('roles.update',                 'roles',       'Edit custom roles'),
  ('roles.delete',                 'roles',       'Delete custom roles'),
  ('roles.assign',                 'roles',       'Grant and revoke role assignments'),

  ('departments.read',             'departments', 'View departments'),
  ('departments.create',           'departments', 'Create departments'),
  ('departments.update',           'departments', 'Edit departments'),
  ('departments.delete',           'departments', 'Delete departments'),
  ('departments.members.manage',   'departments', 'Add and remove members'),

  ('jobs.read',                    'jobs',        'View jobs in scope'),
  ('jobs.read.all',                'jobs',        'View every job company-wide'),
  ('jobs.confidential.read',       'jobs',        'View confidential jobs outside the hiring team'),
  ('jobs.create',                  'jobs',        'Create jobs'),
  ('jobs.update',                  'jobs',        'Edit jobs'),
  ('jobs.delete',                  'jobs',        'Delete jobs'),
  ('jobs.publish',                 'jobs',        'Publish a job'),
  ('jobs.close',                   'jobs',        'Close a job'),
  ('jobs.salary.read',             'jobs',        'See compensation on jobs'),
  ('jobs.team.read',               'jobs',        'View the hiring team'),
  ('jobs.team.manage',             'jobs',        'Manage the hiring team'),

  ('pipeline.read',                'pipeline',    'View per-job stages'),
  ('pipeline.configure',           'pipeline',    'Configure per-job stages'),
  ('pipeline.templates.manage',    'pipeline',    'Manage company-wide pipeline templates'),
  ('forms.read',                   'forms',       'View smart form templates'),
  ('forms.configure',              'forms',       'Configure smart form templates'),

  ('candidates.read',              'candidates',  'View candidate profiles'),
  ('candidates.create',            'candidates',  'Create candidate profiles'),
  ('candidates.update',            'candidates',  'Edit candidate profiles'),
  ('candidates.compensation.read', 'candidates',  'Current and expected compensation'),
  ('candidates.contact.read',      'candidates',  'Email and phone'),
  ('applications.read',            'applications','View applications'),
  ('applications.create',          'applications','Create applications'),
  ('applications.advance',         'applications','Advance an application'),
  ('applications.reject',          'applications','Reject an application'),
  ('applications.transfer',        'applications','Transfer an application'),
  -- Separate from advance because it is the trigger for commission
  -- attribution — a financial event.
  ('applications.hire',            'applications','Hire an applicant'),
  ('applications.resume.download', 'applications','Download resume files'),
  ('talent_pool.read',             'candidates',  'View talent pool entries'),
  ('talent_pool.manage',           'candidates',  'Manage talent pool entries'),

  ('interviews.read',              'interviews',  'View interviews'),
  ('interviews.schedule',          'interviews',  'Schedule interviews'),
  ('interviews.reschedule',        'interviews',  'Reschedule interviews'),
  ('interviews.cancel',            'interviews',  'Cancel interviews'),
  ('interviews.panel.manage',      'interviews',  'Manage panelists'),
  ('scorecards.read.own',          'scorecards',  'Own submitted feedback'),
  ('scorecards.read.all',          'scorecards',  'All feedback on an application'),
  ('scorecards.submit',            'scorecards',  'Submit feedback'),
  ('scorecards.configure',         'scorecards',  'Attributes and templates'),

  ('agencies.read',                'agencies',    'View engagements'),
  ('agencies.invite',              'agencies',    'Invite agencies'),
  ('agencies.manage',              'agencies',    'Manage engagements'),
  ('agencies.assign_job',          'agencies',    'Assign a job to an agency'),
  ('agency_portal.access',         'agencies',    'Use the agency portal at all'),
  ('agency.submissions.create',    'agencies',    'Submit a candidate'),
  ('commission.read',              'agencies',    'View attribution records'),
  ('commission.manage',            'agencies',    'Manage attribution records'),

  ('audit.read',                   'governance',  'Audit log'),
  ('activity.read',                'governance',  'Activity feed'),
  ('data_governance.manage',       'governance',  'Field visibility rules'),
  ('gdpr.erasure.execute',         'governance',  'Anonymization'),
  ('reports.read',                 'governance',  'Reporting'),
  ('reports.export',               'governance',  'Export reports'),

  ('platform.companies.read',      'platform',    'Tenant administration — read'),
  ('platform.companies.manage',    'platform',    'Tenant administration — manage'),
  ('platform.support.impersonate', 'platform',    'Time-boxed, audited tenant access'),
  ('platform.system.read',         'platform',    'Health and metrics')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Platform-default roles (04 §3, 06 §9). company_id IS NULL, is_editable false.
-- A company clones one to create a custom role; it can never edit the original.
-- ---------------------------------------------------------------------------

INSERT INTO roles (company_id, key, name, scope, is_editable) VALUES
  (NULL, 'system_admin',     'System Admin',     'platform',   false),
  (NULL, 'super_admin',      'Super Admin',      'company',    false),
  (NULL, 'org_admin_hr',     'HR Admin',         'company',    false),
  (NULL, 'hiring_manager',   'Hiring Manager',   'department', false),
  (NULL, 'recruiter',        'Recruiter',        'company',    false),
  (NULL, 'coordinator',      'Coordinator',      'company',    false),
  (NULL, 'interviewer',      'Interviewer',      'job',        false),
  (NULL, 'agency_recruiter', 'Agency Recruiter', 'company',    false)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Role grants, transcribed from the matrix in 04 §3.
--
-- The matrix distinguishes `●` full from `◐` scoped, but that distinction is
-- NOT expressed here: a scoped permission is still held, and the scoping is a
-- row-level concern evaluated in the query (04 §4). Encoding scope in the
-- grant table would put the same rule in two places, and they would diverge.
--
-- `system_admin` deliberately holds no tenant permission at all. Tenant access
-- requires `platform.support.impersonate`, which is time-boxed, needs a stated
-- reason, and is audited to the tenant's Super Admin (BR-006).
--
-- `super_admin` is NOT simply every key: the matrix gives it `○` for agency
-- portal access, because the portal is a different surface and not something
-- the hiring org's owner steps into.
-- ---------------------------------------------------------------------------

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM (VALUES
    -- Company
    ('super_admin','company.read'),('org_admin_hr','company.read'),
    ('hiring_manager','company.read'),('recruiter','company.read'),
    ('coordinator','company.read'),('interviewer','company.read'),
    ('super_admin','company.update'),
    ('super_admin','company.settings.manage'),('org_admin_hr','company.settings.manage'),

    -- Users
    ('super_admin','users.read'),('org_admin_hr','users.read'),
    ('hiring_manager','users.read'),('recruiter','users.read'),('coordinator','users.read'),
    ('super_admin','users.invite'),('org_admin_hr','users.invite'),
    ('super_admin','users.update'),('org_admin_hr','users.update'),
    ('super_admin','users.deactivate'),('org_admin_hr','users.deactivate'),

    -- Roles
    ('super_admin','roles.read'),('org_admin_hr','roles.read'),
    ('super_admin','roles.create'),('org_admin_hr','roles.create'),
    ('super_admin','roles.update'),('org_admin_hr','roles.update'),
    ('super_admin','roles.delete'),('org_admin_hr','roles.delete'),
    ('super_admin','roles.assign'),('org_admin_hr','roles.assign'),

    -- Departments
    ('super_admin','departments.read'),('org_admin_hr','departments.read'),
    ('super_admin','departments.create'),('org_admin_hr','departments.create'),
    ('super_admin','departments.update'),('org_admin_hr','departments.update'),
    ('super_admin','departments.delete'),('org_admin_hr','departments.delete'),
    ('super_admin','departments.members.manage'),('org_admin_hr','departments.members.manage'),

    -- Jobs
    ('super_admin','jobs.read'),('org_admin_hr','jobs.read'),('hiring_manager','jobs.read'),
    ('recruiter','jobs.read'),('coordinator','jobs.read'),('interviewer','jobs.read'),
    ('agency_recruiter','jobs.read'),
    ('super_admin','jobs.read.all'),('org_admin_hr','jobs.read.all'),
    ('super_admin','jobs.confidential.read'),('org_admin_hr','jobs.confidential.read'),
    ('hiring_manager','jobs.confidential.read'),
    ('super_admin','jobs.create'),('org_admin_hr','jobs.create'),('hiring_manager','jobs.create'),
    ('super_admin','jobs.update'),('org_admin_hr','jobs.update'),('hiring_manager','jobs.update'),
    ('super_admin','jobs.delete'),('org_admin_hr','jobs.delete'),('hiring_manager','jobs.delete'),
    ('super_admin','jobs.publish'),('org_admin_hr','jobs.publish'),('hiring_manager','jobs.publish'),
    ('super_admin','jobs.close'),('org_admin_hr','jobs.close'),('hiring_manager','jobs.close'),
    ('super_admin','jobs.salary.read'),('org_admin_hr','jobs.salary.read'),
    ('hiring_manager','jobs.salary.read'),('recruiter','jobs.salary.read'),
    ('super_admin','jobs.team.read'),('org_admin_hr','jobs.team.read'),('hiring_manager','jobs.team.read'),
    ('super_admin','jobs.team.manage'),('org_admin_hr','jobs.team.manage'),('hiring_manager','jobs.team.manage'),

    -- Pipeline and forms
    ('super_admin','pipeline.read'),('org_admin_hr','pipeline.read'),('hiring_manager','pipeline.read'),
    ('super_admin','pipeline.configure'),('org_admin_hr','pipeline.configure'),
    ('hiring_manager','pipeline.configure'),
    ('super_admin','pipeline.templates.manage'),('org_admin_hr','pipeline.templates.manage'),
    ('hiring_manager','pipeline.templates.manage'),
    ('super_admin','forms.read'),('org_admin_hr','forms.read'),
    ('super_admin','forms.configure'),('org_admin_hr','forms.configure'),

    -- Candidates
    ('super_admin','candidates.read'),('org_admin_hr','candidates.read'),
    ('hiring_manager','candidates.read'),('recruiter','candidates.read'),
    ('coordinator','candidates.read'),('interviewer','candidates.read'),
    ('agency_recruiter','candidates.read'),
    ('super_admin','candidates.create'),('org_admin_hr','candidates.create'),
    ('hiring_manager','candidates.create'),('recruiter','candidates.create'),
    ('coordinator','candidates.create'),('interviewer','candidates.create'),
    ('agency_recruiter','candidates.create'),
    ('super_admin','candidates.update'),('org_admin_hr','candidates.update'),
    ('hiring_manager','candidates.update'),('recruiter','candidates.update'),
    ('coordinator','candidates.update'),('interviewer','candidates.update'),
    ('agency_recruiter','candidates.update'),
    ('super_admin','candidates.contact.read'),('org_admin_hr','candidates.contact.read'),
    ('hiring_manager','candidates.contact.read'),('recruiter','candidates.contact.read'),
    ('coordinator','candidates.contact.read'),('agency_recruiter','candidates.contact.read'),
    -- Coordinator sees no compensation and no scorecard scores: they schedule
    -- and coordinate, and hold no evaluative role.
    ('super_admin','candidates.compensation.read'),('org_admin_hr','candidates.compensation.read'),
    ('hiring_manager','candidates.compensation.read'),('recruiter','candidates.compensation.read'),

    -- Applications
    ('super_admin','applications.read'),('org_admin_hr','applications.read'),
    ('hiring_manager','applications.read'),('recruiter','applications.read'),
    ('coordinator','applications.read'),('interviewer','applications.read'),
    ('agency_recruiter','applications.read'),
    ('super_admin','applications.create'),('org_admin_hr','applications.create'),
    ('hiring_manager','applications.create'),('recruiter','applications.create'),
    ('coordinator','applications.create'),('interviewer','applications.create'),
    ('agency_recruiter','applications.create'),
    ('super_admin','applications.advance'),('org_admin_hr','applications.advance'),
    ('hiring_manager','applications.advance'),('recruiter','applications.advance'),
    ('super_admin','applications.reject'),('org_admin_hr','applications.reject'),
    ('hiring_manager','applications.reject'),('recruiter','applications.reject'),
    ('super_admin','applications.transfer'),('org_admin_hr','applications.transfer'),
    ('hiring_manager','applications.transfer'),('recruiter','applications.transfer'),
    ('super_admin','applications.hire'),('org_admin_hr','applications.hire'),
    ('hiring_manager','applications.hire'),
    ('super_admin','applications.resume.download'),('org_admin_hr','applications.resume.download'),
    ('hiring_manager','applications.resume.download'),('recruiter','applications.resume.download'),
    ('coordinator','applications.resume.download'),('interviewer','applications.resume.download'),
    ('agency_recruiter','applications.resume.download'),

    -- Interviews
    ('super_admin','interviews.read'),('org_admin_hr','interviews.read'),
    ('hiring_manager','interviews.read'),('recruiter','interviews.read'),('coordinator','interviews.read'),
    ('super_admin','interviews.schedule'),('org_admin_hr','interviews.schedule'),
    ('hiring_manager','interviews.schedule'),('recruiter','interviews.schedule'),
    ('coordinator','interviews.schedule'),
    ('super_admin','interviews.reschedule'),('org_admin_hr','interviews.reschedule'),
    ('hiring_manager','interviews.reschedule'),('recruiter','interviews.reschedule'),
    ('coordinator','interviews.reschedule'),
    ('super_admin','interviews.cancel'),('org_admin_hr','interviews.cancel'),
    ('hiring_manager','interviews.cancel'),('recruiter','interviews.cancel'),
    ('coordinator','interviews.cancel'),
    ('super_admin','interviews.panel.manage'),('org_admin_hr','interviews.panel.manage'),
    ('hiring_manager','interviews.panel.manage'),('recruiter','interviews.panel.manage'),
    ('coordinator','interviews.panel.manage'),

    -- Scorecards. The interviewer holds read.own and never read.all —
    -- BR-082's anchoring-bias protection.
    ('super_admin','scorecards.submit'),('org_admin_hr','scorecards.submit'),
    ('hiring_manager','scorecards.submit'),('recruiter','scorecards.submit'),
    ('interviewer','scorecards.submit'),
    ('super_admin','scorecards.read.own'),('org_admin_hr','scorecards.read.own'),
    ('hiring_manager','scorecards.read.own'),('recruiter','scorecards.read.own'),
    ('interviewer','scorecards.read.own'),
    ('super_admin','scorecards.read.all'),('org_admin_hr','scorecards.read.all'),
    ('hiring_manager','scorecards.read.all'),('recruiter','scorecards.read.all'),

    -- Agencies
    ('super_admin','agencies.read'),('org_admin_hr','agencies.read'),('recruiter','agencies.read'),
    ('super_admin','agencies.invite'),('org_admin_hr','agencies.invite'),('recruiter','agencies.invite'),
    ('super_admin','agencies.manage'),('org_admin_hr','agencies.manage'),('recruiter','agencies.manage'),
    ('super_admin','agencies.assign_job'),('org_admin_hr','agencies.assign_job'),
    ('recruiter','agencies.assign_job'),
    ('agency_recruiter','agency_portal.access'),
    ('agency_recruiter','agency.submissions.create'),
    -- Scoped to its own attributions only (BR-007).
    ('super_admin','commission.read'),('org_admin_hr','commission.read'),
    ('agency_recruiter','commission.read'),

    -- Governance
    ('super_admin','audit.read'),('org_admin_hr','audit.read'),
    ('super_admin','activity.read'),('org_admin_hr','activity.read'),
    ('super_admin','gdpr.erasure.execute'),('org_admin_hr','gdpr.erasure.execute'),

    -- Platform
    ('system_admin','platform.companies.read'),
    ('system_admin','platform.companies.manage'),
    ('system_admin','platform.support.impersonate'),
    ('system_admin','platform.system.read')
  ) AS grant_pair(role_key, permission_key)
  JOIN roles r ON r.key = grant_pair.role_key AND r.company_id IS NULL
  JOIN permissions p ON p.key = grant_pair.permission_key
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Default settings (06 §7). company_id IS NULL = the platform default a tenant
-- inherits until it overrides the key.
-- ---------------------------------------------------------------------------

INSERT INTO settings (company_id, key, value) VALUES
  (NULL, 'candidate.multi_role_mode',              '"restrict"'::jsonb),
  (NULL, 'candidate.max_active_applications',      '1'::jsonb),
  (NULL, 'agency.default_cool_off_months',         '6'::jsonb),
  (NULL, 'security.session_idle_timeout_minutes',  '480'::jsonb)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Default field-visibility rules (06 §9). No row means unmasked, so only the
-- fields that must be earned appear here.
-- ---------------------------------------------------------------------------

INSERT INTO field_visibility_rules (company_id, table_name, field_name, required_permission_id)
SELECT NULL, rule.table_name, rule.field_name, p.id
  FROM (VALUES
    ('jobs', 'salary_min', 'jobs.salary.read'),
    ('jobs', 'salary_max', 'jobs.salary.read')
  ) AS rule(table_name, field_name, permission_key)
  JOIN permissions p ON p.key = rule.permission_key
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- NOT SEEDED HERE, and not an oversight:
--
--   * the default pipeline template (Applied → Screening → Interview → Offer
--     → Hired, plus terminal Rejected), and
--   * the two generic form templates (one `job`, one `application`)
--
-- Both are listed in 06 §9, and both need tables created by migrations 010 and
-- 011, which are outside this slice. Seeding them requires those migrations
-- first; inserting into tables that do not exist is not a thing this file can
-- defer around. They land with 010/011.
-- ---------------------------------------------------------------------------

SELECT 1;
