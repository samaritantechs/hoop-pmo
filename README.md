# HOOP PMO

Follow-up system for **Hoop Ltd** — a phone dealership agent for Watu Credit (watu simu).
Hoop's credit team owns locked-phone customers for 45 days from disbursement; this system
gives them the daily Watu list, the call app, and the reports — built from
[hope-pmo-v2](https://github.com/samaritantechs/hope-pmo-v2), whose architecture and code
it reuses. **The specification is [`docs/HOOP-STARTER.md`](docs/HOOP-STARTER.md).**

## What is live

| Route | What |
|---|---|
| `/` | launcher |
| `/upload` | the daily Watu list (Excel/CSV, the 16 standard columns), sliced, batch-stamped |
| `/call` | **HOOP Calls** — credit team's app: the day's locked list scoped by team code, tap-to-call, follow-ups + promises, offline-tolerant, Ripoti for leaders |
| `/portal` | tiles (list, locked 7+, inside-45, calls, % reached), Ripoti, **Recovery** (upload-vs-upload: who paid / reconnected after our calls), Teams & codes, Staff on/off, access codes, settings, roadmap |
| `/api/health` | env sanity |

The day: upload the Watu file → phones pick it up (DATA_VERSION drops their caches) →
credit team calls → tomorrow's upload → Recovery shows what the calls bought.

## Setup (already done once)

1. Supabase: run `db/schema.sql`, then `db/seed.sql` (change the admin code first).
2. Vercel: import the repo, set `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`. No build step.
3. Portal → Teams: add teams, mint team codes; read a code to each caller over the phone.

## Standing rules — conditions, not preferences

1. Additive only, whole files. Never destroy working behaviour.
2. `npm test` is the acceptance gate (importer, call flow, portal — all against the fake
   PostgREST client in `test/fake-db.mjs`).
3. Server logic in `api/_lib/`; pages served as written from `public/` — no build step.
4. Team (RSM/shop) scoping at the database, not in the page.
5. **The Postgres budget** — every endpoint's header comment states its round trips
   (warm, the second handset), row bounds, and whether reads were shared. Forever.
6. PostgREST silently caps reads at 1000 rows — `fetchAll`/`rpcAll` everywhere.
7. An upsert updates exactly the columns in the payload — to preserve a value, don't
   mention it. (This is HOW an upload never erases an officer's promise.)
8. EAT clock (UTC+3) via `api/_lib/time.js`.
9. Deploy after every fix — push to `main`, Vercel auto-deploys.

## Where things live

- `api/_lib/supabase.js,time.js,parse.js,auth.js,passcode.js,system-gate.js,audit.js` —
  copied verbatim from hope-pmo-v2 (the proven layer).
- `api/_lib/importers.js` — the Watu importer: `13-Jul-26` dates, TRUE/FALSE booleans,
  IMEI as text end to end, team from the Shop column, header-presence rule.
- `api/_lib/call-core.js` — the HOOP Calls backend (Hope's, translated to the Watu book).
- `api/upload.js` / `api/call.js` / `api/portal.js` — the three doors.
- `db/schema.sql` — idempotent; verified against Postgres 16 before it ever reached
  Supabase. Phase 2/3 tables (sales audit watu×hoop, commissions, stock) are designed in
  comments there, not built.
