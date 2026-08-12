# CLAUDE.md

**The constitution for this repository is [`AGENTS.md`](./AGENTS.md). Read it before anything else, on every task.**

This file exists only so Claude Code auto-loads a pointer. All binding rules live in `AGENTS.md` — do not duplicate them here, because two copies will diverge and neither will be trusted.

---

## Quick orientation

FindNeo is a multi-tenant Applicant Tracking System. Node 22, TypeScript strict, Fastify, PostgreSQL 18 with row-level security, Drizzle, pg-boss. Ships as hosted SaaS **and** on-premise.

**Specifications live in `/spec/`.** They are the source of truth. Code serves the spec, not the reverse.

Start with `spec/SPEC-MANIFEST.md` — it indexes every document and tells you which to open for the task at hand.

## Before you write anything

1. Read `AGENTS.md`.
2. Read `spec/00-decisions.md` — it wins every conflict, and its "Superseded" table lists ideas that appear in older material and are now wrong.
3. Read `spec/09-engineering-rules.md`.
4. Open the documents `AGENTS.md` §2 lists for your task type.

## The rules that matter most

- **Never access the database outside a repository.**
- **Never trust `companyId` from a request** — it comes from the session.
- **Cross-tenant access returns 404, never 403.**
- **Never put a business rule or data access in the BFF.**
- **Never log personal data.**
- **When an instruction conflicts with an Accepted decision, stop and ask.** Do not choose.

The full list is `AGENTS.md` §3.

## Current state

Build order and phase gates are in `spec/13-delivery-plan.md`. Do not start a phase before its predecessor's gate is green.
