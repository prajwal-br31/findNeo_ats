# FindNeo — Data Model: Hiring Modules

Continues `06-data-model.md`. Same conventions, same RLS pattern, same canonical policy on every table unless stated.

**Covers:** Candidates & Talent Pool · Applications & Decisions · Interviews & Scheduling · Scorecards · Agencies & Commission · Messaging & Notifications · Compliance seams · AI seams.

Every table here carries `company_id`, RLS enabled and forced, and a composite `(id, company_id)` unique index where it is an FK target.

---

## 1. Candidates & talent pool

### `candidates`

The current, mutable profile (D-009). Distinct from the per-application snapshot, which never changes.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `company_id` | uuid | not null. **An agency's pool people are candidates owned by the agency** |
| `full_name` | text | not null |
| `email` | citext | |
| `phone` | text | |
| `current_title` | text | |
| `current_employer` | text | |
| `total_experience_years` | numeric(4,1) | |
| `current_ctc` | numeric(14,2) | **masked** |
| `ctc_currency` | char(3) | |
| `education_level` | text | |
| `location_city` / `location_country` | text / char(2) | |
| `linkedin_url` | text | |
| `source` | text | `self_apply` / `internal_add` / `agency` / `pool_import` / `referral` |
| `source_user_id` | uuid | FK → `users.id`, nullable |
| `current_resume_id` | uuid | nullable FK → `candidate_resumes.id` |
| `consent_status` | text | not null default `'not_required'` — compliance seam (D-027) |
| `consent_captured_at` | timestamptz | |
| `lawful_basis` | text | nullable — EU seam, unused in v1 |
| `retention_until` | timestamptz | nullable — retention clock seam |
| `anonymized_at` | timestamptz | D-034 |
| `created_by` | uuid | FK → `users.id` |
| `created_at` / `updated_at` | timestamptz | |

```sql
CONSTRAINT ux_candidates_id_company UNIQUE (id, company_id)
CREATE UNIQUE INDEX ux_candidates_company_email ON candidates (company_id, email)
  WHERE email IS NOT NULL AND anonymized_at IS NULL;
CREATE INDEX ix_candidates_company_created ON candidates (company_id, created_at DESC);
CREATE INDEX ix_candidates_name_trgm ON candidates USING gin (full_name gin_trgm_ops);
```

**Requires the `pg_trgm` extension** — add to migration 001. Fuzzy name matching for duplicate detection (BR-061) is unusable without it.

**The email unique index excludes anonymized rows** deliberately. After erasure the email is scrubbed; without the exclusion, two anonymized candidates would collide on NULL — and worse, a re-application by a genuinely different person could be blocked by a ghost row.

**Duplicate detection is advisory** (BR-061). A match links to the existing candidate; it never merges automatically. Automatic merge of two people who share a name is a data-integrity incident that cannot be undone.

### `talent_pool_entries`

Membership and provenance only (D-010). Replaces `org_candidate_pool` and `agency_candidate_pool`.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `owner_company_id` | uuid | not null — **the tenant column for RLS on this table** |
| `candidate_id` | uuid | not null |
| `status` | text | not null default `'active'` — `active` / `archived` / `placed` |
| `source` | text | |
| `notes` | text | |
| `tags` | text[] | |
| `added_by` | uuid | FK → `users.id` |
| `created_at` / `updated_at` | timestamptz | |

```sql
UNIQUE (owner_company_id, candidate_id)
FOREIGN KEY (candidate_id, owner_company_id) REFERENCES candidates (id, company_id) ON DELETE CASCADE
CREATE INDEX ix_pool_owner_status ON talent_pool_entries (owner_company_id, status, created_at DESC);
CREATE INDEX ix_pool_tags ON talent_pool_entries USING gin (tags);
```

**RLS uses `owner_company_id`**, not `company_id`. This is the one naming deviation in the schema; it exists because "owner" is the semantically correct word here and renaming it to `company_id` would obscure that the pool is owned rather than merely scoped. The policy is otherwise identical, and the isolation test in §10 covers it explicitly so the deviation cannot be forgotten.

Zero profile fields. An org cannot see an agency's pool — ordinary tenant RLS, no special-case logic.

### `candidate_resumes`

Serves both roles in one table (D-011).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `company_id` | uuid | not null |
| `candidate_id` | uuid | not null |
| `application_id` | uuid | **nullable** — NULL = profile-level current resume |
| `storage_key` | text | not null — adapter-relative, never a URL |
| `original_filename` | text | not null — display only, **never used in a storage key** |
| `content_type` | text | not null — from magic bytes, not the client |
| `size_bytes` | integer | not null |
| `checksum_sha256` | text | not null |
| `uploaded_by` | uuid | FK → `users.id`, nullable for career-site uploads |
| `is_current` | boolean | not null default false — profile-level only |
| `created_at` | timestamptz | |

```sql
FOREIGN KEY (candidate_id, company_id) REFERENCES candidates (id, company_id) ON DELETE CASCADE
CREATE UNIQUE INDEX ux_resume_current_profile ON candidate_resumes (candidate_id)
  WHERE application_id IS NULL AND is_current;
CREATE UNIQUE INDEX ux_resume_per_application ON candidate_resumes (application_id)
  WHERE application_id IS NOT NULL;
CONSTRAINT ck_resume_size CHECK (size_bytes > 0 AND size_bytes <= 10485760)
```

One current profile resume, exactly one frozen resume per application. At submission the **file is copied to a new storage key** and a new row written — the profile resume can then change freely without altering what a hiring team evaluated.

The copy runs in the worker (`resume.copy_for_application`), not inline. `checksum_sha256` lets the copy job verify itself and makes deduplication possible later.

### `parsed_resume_data`

AI seam (D-029). Populated by the parser; never hand-edited.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `company_id` | uuid | not null |
| `resume_id` | uuid | not null, unique — **pinned to the resume, not the candidate** |
| `raw_text` | text | |
| `structured` | jsonb | not null default `'{}'` |
| `parser_name` | text | not null — provenance (BR-112) |
| `parser_version` | text | not null |
| `parsed_at` | timestamptz | not null |
| `status` | text | not null — `pending` / `succeeded` / `failed` |
| `error_reason` | text | |

```sql
UNIQUE (resume_id)
CREATE INDEX ix_parsed_structured ON parsed_resume_data USING gin (structured);
```

**Keyed to `resume_id`, resolving the staleness risk flagged in D-029.** Because each application freezes its own resume row, parsed data is automatically pinned per application. A profile resume update produces a new resume and a new parse; a past ranking still refers to exactly what it scored.

---

## 2. Applications & decisions

### `applications`

Carries the immutable snapshot (D-009, BR-056).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `company_id` | uuid | not null |
| `job_id` | uuid | not null |
| `candidate_id` | uuid | not null |
| `current_stage_id` | uuid | FK → `job_pipeline_stages.id` |
| `status` | text | not null default `'active'` — `active` / `hired` / `rejected` / `withdrawn` / `transferred` |
| `source` | text | not null — `career_site` / `internal_add` / `agency` / `pool_conversion` / `referral` |
| `source_agency_company_id` | uuid | nullable FK → `companies.id` — drives commission |
| `source_engagement_id` | uuid | nullable FK → `agency_engagements.id` |
| `owner_user_id` | uuid | nullable — recruiter ownership, SLA tracking |
| `form_template_version_id` | uuid | not null |
| `custom_fields` | jsonb | not null default `'{}'` |
| `applied_at` | timestamptz | not null |
| `closed_at` | timestamptz | |
| `transferred_from_id` | uuid | nullable self-FK (D-033) |
| **snapshot fields** | | frozen at submission, never updated |
| `snapshot_full_name` | text | not null |
| `snapshot_email` | citext | |
| `snapshot_phone` | text | |
| `snapshot_current_title` | text | |
| `snapshot_current_employer` | text | |
| `snapshot_experience_years` | numeric(4,1) | |
| `snapshot_current_ctc` | numeric(14,2) | **masked** |
| `snapshot_expected_ctc` | numeric(14,2) | **masked** |
| `snapshot_ctc_currency` | char(3) | |
| `snapshot_notice_period_days` | smallint | **masked** |
| `snapshot_location` | text | |
| `snapshot_education_level` | text | |
| `created_at` / `updated_at` | timestamptz | |

```sql
FOREIGN KEY (job_id, company_id)          REFERENCES jobs (id, company_id)
FOREIGN KEY (candidate_id, company_id)    REFERENCES candidates (id, company_id)
FOREIGN KEY (current_stage_id, company_id) REFERENCES job_pipeline_stages (id, company_id)
CONSTRAINT ux_applications_id_company UNIQUE (id, company_id)

CREATE UNIQUE INDEX ux_application_active_per_job ON applications (job_id, candidate_id)
  WHERE status = 'active';

CREATE INDEX ix_applications_job_stage ON applications (company_id, job_id, current_stage_id)
  WHERE status = 'active';
CREATE INDEX ix_applications_candidate ON applications (company_id, candidate_id, applied_at DESC);
CREATE INDEX ix_applications_owner ON applications (company_id, owner_user_id)
  WHERE status = 'active';
CREATE INDEX ix_applications_agency_lookback
  ON applications (candidate_id, company_id, applied_at)
  WHERE source_agency_company_id IS NOT NULL;
```

**`ux_application_active_per_job` is scoped to active status** (BR-059) — a rejected candidate may reapply to the same job. The unscoped `UNIQUE(job_id, candidate_id)` in the uploaded sheet barred that permanently.

**`ix_applications_agency_lookback`** is the index the hire-time cool-off resolution (BR-075) depends on. Without it that query degrades badly on large tenants.

**The snapshot columns are prefixed `snapshot_`** rather than sharing names with `candidates`. This is deliberate: it makes every read site state which model it is using, and a mapper that accidentally reaches for the live profile becomes visible in review rather than silently correct-looking.

### Concurrent application cap (BR-057, BR-058)

A unique index cannot express "at most N". Enforced by trigger with a row lock:

```sql
CREATE OR REPLACE FUNCTION enforce_application_cap() RETURNS trigger AS $$
DECLARE
  cap int;
  current_count int;
BEGIN
  -- lock the candidate row: closes the check-then-act race
  PERFORM 1 FROM candidates
   WHERE id = NEW.candidate_id AND company_id = NEW.company_id
     FOR UPDATE;

  SELECT COALESCE((value ->> 'maxActiveApplications')::int, 1)
    INTO cap
    FROM settings
   WHERE key = 'candidate.max_active_applications'
     AND (company_id = NEW.company_id OR company_id IS NULL)
   ORDER BY company_id NULLS LAST
   LIMIT 1;

  SELECT count(*) INTO current_count
    FROM applications
   WHERE candidate_id = NEW.candidate_id
     AND company_id = NEW.company_id
     AND status = 'active';

  IF current_count >= cap THEN
    RAISE EXCEPTION 'application_cap_reached'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_application_cap
  BEFORE INSERT ON applications
  FOR EACH ROW EXECUTE FUNCTION enforce_application_cap();
```

`FOR UPDATE` on the candidate row is the whole point. Without it two simultaneous submissions both read a count below the cap and both insert. The service translates the exception to `ERR_APPLICATION_CAP_REACHED`; it must not attempt the check itself and skip the trigger.

### `stage_decisions`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `company_id` | uuid | not null |
| `application_id` | uuid | not null |
| `from_stage_id` / `to_stage_id` | uuid | nullable / nullable |
| `decision` | text | not null — `advance` / `reject` / `hold` / `hire` |
| `decided_by` | uuid | FK → `users.id`, not null |
| `notes` | text | **masked** — internal |
| `decided_at` | timestamptz | not null |

```sql
FOREIGN KEY (application_id, company_id) REFERENCES applications (id, company_id)
CONSTRAINT ck_decision CHECK (decision IN ('advance','reject','hold','hire'))
CREATE INDEX ix_decisions_application ON stage_decisions (company_id, application_id, decided_at DESC);
```

Append-only. `hire` is recorded here at the final stage (BR-065) — formal offer management is Phase 2.

### `decision_reasons` / `stage_decision_reasons`

`decision_reasons`: `id`, `company_id` (NULL = platform default), `decision_type` (`reject` | `hire`), `key`, `label`, `is_active`, `sequence_order`, `created_at`. Unique `(company_id, decision_type, key)`.

`stage_decision_reasons`: `(stage_decision_id, decision_reason_id)` composite PK, plus `company_id`. A decision may carry several reasons, which is why this is a join table and not a column.

`hold` deliberately has no reason catalog — it was excluded, not forgotten.

---

## 3. Interviews & scheduling

### `interviews`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `company_id` | uuid | not null |
| `application_id` | uuid | not null |
| `stage_id` | uuid | not null |
| `title` | text | |
| `mode` | text | `onsite` / `video` / `phone` |
| `status` | text | not null default `'draft'` — `draft` / `slots_proposed` / `scheduled` / `completed` / `cancelled` / `no_show` |
| `scheduled_start` / `scheduled_end` | timestamptz | |
| `timezone` | text | not null — IANA name, e.g. `Asia/Hong_Kong` |
| `location` | text | |
| `meeting_url` | text | |
| `external_calendar_event_id` | text | |
| `scheduled_by` | uuid | FK → `users.id` |
| `cancelled_reason` | text | |
| `created_at` / `updated_at` | timestamptz | |

```sql
FOREIGN KEY (application_id, company_id) REFERENCES applications (id, company_id)
FOREIGN KEY (stage_id, company_id)       REFERENCES job_pipeline_stages (id, company_id)
CONSTRAINT ux_interviews_id_company UNIQUE (id, company_id)
CREATE INDEX ix_interviews_schedule ON interviews (company_id, scheduled_start)
  WHERE status IN ('scheduled','slots_proposed');
```

**Timestamps are `timestamptz` and the IANA zone is stored separately.** Both are needed: the instant for ordering and reminders, the zone so a rescheduled interview displays correctly and survives a DST change. Storing only the instant loses the participant's intent.

### `interview_panelists`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `company_id` | uuid | not null |
| `interview_id` | uuid | not null |
| `user_id` | uuid | not null |
| `role` | text | `lead` / `panelist` / `observer` |
| `response_status` | text | `pending` / `accepted` / `declined` |
| `added_by` | uuid | FK → `users.id`, not null |
| `added_at` | timestamptz | |

```sql
UNIQUE (interview_id, user_id)
FOREIGN KEY (interview_id, company_id) REFERENCES interviews (id, company_id) ON DELETE CASCADE
FOREIGN KEY (user_id, company_id)      REFERENCES users (id, company_id)
```

**Trigger `trg_panelist_adder_on_team`** enforces BR-080: only a member of the job's `job_hiring_team` may add a panelist. A panelist need not themselves be on the hiring team — that is how guest interviewers work (D-008).

### `interview_slots`

Panel availability → candidate selection, matching the PRD's three-step flow.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `company_id` | uuid | not null |
| `interview_id` | uuid | not null |
| `starts_at` / `ends_at` | timestamptz | not null |
| `status` | text | not null default `'proposed'` — `proposed` / `selected` / `expired` |
| `selected_at` | timestamptz | |
| `created_by` | uuid | FK → `users.id` |

```sql
FOREIGN KEY (interview_id, company_id) REFERENCES interviews (id, company_id) ON DELETE CASCADE
CREATE UNIQUE INDEX ux_slot_selected ON interview_slots (interview_id) WHERE status = 'selected';
CONSTRAINT ck_slot_order CHECK (ends_at > starts_at)
```

Selection takes a row lock on the interview before writing — two candidates cannot both select, and a slot cannot be selected twice.

**Open (O-012):** what happens when a candidate declines every proposed slot. Deferred deliberately; the state machine currently leaves the interview in `slots_proposed` until a coordinator intervenes.

### `candidate_action_tokens`

Candidates never authenticate (D-015, BR-017).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `company_id` | uuid | not null |
| `application_id` | uuid | not null |
| `action_type` | text | not null — `select_slot` / `upload_document` / `withdraw` / `confirm_details` |
| `token_hash` | text | not null, unique |
| `target_id` | uuid | nullable — e.g. the interview |
| `expires_at` | timestamptz | not null |
| `consumed_at` | timestamptz | |
| `created_at` | timestamptz | |

```sql
CREATE INDEX ix_action_tokens_app ON candidate_action_tokens (company_id, application_id);
```

Hashed at rest (BR-016), single-use (BR-018), bound to one application and one action type. No ambient authority beyond the encoded action.

---

## 4. Scorecards

### `scorecard_attributes`

`id`, `company_id` (NULL = platform default), `name`, `description`, `category`, `rating_scale` (smallint, default 4), `is_active`, `created_at`. Unique `(company_id, name)`.

A 4-point scale by default — an even scale removes the neutral middle option, which is the standard structured-interview practice for reducing non-committal ratings.

### `interview_focus_attributes`

Which attributes a given stage evaluates. **Keyed to stage, not job.**

`id`, `company_id`, `stage_id`, `attribute_id`, `sequence_order`, `is_required`.

```sql
UNIQUE (stage_id, attribute_id)
FOREIGN KEY (stage_id, company_id) REFERENCES job_pipeline_stages (id, company_id) ON DELETE CASCADE
```

**Trigger `trg_focus_attribute_stage_match`** — the correct name (D-004 correction). Any reference to `trg_focus_attribute_job_match` is stale; the logic was always a stage match.

### `scorecards`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `company_id` | uuid | not null |
| `interview_id` | uuid | not null |
| `application_id` | uuid | not null |
| `submitted_by` | uuid | FK → `users.id`, not null |
| `overall_rating` | smallint | **masked** |
| `recommendation` | text | `strong_yes` / `yes` / `no` / `strong_no` |
| `comments` | text | **masked** |
| `submitted_at` | timestamptz | not null |
| `amends_scorecard_id` | uuid | nullable self-FK |

```sql
CREATE UNIQUE INDEX ux_scorecard_per_panelist ON scorecards (interview_id, submitted_by)
  WHERE amends_scorecard_id IS NULL;
```

**Immutable once submitted** (BR-083). An amendment is a new row referencing the original — the partial unique index permits exactly that while preventing a second original.

### `scorecard_ratings`

`id`, `company_id`, `scorecard_id` (cascade), `attribute_id`, `rating` (smallint), `comment` (**masked**). Unique `(scorecard_id, attribute_id)`.

**Anchoring-bias protection (BR-082) is a service-layer rule**, not a constraint: peer scores are withheld until the viewer has submitted their own. It cannot be a database rule because it depends on who is asking, and it must be tested at the API layer.

---

## 5. Agencies & commission

### `agency_engagements`

Self-referential `companies` → `companies` (D-035, BR-070).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `client_company_id` | uuid | not null FK → `companies.id` |
| `agency_company_id` | uuid | not null FK → `companies.id` |
| `status` | text | not null default `'pending'` — `pending` / `active` / `suspended` / `terminated` |
| `commission_rate_pct` | numeric(5,2) | **masked** |
| `commission_flat_amount` | numeric(14,2) | **masked** |
| `commission_currency` | char(3) | |
| `cool_off_months` | smallint | not null default 6 |
| `starts_at` / `ends_at` | timestamptz | |
| `contract_reference` | text | |
| `created_by` | uuid | FK → `users.id` |
| `created_at` / `updated_at` | timestamptz | |

```sql
UNIQUE (client_company_id, agency_company_id)
CONSTRAINT ck_no_self_engagement CHECK (client_company_id <> agency_company_id)
CONSTRAINT ck_cool_off CHECK (cool_off_months BETWEEN 1 AND 24)
CREATE INDEX ix_engagements_agency ON agency_engagements (agency_company_id, status);
CREATE INDEX ix_engagements_client ON agency_engagements (client_company_id, status);
```

`ck_no_self_engagement` enforces BR-071 in the database — the two capabilities of one dual-capacity company are not counterparties.

**RLS — non-standard, two-sided:**

```sql
CREATE POLICY engagement_access ON agency_engagements
  AS PERMISSIVE FOR SELECT TO findneo_app
  USING (
       client_company_id = current_setting('app.current_company_id', true)::uuid
    OR agency_company_id = current_setting('app.current_company_id', true)::uuid
  );
```

Write policies are client-side only: an agency cannot alter its own commission terms.

### `job_agency_assignments`

**Points at `engagement_id`, never at an agency directly** — so a grant cannot exist without an engagement authorising it.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `company_id` | uuid | not null — the **client** company |
| `job_id` | uuid | not null |
| `engagement_id` | uuid | not null FK → `agency_engagements.id` |
| `status` | text | not null default `'active'` |
| `assigned_by` | uuid | FK → `users.id` |
| `assigned_at` | timestamptz | |

```sql
UNIQUE (job_id, engagement_id)
FOREIGN KEY (job_id, company_id) REFERENCES jobs (id, company_id)
```

**The agency-side read policy (D-014, BR-072, BR-073).** The session never rebinds tenant context; access flows through the engagement:

```sql
CREATE POLICY agency_job_read ON jobs
  AS PERMISSIVE FOR SELECT TO findneo_app
  USING (
    EXISTS (
      SELECT 1
        FROM job_agency_assignments jaa
        JOIN agency_engagements ae ON ae.id = jaa.engagement_id
       WHERE jaa.job_id = jobs.id
         AND jaa.status = 'active'
         AND ae.status  = 'active'
         AND ae.agency_company_id = current_setting('app.current_company_id', true)::uuid
    )
  );
```

The agency's own `company_id` is bound throughout. There is no point at which the client's tenant id enters the session — which is exactly the hole the uploaded schema's `sessions.active_company_id` semantics would have created.

### `commission_attributions`

The documented exception to BR-001 — no single owning company.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `hiring_company_id` | uuid | not null FK → `companies.id` |
| `attributed_agency_id` | uuid | not null FK → **`companies.id`** |
| `engagement_id` | uuid | not null |
| `application_id` | uuid | not null — the hired application |
| `source_application_id` | uuid | not null — the earliest qualifying agency referral |
| `candidate_id` | uuid | not null |
| `commission_rate_pct` | numeric(5,2) | **snapshotted** |
| `commission_flat_amount` | numeric(14,2) | **snapshotted** |
| `commission_currency` | char(3) | |
| `cool_off_months_at_hire` | smallint | not null — **snapshotted** |
| `status` | text | not null default `'pending'` — `pending` / `confirmed` / `disputed` / `paid` |
| `attributed_at` | timestamptz | not null |

```sql
UNIQUE (application_id)
CREATE INDEX ix_commission_agency ON commission_attributions (attributed_agency_id, status);
CREATE INDEX ix_commission_client ON commission_attributions (hiring_company_id, status);
```

**`attributed_agency_id → companies.id`** — the F4 correction. The standalone `agencies` table does not exist post-merge.

**RLS — the OR policy (BR-007):**

```sql
CREATE POLICY commission_dual_access ON commission_attributions
  AS PERMISSIVE FOR SELECT TO findneo_app
  USING (
       hiring_company_id    = current_setting('app.current_company_id', true)::uuid
    OR attributed_agency_id = current_setting('app.current_company_id', true)::uuid
  );
```

The single permitted deviation from the standard pattern. It gets its own isolation test asserting that a **third** company sees nothing.

**Written only as a side effect of the hire action** (BR-075, D-035), never through a direct API. Terms are snapshotted because contracts change and a live-computed payout would silently change retroactively.

---

## 6. Messaging & notifications

v1 is direct, event-triggered messaging only. The configurable rule engine is Phase 2 (D-030).

### `email_templates`

`id`, `company_id` (NULL = platform default), `key`, `subject`, `body_html`, `body_text`, `locale`, `is_active`, `updated_by`, `updated_at`. Unique `(company_id, key, locale)`.

Platform defaults exist for every `key` so a new tenant sends correct mail with zero configuration.

### `messages`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `company_id` | uuid | not null |
| `template_key` | text | |
| `channel` | text | not null default `'email'` |
| `subject` | text | |
| `body_rendered` | text | **contains personal data — never logged** |
| `related_entity_type` / `related_entity_id` | text / uuid | |
| `sent_by` | uuid | FK → `users.id`, nullable for system messages |
| `created_at` | timestamptz | |

### `message_deliveries`

`id`, `company_id`, `message_id` (cascade), `recipient_email` (citext), `recipient_user_id` (nullable), `status` (`queued`/`sent`/`delivered`/`bounced`/`failed`), `provider_message_id`, `attempts`, `last_error`, `sent_at`, `delivered_at`.

Split from `messages` because one message may have several recipients with independent delivery outcomes, and a bounce must be attributable to one address.

---

## 7. AI seams

Built now, populated by teammates (D-029). Shapes marked provisional pending O-001.

### `ranking_runs`

`id`, `company_id`, `job_id`, `requested_by`, `status` (`queued`/`running`/`succeeded`/`failed`), `model_name`, `model_version`, `application_count`, `requested_at`, `completed_at`, `error_reason`.

A terminal `failed` state with a reason is mandatory — a run must never sit in `queued` indefinitely.

### `application_rankings`

`id`, `company_id`, `run_id` (cascade), `application_id`, `score` (numeric(6,3)), `rank_position`, `explanation` (jsonb), `model_name`, `model_version`, `created_at`.

```sql
UNIQUE (run_id, application_id)
CREATE INDEX ix_rankings_job_score ON application_rankings (company_id, run_id, score DESC);
```

`UNIQUE (run_id, application_id)` is what makes result ingestion idempotent — a redelivered result upserts rather than duplicating.

**Provenance columns are duplicated onto each ranking row** rather than only on the run. A run's model can be corrected after the fact; the row records what actually produced that score (BR-112).

**BR-110 is structural:** no column anywhere permits an AI output to set an application's status. The only path to `rejected` or `hired` is a `stage_decisions` row with a human `decided_by`.

---

## 8. Compliance seams

Present now, largely unused in v1 (D-027).

### `consents`

`id`, `company_id`, `candidate_id`, `consent_type` (`data_processing` / `marketing` / `retention_extension`), `granted`, `source`, `evidence` (jsonb), `granted_at`, `withdrawn_at`, `expires_at`.

### `erasure_requests`

`id`, `company_id`, `candidate_id`, `requested_by_email`, `verification_token_hash`, `verified_at`, `status` (`pending`/`verified`/`completed`/`rejected`), `completed_at`, `executed_by`.

**Anonymization procedure** (BR-093, D-034), run in the worker inside one transaction:

1. `candidates` — scrub name, email, phone, employer, LinkedIn, location; set `anonymized_at`.
2. `applications` — scrub every `snapshot_*` personal field; **retain** dates, job, stage, status, and `source_agency_company_id`.
3. `candidate_resumes` — delete the stored objects; retain rows with a tombstone marker.
4. `parsed_resume_data` — delete `raw_text` and `structured`.
5. `messages` — scrub `body_rendered`; retain the send record.
6. `audit_logs` — scrub values inside `changes`; **retain** actor, action, entity, and timestamp.
7. `commission_attributions`, `stage_decisions` — **untouched**. No personal data; required for BR-075 and BR-076.

Steps 1–6 must be one transaction. Partial anonymization is worse than none, because it leaves the record inconsistent while appearing complete.

---

## 9. Migration order (continuing from 015)

```
016  candidates, talent_pool_entries, candidate_resumes, parsed_resume_data
017  applications (+ cap trigger), stage_decisions,
     decision_reasons, stage_decision_reasons
018  interviews, interview_panelists (+ team trigger),
     interview_slots, candidate_action_tokens
019  scorecard_attributes, interview_focus_attributes (+ stage-match trigger),
     scorecards, scorecard_ratings
020  agency_engagements, job_agency_assignments, commission_attributions
021  email_templates, messages, message_deliveries
022  ranking_runs, application_rankings
023  consents, erasure_requests
024  RLS: enable, force, policies for 016–023 (incl. the three non-standard policies)
025  seed: decision reasons, scorecard attributes, email templates
```

**Migration 024 is separate and last**, mirroring 013. It contains the three policies that deviate from the canonical pattern — `talent_pool_entries` (owner column), `agency_engagements` (two-sided), `commission_attributions` (OR) — so all deviations are reviewable in one place.

Also add to migration 001: `pg_trgm` (fuzzy name matching, §1).

---

## 10. Test requirements for this slice

Beyond the standard per-feature obligations:

1. **Cap race** — simultaneous submissions with cap 1: exactly one succeeds (BR-058).
2. **Snapshot immutability** — updating a candidate profile does not alter any existing application.
3. **Resume freeze** — replacing the profile resume leaves the application's copy byte-identical.
4. **Re-application** — a rejected candidate can reapply to the same job (BR-059).
5. **Pool isolation** — an org cannot read an agency's `talent_pool_entries`; explicitly covers the `owner_company_id` naming deviation.
6. **Agency job scope** — an agency reads only jobs assigned via an active engagement; a terminated engagement immediately removes access.
7. **Agency blindness** — an agency user cannot read scorecards, internal notes, or another agency's applications (BR-074).
8. **Commission three-party** — client sees it, agency sees it, an unrelated third company sees nothing (BR-007).
9. **Cool-off lookback** — the earliest qualifying referral wins; one outside the window does not (BR-075).
10. **Commission snapshot** — changing engagement terms after a hire does not alter the existing attribution (BR-076).
11. **Panelist authority** — a non-hiring-team user cannot add a panelist (BR-080).
12. **Anchoring** — an interviewer cannot read peer scores before submitting (BR-082).
13. **Scorecard immutability** — a second original for the same panelist is rejected; an amendment is accepted (BR-083).
14. **Slot race** — two selections on one interview: exactly one succeeds.
15. **Token single-use** — a consumed candidate token returns 410 (BR-018).
16. **Anonymization completeness** — after erasure, no personal field remains in any table, while `commission_attributions`, `stage_decisions`, and audit actor/timestamp survive intact (BR-093).
17. **AI cannot decide** — no path exists for a ranking row to change application status (BR-110).
