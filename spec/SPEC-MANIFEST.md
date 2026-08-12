# FindNeo — Specification Manifest

The authoritative index of the specification set. Every document, its purpose, its audience, and its status.

**Repository layout:**

```
/AGENTS.md                    ← constitution, repo root, read by every agent
/CLAUDE.md                    ← symlink or pointer to AGENTS.md
/spec/
  SPEC-MANIFEST.md            ← this file
  00-decisions.md
  01-product.md
  02-glossary.md
  03-business-rules.md
  04-permissions.md
  05-architecture-hld.md
  05a-tech-stack.md
  06-data-model.md
  07-api-standards.md
  08-lld-<module>.md          ← one per module
  09-engineering-rules.md
  10-security-baseline.md
  11-testing-strategy.md
  12-observability-ops.md
  13-delivery-plan.md
/spec/adr/                    ← one file per architecture decision record
/spec/openapi/openapi.yaml    ← generated, never hand-edited
```

---

## The set

| # | Document | Answers | Primary audience | Status |
|---|---|---|---|---|
| — | `AGENTS.md` | What rules bind every action in this repo? | AI agent, on every task | ⬜ |
| 00 | `00-decisions.md` | What was decided, and why? Conflict resolver. | Everyone | ✅ |
| 01 | `01-product.md` | What are we building, for whom, and what is out of scope? | Product, stakeholders | ⬜ |
| 02 | `02-glossary.md` | What does each term mean? One name per concept. | Everyone | ⬜ |
| 03 | `03-business-rules.md` | What invariants must always hold? | Backend, QA | ✅ |
| 04 | `04-permissions.md` | Who can do what, and to which rows and fields? | Backend, security | ✅ |
| 05 | `05-architecture-hld.md` | How do the pieces fit and communicate? | Backend, ops | ⬜ |
| 05a | `05a-tech-stack.md` | Exactly which technologies and libraries, at which versions, and why? | Backend, ops | ✅ |
| 06 | `06-data-model.md` | What are the tables, constraints, indexes, and policies? | Backend, DBA | ✅ |
| 07 | `07-api-standards.md` | What shape does every request, response, and error take? | Backend, frontend | ✅ |
| 08 | `08-lld-<module>.md` | For this module: endpoints, DTOs, services, transactions, errors, tests. | Backend | ⬜ |
| 09 | `09-engineering-rules.md` | How must code be written and structured? | Backend, agent | ✅ |
| 10 | `10-security-baseline.md` | What is the threat model and the control for each threat? | Backend, security | ⬜ |
| 11 | `11-testing-strategy.md` | What must be tested, how, and what does done mean? | Backend, QA | ⬜ |
| 12 | `12-observability-ops.md` | How is it logged, traced, deployed, backed up, upgraded? | Ops | ⬜ |
| 13 | `13-delivery-plan.md` | What gets built in which order, with what acceptance gates? | Everyone | ⬜ |

**Generated, never hand-written:** `/spec/openapi/openapi.yaml` — emitted from TypeBox route schemas at build time (§7 of `07-api-standards.md`). It is a build output. Editing it by hand desynchronises it from the code and the edit is lost on next build.

---

## Precedence

When two documents disagree:

```
00-decisions.md
  └─ overrides everything
      └─ 06-data-model.md, 07-api-standards.md, 04-permissions.md   (technical contracts)
          └─ 08-lld-*.md                                            (module detail)
              └─ 01-product.md, PRD, session extractions, transcripts
```

Uploaded source material — `Product_Requirement_Document.xlsx`, `Database_design_V1.xlsx`, the RBAC docx, prior session extractions — is **historical input, not specification**. It is superseded wherever this set speaks. `00-decisions.md` §"Superseded" lists the ideas in those documents that are now wrong and must not be reintroduced.

---

## Layer separation

Following standard SDD practice, requirements are kept free of implementation detail:

| Layer | Documents | Contains | Must not contain |
|---|---|---|---|
| **Product** | 01, 02, 03 | What the system does, in business language | Table names, library names, endpoint paths |
| **Contract** | 04, 06, 07 | Interfaces others depend on | Implementation internals |
| **Technical** | 05, 05a, 08, 10, 11, 12 | How it is built | Business rationale (link to 03 instead) |
| **Process** | 09, 13, `AGENTS.md` | How work is done | Feature specifics |

A rule stated in business terms lives in 03 and is *referenced* by id from 06, 07, and 08 — never restated. Restating a rule in two documents guarantees they diverge.

---

## Identifier scheme

Every specified item carries a stable id so code, tests, and review comments can cite it.

| Prefix | Meaning | Lives in |
|---|---|---|
| `D-nnn` | Decision | 00 |
| `BR-nnn` | Business rule | 03 |
| `PERM-*` | Permission key | 04 |
| `ER-nnn` | Engineering rule | 09 |
| `ERR-*` | Error code | 07 |
| `EVT-*` | Domain event | 07 |
| `SEC-nnn` | Security control | 10 |
| `T-nnn` | Delivery task | 13 |
| `O-nnn` | Open question | 00 |

**Ids are permanent.** A retired rule is marked retired, never deleted and never renumbered. Renumbering silently invalidates every citation in the codebase.

---

## Requirement syntax

Business rules and acceptance criteria use EARS patterns, because they parse unambiguously for both humans and language models:

| Pattern | Form |
|---|---|
| Ubiquitous | The system shall `<response>` |
| Event-driven | When `<trigger>`, the system shall `<response>` |
| State-driven | While `<state>`, the system shall `<response>` |
| Unwanted | If `<condition>`, then the system shall `<response>` |
| Optional | Where `<feature is configured>`, the system shall `<response>` |

Each rule states **where it is enforced** (database / service / API edge) and carries at least one test.

---

## Maintenance

- A change to behaviour updates the spec **in the same pull request** as the code. A PR that changes behaviour without touching a spec is rejected in review.
- A new decision appends to 00. It never edits history — a reversal is a new entry marking the old one superseded.
- Open questions live in 00 §Open with an owner. They are never resolved silently inside another document.
- ADRs in `/spec/adr/` carry the long-form reasoning for heavyweight decisions. 00 carries the summary and links out.
