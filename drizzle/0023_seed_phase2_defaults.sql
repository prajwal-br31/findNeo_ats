-- 023 — T-043. Platform-default job and application form templates, the
-- default pipeline template, and a starter skills catalog.
--
-- The two form templates and the pipeline template were listed in 06 §9 but
-- deferred out of migration 015, because their tables did not exist until
-- 010 and 011. This is that deferral being paid.
--
-- Runs as findneo_migrator against tables now under FORCE ROW LEVEL SECURITY,
-- so it depends on BYPASSRLS exactly as 015 does (D-047b).

-- A company that never configures anything uses these permanently.
INSERT INTO form_templates (company_id, entity_type, name)
VALUES (NULL, 'job', 'Default job form'),
       (NULL, 'application', 'Default application form')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO form_template_versions (template_id, company_id, version_no, status, published_at)
SELECT t.id, NULL, 1, 'published', now()
  FROM form_templates t
 WHERE t.company_id IS NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Deliberately small. A default form that asks for everything is one every
-- customer has to edit before use, which defeats having a default at all.
INSERT INTO form_template_fields
  (version_id, company_id, key, label, data_type, is_required, max_length, sequence_order)
SELECT v.id, NULL, f.key, f.label, f.data_type, f.is_required, f.max_length, f.sequence_order
  FROM form_template_versions v
  JOIN form_templates t ON t.id = v.template_id AND t.company_id IS NULL AND t.entity_type = 'job'
  CROSS JOIN (VALUES
    ('internal_notes', 'Internal notes', 'long_text', false, 2000, 1::smallint),
    ('requisition_ref', 'Requisition reference', 'text', false, 120, 2::smallint)
  ) AS f(key, label, data_type, is_required, max_length, sequence_order)
 WHERE v.company_id IS NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO form_template_fields
  (version_id, company_id, key, label, data_type, is_required, max_length, sequence_order)
SELECT v.id, NULL, f.key, f.label, f.data_type, f.is_required, f.max_length, f.sequence_order
  FROM form_template_versions v
  JOIN form_templates t
    ON t.id = v.template_id AND t.company_id IS NULL AND t.entity_type = 'application'
  CROSS JOIN (VALUES
    ('cover_note', 'Cover note', 'long_text', false, 2000, 1::smallint),
    ('notice_period', 'Notice period', 'text', false, 120, 2::smallint)
  ) AS f(key, label, data_type, is_required, max_length, sequence_order)
 WHERE v.company_id IS NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Applied -> Screening -> Interview -> Offer -> Hired, plus terminal Rejected
-- (06 §9). Copied into every job at creation and independent thereafter.
INSERT INTO pipeline_templates (company_id, name)
VALUES (NULL, 'Default hiring pipeline')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO pipeline_template_stages
  (template_id, company_id, name, sequence_order, stage_type, is_terminal)
SELECT t.id, NULL, s.name, s.sequence_order, s.stage_type, s.is_terminal
  FROM pipeline_templates t
  CROSS JOIN (VALUES
    ('Applied',    1::smallint, 'applied',   false),
    ('Screening',  2::smallint, 'screening', false),
    ('Interview',  3::smallint, 'interview', false),
    ('Offer',      4::smallint, 'offer',     false),
    ('Hired',      5::smallint, 'hired',     true),
    ('Rejected',   6::smallint, 'rejected',  true)
  ) AS s(name, sequence_order, stage_type, is_terminal)
 WHERE t.company_id IS NULL AND t.name = 'Default hiring pipeline'
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- A starter catalog so the ranker has something to match against on day one.
-- Unknown skills are auto-created in the company's own scope on first use, so
-- this list only has to be useful, not complete.
INSERT INTO skills (company_id, name, slug) VALUES
  (NULL, 'JavaScript', 'javascript'),
  (NULL, 'TypeScript', 'typescript'),
  (NULL, 'Python', 'python'),
  (NULL, 'Java', 'java'),
  (NULL, 'Go', 'go'),
  (NULL, 'SQL', 'sql'),
  (NULL, 'PostgreSQL', 'postgresql'),
  (NULL, 'React', 'react'),
  (NULL, 'Node.js', 'nodejs'),
  (NULL, 'AWS', 'aws'),
  (NULL, 'Docker', 'docker'),
  (NULL, 'Kubernetes', 'kubernetes'),
  (NULL, 'Product Management', 'product-management'),
  (NULL, 'Recruiting', 'recruiting'),
  (NULL, 'Communication', 'communication')
ON CONFLICT DO NOTHING;
