-- 027 — Phase 3 platform defaults: rejection and hire reasons, plus the
-- compensation field-visibility rules (T-067, T-070).

-- ---------------------------------------------------------------------------
-- Decision reasons. `company_id IS NULL` = platform default, readable by every
-- tenant and writable by none. `hold` has no catalog by design (06b §2).
-- ---------------------------------------------------------------------------

INSERT INTO decision_reasons (company_id, decision_type, key, label, sequence_order) VALUES
  (NULL, 'reject', 'skills_mismatch',       'Skills do not match the requirement', 10),
  (NULL, 'reject', 'experience_insufficient','Insufficient relevant experience',    20),
  (NULL, 'reject', 'compensation_mismatch',  'Compensation expectations misaligned', 30),
  (NULL, 'reject', 'location_mismatch',      'Location or work-mode mismatch',       40),
  (NULL, 'reject', 'notice_period',          'Notice period too long',               50),
  (NULL, 'reject', 'failed_assessment',      'Did not clear the assessment',         60),
  (NULL, 'reject', 'failed_interview',       'Did not clear the interview',          70),
  (NULL, 'reject', 'communication',          'Communication did not meet the bar',   80),
  (NULL, 'reject', 'culture_fit',            'Not aligned with the role or team',    90),
  (NULL, 'reject', 'candidate_withdrew',     'Candidate withdrew',                  100),
  (NULL, 'reject', 'position_closed',        'Position closed or put on hold',      110),
  (NULL, 'reject', 'duplicate_application',  'Duplicate application',               120),
  (NULL, 'reject', 'other',                  'Other',                               999),
  (NULL, 'hire',   'strong_technical',       'Strong technical fit',                 10),
  (NULL, 'hire',   'strong_domain',          'Strong domain experience',             20),
  (NULL, 'hire',   'leadership',             'Leadership potential',                 30),
  (NULL, 'hire',   'culture_add',            'Adds to the team',                     40),
  (NULL, 'hire',   'best_available',         'Best of the available slate',          50),
  (NULL, 'hire',   'other',                  'Other',                               999)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- T-070 — compensation masking. Every column holding a money or notice-period
-- figure across candidates and applications, mapped to the permission that
-- earns it. No row means unmasked, so this list IS the control: a compensation
-- column added later without a row here is silently public.
--
-- `candidates.compensation.read` and `candidates.contact.read` are both in the
-- catalog seeded by 015.
-- ---------------------------------------------------------------------------

INSERT INTO field_visibility_rules (company_id, table_name, field_name, required_permission_id)
SELECT NULL, rule.table_name, rule.field_name, p.id
  FROM (VALUES
    ('candidates',   'current_ctc',                 'candidates.compensation.read'),
    ('applications', 'snapshot_current_ctc',        'candidates.compensation.read'),
    ('applications', 'snapshot_expected_ctc',       'candidates.compensation.read'),
    -- Notice period is in the same masked group in 06b §2. It is commercially
    -- sensitive in the same way and travels with the compensation fields.
    ('applications', 'snapshot_notice_period_days', 'candidates.compensation.read'),
    -- Contact details are a separate permission, so a coordinator who may
    -- schedule can hold contact without holding compensation.
    ('candidates',   'email',                       'candidates.contact.read'),
    ('candidates',   'phone',                       'candidates.contact.read'),
    ('applications', 'snapshot_email',              'candidates.contact.read'),
    ('applications', 'snapshot_phone',              'candidates.contact.read')
  ) AS rule(table_name, field_name, permission_key)
  JOIN permissions p ON p.key = rule.permission_key
ON CONFLICT DO NOTHING;
