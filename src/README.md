# Source layout (ER-008)

One package, two entrypoints (D-003). Dependencies point **downward only** (ER-001, D-037).

```
client → BFF → controller → application → domain → infrastructure
```

```
src/
  bff/web/          client adaptation only, /bff/web/*   — mobile/ added later, same pattern
  modules/          feature modules, layered inside      — created per phase, not up front
  platform/         adapters: the only place external SDKs appear
    config/ db/ queue/ storage/ mail/ cache/ clock/ telemetry/
  shared/           errors/ http/ authz/ validation/ types/
  workers/          six queue domains (D-039)
    communication/ ai/ documents/ integrations/ recruitment/ system/
  bootstrap/        api.ts · worker.ts (takes a domain argument) · container.ts
```

**`src/modules/` is empty on purpose.** Modules arrive with the phase that specifies them — `identity` in Phase 1, `jobs`/`forms` in Phase 2, and so on. ER-008 discourages folders created to look consistent: a `domain/` folder's presence is meant to signal that real invariants live there.

Inside a module:

```
modules/<name>/
  <name>.routes.ts          /v1/*
  <name>.controller.ts      validate → one application service → shape response (ER-002)
  <name>.schemas.ts         TypeBox
  <name>.mapper.ts          allowlist serialization (ER-025)
  <name>.errors.ts  <name>.events.ts
  application/              use cases, transactions, authorization decisions
  domain/                   entities and invariants — rich modules only (D-038)
  infrastructure/           repositories, Drizzle queries
  __tests__/
```

## The import matrix

Enforced mechanically by `eslint-plugin-boundaries` (see [`eslint.boundaries.js`](../eslint.boundaries.js)), not by review. Proof that it rejects violations lives in [`fixtures/boundaries/`](../fixtures/boundaries).

| From             | May import                                                                                       | Never                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `bootstrap`      | everything                                                                                       | —                                                                         |
| `bff`            | `application`, `shared`, `platform/telemetry`                                                    | repositories, domain, `platform/db`, any other platform adapter (ER-002a) |
| `controller`     | `application`, module support files, `shared`, `platform/telemetry`                              | repositories, domain, `platform/db` (ER-002, ER-006)                      |
| `application`    | own module's `domain` + `infrastructure`, **other modules' `application`**, `shared`, `platform` | other modules' repositories or domain (ER-007)                            |
| `domain`         | own module's `domain` only                                                                       | **everything else, including every external package** (ER-003b)           |
| `infrastructure` | own module's `domain`, `shared`, `platform`                                                      | other modules, HTTP types, the queue (ER-005)                             |
| `worker`         | `application`, `shared`, `platform`                                                              | repositories, domain (ER-043)                                             |
| `platform`       | `platform`, `shared`                                                                             | modules, bff, workers                                                     |
| `shared`         | `shared`                                                                                         | everything else                                                           |

Two rules carry most of the weight and are named individually in the Phase 0 gate:

- **A BFF file cannot import a repository.** The BFF adapts; it never decides (ER-002a).
- **A domain file cannot import Drizzle** — or Fastify, or pg-boss, or anything else external. A domain file that cannot be unit tested without a database is not a domain file (ER-003b).

External packages are restricted too: `pg`, `drizzle-orm`, `pg-boss`, `@aws-sdk/*`, `nodemailer`, and `lru-cache` may be imported **only** under `platform/` (ER-011).
