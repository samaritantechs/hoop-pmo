# HOOP PMO

Follow-up system for **Hoop Ltd** — a phone dealership agent for Watu Credit (watu simu).
Hoop's credit team owns locked-phone customers for 45 days from disbursement; this system
gives them the daily Watu list, the call app, and the reports — the same way
[hope-pmo-v2](https://github.com/samaritantechs/hope-pmo-v2) does it for Hope Microcredit,
whose architecture and code this project is built from.

**The specification is [`docs/HOOP-STARTER.md`](docs/HOOP-STARTER.md).** Read it first —
it carries the domain, the Hope→Hoop mapping, the schema, the importer spec, the build plan,
and the standing rules.

## Status

Seeded and awaiting the presentation build (starter §3). In this repo now:

- `docs/HOOP-STARTER.md` — the full specification
- `db/schema.sql` — v1 schema. **Run it once**: Supabase Dashboard → SQL Editor → paste the
  whole file → Run. Idempotent (safe to re-run).
- `db/seed.sql` — first admin access code + the `SYSTEM_OPEN` gate. **Change the
  `CHANGE-ME-1234` code first**, then run it the same way, after the schema.
- `public/index.html` — placeholder page so the first deploy shows something
- `api/health.js` — `GET /api/health`, proves the serverless layer is alive
- `test/` — `npm test` is the acceptance gate from day one

## Setup

1. Supabase: run `db/schema.sql` in the SQL editor.
2. Vercel: import this repo, set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
   (see `.env.example` for where each comes from). No build step — pages are served as
   written from `public/`, server logic lives in `api/`.

## Standing rules

Carried over from hope-pmo-v2 — conditions, not preferences:

1. Additive only, whole files. Never destroy working behaviour.
2. `npm test` is the acceptance gate.
3. Server logic in `api/_lib/`; pages served as written from `public/` — no build step.
4. Team (RSM/shop) scoping at the database, not in the page.
5. The Postgres budget: every change states its round trips, row bounds, and whether reads
   were shared (see hope-pmo-v2 `ARCHITECTURE.md § the Postgres budget`).
6. PostgREST silently caps reads at 1000 rows — use the `fetchAll`/`rpcAll` pattern.
7. An upsert updates exactly the columns in the payload — to preserve a value, don't mention it.
8. EAT clock (UTC+3) everywhere.
9. Deploy after every fix.
