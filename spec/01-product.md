# FindNeo — Product Specification

**Layer:** product. Business language only — no table names, library names, or endpoint paths (`SPEC-MANIFEST.md`).

---

## 1. What FindNeo is

A multi-tenant Applicant Tracking System sold as SaaS to companies that hire, to agencies that place candidates, and to businesses that do both. Greenhouse is the functional reference model.

Two things distinguish it from generic hiring tools:

**Agency/company duality is architectural, not a feature.** One business can operate as both a hiring company and a placement agency without duplicated identities or brittle linking. Most platforms force a choice, then bolt the other on.

**History is preserved rather than overwritten.** A candidate's evolving profile and their frozen per-application details are both kept. Nothing destructive actually destroys — rejection, transfer, deactivation, and erasure all leave the record intact enough to answer "what happened, and who decided."

AI-assisted ranking and matching are built by a separate team on top of a core that works correctly without them.

---

## 2. The problem

Hiring is cross-functional and collaborative; most tooling models it as a linear pipeline owned by one team.

Concretely, the gaps this product targets:

- Platforms serve either direct-hire companies or agencies. Businesses that are both end up with two accounts and manual reconciliation.
- A candidate's current profile and what they claimed on a specific application get conflated — so either audit integrity or search quality is sacrificed.
- Agency commission after a candidate is later hired through a different route is handled by spreadsheet and argument.
- Compensation and evaluative feedback are treated as ordinary fields, so access control is coarse.
- Job requirements differ by company, and rigid forms push the difference into free-text notes nobody can query.

---

## 3. Users

| Actor | What they do | Authenticates |
|---|---|---|
| System Admin | Internal FindNeo staff operating the platform. No ambient access to any tenant's data | Separate surface, MFA mandatory |
| Super Admin | The customer's own tenant owner. One per company | Yes, MFA mandatory |
| HR Admin | Manages jobs, users, departments, agencies, configuration | Yes |
| Hiring Manager | Owns requisitions and their pipelines | Yes |
| Recruiter | Sources and progresses candidates | Yes |
| Coordinator | Schedules and coordinates. No evaluative role, no compensation visibility | Yes |
| Interviewer | Conducts assigned interviews, submits structured feedback | Yes |
| Agency Recruiter | Sources candidates for client companies under a formal engagement | Yes, agency portal only |
| Candidate | The subject of the process | **Never** — secure expiring links only |

Candidates never having accounts is a deliberate reduction of the authentication surface: the only people who can log in are the people operating the system.

---

## 4. Goals

1. Support the full hiring lifecycle for direct-hire companies, matching core Greenhouse-equivalent function.
2. Support agencies as first-class participants, not a bolted-on portal.
3. Support dual-capacity businesses without data duplication.
4. Enforce isolation between tenants, and privacy between agencies and their clients.
5. Make evaluation structured and auditable rather than freeform.
6. Let each company shape its own job and application forms without engineering work.
7. Leave a foundation AI features layer onto without redesign.
8. Run both as hosted SaaS and on customer premises from the same codebase.

### Success criteria

- A candidate's data at one company is never visible to, or inferable by, another company.
- Every hiring decision has a permanent, attributable record.
- Agency commission is correctly attributed even when the hire happens through a different route.
- A hiring team can run a requisition end to end without leaving the platform.
- A company can add a field to its job form without a release.
- A candidate can find and apply to a job without creating an account.
- An unauthenticated career-site visitor can never reach a confidential or unpublished job.

---

## 5. Scope

### In scope for v1

- Authentication, sessions, MFA, self-service company signup
- Company structure, departments, roles, permissions, field-level visibility
- Dual-capacity companies and agency engagements
- Configurable job and application forms
- Job creation, publishing, pipeline configuration, hiring teams
- Public career site — hosted job listing and application submission, addressed by company slug
- Candidate profiles, talent pools, duplicate detection
- Applications: submission, stage progression, rejection, withdrawal, non-destructive transfer, hire
- Interviews: panel availability, candidate slot selection, calendar sync
- Structured scorecards with anchoring-bias protection
- Agency submissions, cool-off tracking, hire-time commission attribution
- Audit trail, activity history, event-triggered notifications
- On-premise deployment

### Out of scope for v1

| Deferred | Why |
|---|---|
| AI ranking and matching | Built by a separate team on top of this core |
| Offers module and approval chains | A module in its own right; hire is recorded without it |
| Requisition approval chains | Same |
| Configurable notification rule engine | v1 sends direct event-triggered messages |
| Multi-document attachments | One resume per application in v1 |
| Embeddable career-site widget | Hosted career page covers v1; the embed uses the same public API |
| Post-hire onboarding | Different product surface |
| CRM-style nurturing | Basic pools only |
| Billing implementation | Pricing model undecided |
| SSO / SCIM | Enterprise, post-launch |
| EU-specific compliance workflows | Seams built; workflows follow market entry |
| Realtime updates | Polling in v1 |

---

## 6. Product constraints

These are commitments, not preferences. Each shapes the architecture.

1. **Candidates never authenticate.** All candidate interaction is via expiring single-use links.
2. **A user belongs to exactly one company.** No cross-company membership.
3. **Application details are frozen at submission.** The candidate's profile evolves separately.
4. **Nothing destructive deletes.** Rejection, transfer, deactivation, and erasure all preserve the record.
5. **On-premise from v1.** No dependency a customer cannot self-host.
6. **The API never sends data the caller may not see.** No client-side hiding.
7. **AI never decides.** It suggests; a human acts.

---

## 7. Non-functional requirements

**Performance.** Authorization overhead sub-5ms regardless of tenant size. List endpoints p95 under 200ms at 100k applications per tenant. Bulk and reporting are a separate category with their own limits.

**Security.** Tenant isolation enforced at the database, not only in application code. All stored secrets hashed. MFA mandatory for tenant owners and platform staff. Platform staff have no ambient tenant access. Field-level masking applies to reads, exports, and audit history alike.

**Scalability.** Shared database with row-level isolation; composite indexes led by tenant. High-write audit tables partitioned from day one. A dedicated-database tier remains possible for a large customer without redesign.

**Availability.** **Open (O-009)** — needs a stated target before launch planning.

**Compliance.** US and Hong Kong at launch; EU later. Erasure by anonymization. Retention windows **open (O-006)**, pending legal input per region.

**Operability.** Same instrumentation in both deployment targets. No telemetry egress from customer premises by default. Documented, skip-version-safe upgrades.

---

## 8. Dependencies

| Dependency | Status |
|---|---|
| Email delivery | Required v1. Provider API hosted, SMTP on-premise |
| Object storage | Required v1. S3 hosted, MinIO or filesystem on-premise |
| Calendar (Google, Microsoft) | Required for interview scheduling |
| AI / resume parsing | Separate team. Contract **open (O-001)** |
| Payment provider | Phase 2. Not selected |
| SMS | Undecided, likely not v1 |

---

## 9. Open product questions

| Id | Question |
|---|---|
| O-001 | Resume-ranker contract — request/response shape, poll or callback |
| O-002 | Service ownership — is notification delivery ours or a teammate's? |
| O-006 | Retention windows per region — needs legal input |
| O-007 | Pricing model — per-seat, usage, or tiered |
| O-008 | Product name — FindNeo vs RecruitAI |
| O-009 | Availability target |
| O-012 | Candidate declines every proposed interview slot |
| O-013 | Per-field audience on application forms |

O-006 and O-009 must be answered before launch. The rest can be answered during build.

---

## 10. What this document is not

This is the product layer. Decisions live in `00-decisions.md`, rules in `03-business-rules.md`, structure in `06-data-model.md` and `06b-data-model-hiring.md`, contracts in `07-api-standards.md`.

The uploaded PRD workbook was an early ideation artifact. Where it conflicts with the decision log, the decision log is correct.
