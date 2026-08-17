-- 024 — candidates, the talent pool, resumes and parsed resume data (06b §1).
--
-- The delivery plan calls these "migrations 016–017". Those numbers were
-- consumed by Phase 1 and Phase 2; the content is what the plan specifies,
-- the ordinal is simply the next free one.

CREATE TABLE candidates (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id             uuid        NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  full_name              text        NOT NULL,
  email                  citext,
  phone                  text,
  current_title          text,
  current_employer       text,
  total_experience_years numeric(4, 1),
  -- Masked. field_visibility_rules maps this to candidates.compensation.read.
  current_ctc            numeric(14, 2),
  ctc_currency           char(3),
  education_level        text,
  location_city          text,
  location_country       char(2),
  linkedin_url           text,
  source                 text        NOT NULL DEFAULT 'internal_add',
  source_user_id         uuid REFERENCES users (id) ON DELETE SET NULL,
  -- Set after the first resume exists, so it cannot be an inline FK here: the
  -- resume references the candidate. Wired below, after candidate_resumes.
  current_resume_id      uuid,
  -- Compliance seams (D-027). Present from the start so adding consent later
  -- is a behaviour change and not a migration against a populated table.
  consent_status         text        NOT NULL DEFAULT 'not_required',
  consent_captured_at    timestamptz,
  lawful_basis           text,
  retention_until        timestamptz,
  anonymized_at          timestamptz,
  created_by             uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_candidates_source CHECK (source IN
    ('self_apply','internal_add','agency','pool_import','referral')),
  CONSTRAINT ck_candidates_consent CHECK (consent_status IN
    ('not_required','pending','granted','withdrawn')),
  CONSTRAINT ck_candidates_experience CHECK (
    total_experience_years IS NULL OR total_experience_years >= 0),
  -- Composite FK target for every table that hangs off a candidate, so none
  -- of them can attach to another tenant's row.
  CONSTRAINT ux_candidates_id_company UNIQUE (id, company_id)
);
--> statement-breakpoint

-- Anonymized rows are excluded deliberately (06b §1). After erasure the email
-- is scrubbed; without the exclusion two erased candidates would collide, and
-- a genuinely different person reapplying could be blocked by a ghost row.
CREATE UNIQUE INDEX ux_candidates_company_email ON candidates (company_id, email)
  WHERE email IS NOT NULL AND anonymized_at IS NULL;
--> statement-breakpoint
CREATE INDEX ix_candidates_company_created ON candidates (company_id, created_at DESC);
--> statement-breakpoint
-- Fuzzy duplicate detection (BR-061). Requires pg_trgm, installed in 001.
CREATE INDEX ix_candidates_name_trgm ON candidates USING gin (full_name gin_trgm_ops);
--> statement-breakpoint

CREATE TRIGGER trg_candidates_touch
  BEFORE UPDATE ON candidates FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Talent pool. Membership and provenance only (D-010) — zero profile fields.
-- ---------------------------------------------------------------------------

CREATE TABLE talent_pool_entries (
  -- NOTE: `owner_company_id`, not `company_id`. The one naming deviation in
  -- the schema (06b §1): a pool is *owned*, not merely scoped, and renaming
  -- this would obscure that. The RLS policy is otherwise identical, and the
  -- isolation test names this table explicitly so the deviation cannot be
  -- quietly forgotten.
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  owner_company_id uuid        NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  candidate_id     uuid        NOT NULL,
  status           text        NOT NULL DEFAULT 'active',
  source           text,
  notes            text,
  tags             text[]      NOT NULL DEFAULT '{}',
  added_by         uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_pool_status CHECK (status IN ('active','archived','placed')),
  CONSTRAINT uq_pool_owner_candidate UNIQUE (owner_company_id, candidate_id),
  CONSTRAINT fk_pool_candidate
    FOREIGN KEY (candidate_id, owner_company_id) REFERENCES candidates (id, company_id)
    ON DELETE CASCADE
);
--> statement-breakpoint

CREATE INDEX ix_pool_owner_status
  ON talent_pool_entries (owner_company_id, status, created_at DESC);
--> statement-breakpoint
CREATE INDEX ix_pool_tags ON talent_pool_entries USING gin (tags);
--> statement-breakpoint

CREATE TRIGGER trg_pool_touch
  BEFORE UPDATE ON talent_pool_entries FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Resumes. One table serves both roles (D-011): profile-level current, and
-- the frozen per-application copy.
-- ---------------------------------------------------------------------------

CREATE TABLE candidate_resumes (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id        uuid        NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  candidate_id      uuid        NOT NULL,
  -- NULL = the profile-level resume. Non-NULL = the copy frozen for that
  -- application. The FK is added in 025, after `applications` exists.
  application_id    uuid,
  -- Adapter-relative and server-generated. Never a URL, never derived from
  -- the client's filename (SEC-043).
  storage_key       text        NOT NULL,
  original_filename text        NOT NULL,
  -- From magic bytes, not from the client's Content-Type (T-064).
  content_type      text        NOT NULL,
  size_bytes        integer     NOT NULL,
  checksum_sha256   text        NOT NULL,
  uploaded_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  is_current        boolean     NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),

  -- 10 MiB. The route rejects earlier and with a better message; this is the
  -- backstop for anything that reaches the table by another path.
  CONSTRAINT ck_resume_size CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  CONSTRAINT ux_resumes_id_company UNIQUE (id, company_id),
  CONSTRAINT fk_resumes_candidate
    FOREIGN KEY (candidate_id, company_id) REFERENCES candidates (id, company_id)
    ON DELETE CASCADE
);
--> statement-breakpoint

-- Exactly one current resume at profile level...
CREATE UNIQUE INDEX ux_resume_current_profile ON candidate_resumes (candidate_id)
  WHERE application_id IS NULL AND is_current;
--> statement-breakpoint
-- ...and exactly one frozen copy per application.
CREATE UNIQUE INDEX ux_resume_per_application ON candidate_resumes (application_id)
  WHERE application_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX ix_resumes_candidate ON candidate_resumes (company_id, candidate_id, created_at DESC);
--> statement-breakpoint

ALTER TABLE candidates
  ADD CONSTRAINT fk_candidates_current_resume
  FOREIGN KEY (current_resume_id) REFERENCES candidate_resumes (id) ON DELETE SET NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Parsed resume data. AI seam (D-029), written by the parser and never edited.
-- ---------------------------------------------------------------------------

CREATE TABLE parsed_resume_data (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid        NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  -- Keyed to the RESUME, not the candidate (D-029). Because each application
  -- freezes its own resume row, parsed data is pinned per application for
  -- free: a profile update makes a new resume and a new parse, and a past
  -- ranking still refers to exactly what it scored.
  resume_id      uuid        NOT NULL,
  raw_text       text,
  structured     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  parser_name    text        NOT NULL,
  parser_version text        NOT NULL,
  parsed_at      timestamptz NOT NULL DEFAULT now(),
  status         text        NOT NULL DEFAULT 'pending',
  error_reason   text,

  CONSTRAINT ck_parsed_status CHECK (status IN ('pending','succeeded','failed')),
  CONSTRAINT uq_parsed_resume UNIQUE (resume_id),
  CONSTRAINT fk_parsed_resume
    FOREIGN KEY (resume_id, company_id) REFERENCES candidate_resumes (id, company_id)
    ON DELETE CASCADE
);
--> statement-breakpoint

CREATE INDEX ix_parsed_structured ON parsed_resume_data USING gin (structured);
--> statement-breakpoint

-- The serving role gets DML but never DDL (05a §5). SELECT and INSERT come
-- from the schema-wide grant in 001; these are the two it does not.
GRANT UPDATE, DELETE ON candidates TO findneo_app;
--> statement-breakpoint
GRANT UPDATE, DELETE ON talent_pool_entries TO findneo_app;
--> statement-breakpoint
GRANT UPDATE, DELETE ON candidate_resumes TO findneo_app;
--> statement-breakpoint
GRANT UPDATE, DELETE ON parsed_resume_data TO findneo_app;
