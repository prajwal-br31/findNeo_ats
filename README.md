# FindNeo Backend

Multi-tenant Applicant Tracking System. Node 22, TypeScript strict, Fastify, PostgreSQL 18 with row-level security, Drizzle, pg-boss. Ships as hosted SaaS **and** on-premise.

**The specification is the source of truth.** Read [`AGENTS.md`](./AGENTS.md) before changing anything, then [`spec/SPEC-MANIFEST.md`](./spec/SPEC-MANIFEST.md). Code serves the spec, not the reverse.

Current state: **Phase 0 (Foundation)**, per [`spec/13-delivery-plan.md`](./spec/13-delivery-plan.md).

---

## Prerequisites

|            | Version                     | Notes                                                             |
| ---------- | --------------------------- | ----------------------------------------------------------------- |
| Node.js    | 22 LTS (pinned in `.nvmrc`) |                                                                   |
| pnpm       | 9.15.9                      | Provided by corepack; see below                                   |
| PostgreSQL | 18                          | **Installed natively.** No Docker for the app or the dev database |
| Docker     | any recent                  | Tests only — Testcontainers starts a throwaway PostgreSQL         |

Local development runs natively. Docker Compose is an on-premise **delivery** concern (T-163), not a development one.

### pnpm via corepack

```bash
corepack enable
```

On Windows this writes shims into `C:\Program Files\nodejs` and needs an **elevated** terminal. Without it, prefix commands with `corepack`:

```bash
corepack pnpm install
```

---

## Setup

```bash
corepack pnpm install
```

Then create the databases, roles, and your `.env`. This step needs a PostgreSQL **superuser** connection, so run it yourself — the script reads the standard libpq variables (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`) and never stores a password:

```bash
pnpm db:setup
```

PowerShell — set **both** variables:

```bash
$env:PGUSER = 'postgres'; $env:PGPASSWORD = '<your postgres superuser password>'; pnpm db:setup
```

`PGUSER` is not optional on Windows: `pg` defaults it to your Windows account name rather than to `postgres`, so leaving it unset fails as an unknown role. `PGHOST` and `PGPORT` default to `localhost:5432`.

It is safe to re-run: if `.env` already exists the script refuses and touches nothing. Pass `--force` to regenerate (this rotates the role passwords and rewrites `.env`).

What it creates:

- Databases `findneo_dev` and `findneo_test`, owned by `findneo_migrator`
- Roles `findneo_migrator` (owns tables, never serves traffic) plus `findneo_app`, `findneo_public`, `findneo_platform` (06 §2) — none a superuser, none an owner
- The `citext` extension in both databases (06 §1)
- A `.env` (mode 600, gitignored) containing **locally generated** role passwords, an Ed25519 JWT keypair, and a cookie secret. Nothing is shared between installations (SEC-073), and no secret is printed to the terminal

Verify:

```bash
pnpm config:check
```

---

## Commands

| Command                  | Does                                                     |
| ------------------------ | -------------------------------------------------------- |
| `pnpm typecheck`         | `tsc --noEmit` across `src/` and `scripts/`              |
| `pnpm lint`              | ESLint, including the layer boundary rules               |
| `pnpm format`            | Prettier write (`format:check` to verify only)           |
| `pnpm build`             | Compile `src/` to `dist/`                                |
| `pnpm verify:boundaries` | Prove the boundary rules reject planted violations       |
| `pnpm verify:semgrep`    | Prove the seven Semgrep rules fire on planted violations |
| `pnpm db:setup`          | Create dev/test databases, roles, and `.env` (above)     |
| `pnpm config:check`      | Validate configuration and print a redacted summary      |

---

## Guardrails

Rules that a machine can enforce are enforced by a machine, because an agent — or a tired human — will otherwise violate them confidently and plausibly (05a §8).

| Layer                   | Enforces                                                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tsconfig.json`         | ER-012 strict flags, all six                                                                                                                                                                       |
| `eslint.config.js`      | ER-009 file/function size, ER-013 no `any`, ER-014 return types, ER-016 named exports, ER-017 exhaustive switches, ER-010 no barrels                                                               |
| `eslint.boundaries.js`  | ER-001 layer direction, ER-002a BFF, ER-003b pure domain, ER-004 no HTTP types below the BFF, ER-006, ER-007 cross-module, ER-011 SDKs in `platform/` only                                         |
| `semgrep/findneo.yml`   | The seven rules of 05a §9 — SQL interpolation, db access outside a repository, SDK placement, response spread, client-supplied `companyId`, non-transaction-local tenant binding, `===` on secrets |
| `.husky/` + lint-staged | Runs the above on staged files; commitlint checks the message                                                                                                                                      |

**Both guardrail layers ship with planted violations and controls.** `fixtures/boundaries/` and `fixtures/semgrep/` contain code that must be rejected _and_ legal code that must pass — a rule that fires on everything is as useless as one that fires on nothing. The two `verify:` commands assert both directions and are what the Phase 0 gate is checked against.

`verify:semgrep` uses a local `semgrep` if one is on `PATH`, and otherwise the official Docker image. On Windows the local route works and is much faster:

```bash
python -m venv .semgrep-venv && ./.semgrep-venv/Scripts/python.exe -m pip install semgrep
```

Add `.semgrep-venv/Scripts` to `PATH` for the session, then `pnpm verify:semgrep`.

---

## Configuration

Every variable is validated once at startup and the process **fails fast** on anything missing or malformed, rather than discovering it at first use (SEC-060, ER-046). Nothing has a default. `src/platform/config/config.ts` is the only place in the codebase that reads `process.env`.

[`.env.example`](./.env.example) is the reference. Beyond per-variable types, five cross-field rules are enforced:

| Rule                                                   | Why                                                                                                   |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `NODE_ENV=production` ⇒ `SWAGGER_ENABLED=false`        | 07 §7, 12 §10                                                                                         |
| `OPS_HOST` must be loopback, and `OPS_PORT ≠ API_PORT` | `/health/*` and `/metrics` run on a second listener that is never publicly reachable (SEC-021, 12 §3) |
| `NODE_ENV=test` ⇒ `DATABASE_URL` is never read         | Tests cannot reach the dev database even when `.env` is loaded                                        |
| Test database name must end `_test`                    | Checked before any DDL, by the loader and again by the test harness                                   |
| Non-test modes refuse a `_test` database               | The same mistake in reverse                                                                           |

`DATABASE_URL_MIGRATOR` is present in `.env` for `drizzle-kit` but is deliberately **not** part of the validated application config: the API and worker must never hold table-owner credentials.

### Testing against a native database

Tests use Testcontainers by default. To use the native `findneo_test` database instead, uncomment `DATABASE_URL_TEST` in `.env`. Either way the `_test` suffix guard applies.

---

## Layout

```
src/
  bff/web/        client adaptation only — /bff/web/*
  modules/        feature modules, layered inside
  platform/       adapters — the only place external SDKs appear
  workers/        six queue domains
  shared/         errors, http, authz, validation, types
  bootstrap/      api.ts · worker.ts (takes a domain argument) · container.ts
scripts/          operational tooling, outside the layered tree
spec/             the specification
```

One package, two entrypoints, two images (D-003). Layer rules are enforced by `eslint-plugin-boundaries`, not by convention (T-006a).
