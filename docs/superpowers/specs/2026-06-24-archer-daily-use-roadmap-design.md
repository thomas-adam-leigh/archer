# Archer — "Functional for Daily Use" Roadmap

**Date:** 2026-06-24
**Status:** Design / for review (pre-Linear)
**Source:** Notion "Archer next steps and scope" (2026-06-24) + current architecture audit

## Goal

Move Archer from "onboarding complete, backend built, pipeline runs on fixtures" to
**actually working every weekday for daily use**: it collects real jobs on a schedule,
shows the candidate only the opportunities worth their attention, and (eventually) applies
on their behalf.

This is **three parallel workstreams**, not one milestone. They are decoupled: ① and ③ are
fully buildable and testable today on fixture data and the "not integrated" path, with **no
real scraping required**. ② is what makes the data real, and is the only externally-gated /
higher-risk track.

## Current architecture (what already exists — do not rebuild)

- **Scheduler exists.** `packages/db/supabase/migrations/20260620180000_event_engine.sql`:
  pg_cron `archer-collect-daily` (`0 13 * * 1-5`) → `archer_cron_collect()` → POSTs
  `/commands/collect/{board}` **for integrated boards only**; `archer-match-minute` (`* * * * *`)
  → `archer_cron_match()`.
- **Dedup already enforced by schema.** `postings` unique `(board_slug, url)` and
  `(board_slug, external_id)`; `companies` unique `normalized_name`; `candidacies` unique
  `(user_id, posting_id)`. Upserts use `on conflict … do update`. So "same job matched by
  several of my 5 titles" and "same company posts again months later" are **already handled**.
  Only cross-board `content_hash` dedup is deferred.
- **Boards table exists.** `boards(slug, collect_status, apply_status, cred_env_prefix, …)`,
  `integration_status` enum = `not_integrated | in_progress | integrated | broken`. Seeded:
  `pnet`, `careerjunction`, `careerjet`.
- **CLI pipeline exists** (`services/cli`): `collect → match → enrich → cover-letter → apply /
  external-fill`, all wired to the DB. Board adapters are **stubbed** (`careerjunction.ts`
  throws `NotIntegratedError`); everything runs on `--fixture`.
- **API surface exists** (`services/api/src/app.ts`): `/jobs`, `/activities`,
  `/cover-letters/{run,submit,spoken-note}`, proposal `decide/self`, `/profile/*`, `/titles`,
  `/criteria`, `/accounts/state`, the AG-UI run loop, and the `/commands/*` triggers.
- **Status machine exists** end-to-end: candidacy `new → dismissed | shortlisted |
  alternative_outreach → awaiting_cover_letter → drafting → in_review → approved → applying →
  applied | external_pending | application_failed`; company `new → researching → enriched |
  enrichment_failed`; versioned profiles & cover letters with a proposal/approval substrate.

### Deltas between intent (the note) and reality

| Intent | Today | Work |
|---|---|---|
| Run ~11:00 (local), maybe staggered/chained | 13:00 UTC, single shot | adjust schedule + cadence |
| **One title at a time**, multiple triggers | all active titles in one CLI call | per-(board×title) fan-out |
| Non-integrated boards **still run + report "not integrated"** | only integrated boards fire; `NotIntegratedError` → a *failed* activity | enqueue all boards; "not integrated" = a clean, distinct outcome (not failure-noise) |
| Visibly "doing → done", failures reported | `failActivity` exists; no clean run surface | formalize a visible daily-run trail |
| Smart dedup | already enforced by schema | verify with tests; decide cross-board `content_hash` now vs later |
| Jobs UI shows only shortlisted/alt-outreach | dashboard is a hardcoded skeleton | build the dashboard (③) |

---

## Workstream ① — Milestone "Daily Run Activation"

**Home:** reopen the **Job Collection & Matching** project; add this as a new milestone.
**Why first:** lowest risk, unblocks everything, fully testable on fixtures + the not-integrated
path. **No scraping needed.**

**Open decision to confirm:** "11:00" timezone. Assume **11:00 SAST (UTC+2) = 09:00 UTC** unless
told otherwise.

### Issues

1. **Reschedule + choose cadence.** Move `archer-collect-daily` to the intended local time.
   Decide single daily trigger with internal fan-out (recommended — simpler) vs. N staggered
   cron entries per board. *Done when:* cron fires at the right local time; cadence documented.
2. **Per-(board × title) fan-out, today-only.** A daily run issues one collect per
   `(board, active title)` rather than one call with all titles, to spread load / reduce
   detection. Enforce "jobs posted today only." *Done when:* a run produces one scrape attempt
   per (board,title); "today only" honored; inter-attempt spacing in place.
3. **"Not integrated" as a clean outcome.** `archer_cron_collect()` enqueues **all** boards
   (not just integrated); a non-integrated board records a **distinct, non-error** activity
   (e.g. `succeeded` + `detail.outcome='not_integrated'`) instead of a `failed` row. *Done when:*
   collecting a stubbed board shows "CareerJunction — not integrated yet", not an error.
4. **Failure & terminal-state reporting.** Distinguish the terminal outcomes — `found N`,
   `nothing posted today`, `not_integrated`, `failed (reason)` — each represented cleanly in
   `activities` with a useful `error`/`detail`. *Done when:* each outcome is queryable + distinct.
5. **Dedup verification (+ decision on cross-board).** Tests proving: same job via two titles →
   one posting; same company across postings → one company; re-collect is idempotent. Decide
   whether to pull cross-board `content_hash` dedup forward now. *Done when:* tests green; dedup
   behavior documented.
6. **Daily-run trail for the UI.** Shape the activities a run emits (optionally a per-run
   rollup) so the dashboard can render "Archer collected today: 6 new jobs across 3 boards;
   CareerJunction not integrated." *Done when:* `/activities` tells a coherent daily-run story.

---

## Workstream ② — Project "Board Integration" (new)

**Scope:** the real scraping. TS-first, **Decodo residential proxy, never headless**, undetectable.
Per the note: if TS bot-detection proves unwinnable on the server, fall back to a separate
Python project later. **Built last / in parallel — externally gated (live board access,
bot detection).**

### Milestones

- **M0 — Scraping harness foundation.** Build the shared, board-agnostic substrate once:
  Patchright/Playwright (TS) browser session, Decodo proxy wiring, non-headless/VNC,
  anti-detection posture, creds from `.env` via `boards.cred_env_prefix`, session reuse.
  *(Cross-cutting — avoids re-solving stealth per board.)*
- **M1 — CareerJunction · Collect.** Issues, per the note's recipe: map login selectors with
  Chrome DevTools; log in with `.env` creds; implement search (one title at a time, today-only,
  with office/hybrid/remote filter); map result cards → `ScrapedPosting`; wire into the adapter
  contract; verify rows via Supabase MCP; flip `collect_status` `not_integrated → in_progress →
  integrated`. *Done when:* a live run writes real CareerJunction postings + candidacies.
- **M2 — CareerJunction · Apply (+ external redirect).** Open the job URL; confirm still logged
  in; detect apply type (easy-apply / paste-cover-letter-and-submit / cover-letter-required /
  external redirect); on-board apply uses the **approved** cover letter → candidacy `applied`;
  external redirect → save to `external_application_forms` (pending), candidacy `external_pending`;
  flip `apply_status → integrated`. *Done when:* a real on-board apply succeeds and a redirect is
  captured.
- **M3 — CareerJet · Collect.** Same collect recipe.
- **M4 — PNET · Collect.** Same collect recipe.

*(Apply for CareerJet/PNET deferred until after CareerJunction proves the pattern.)*

---

## Workstream ③ — Project "Web App — Daily Dashboard" (new)

**Scope:** the post-onboarding cockpit in `apps/web`. Routes for **jobs / companies / profile /
cover letters**. **The jobs view shows only `shortlisted` + `alternative_outreach`** — never
`new`, never `dismissed` ("that's demotivating"). Reuse the ARC-129 AG-UI review→revise loop for
cover letters. Each milestone ships a **Cypress E2E test** (matching the Web App Onboarding
project's convention). **Buildable in parallel on fixture-produced candidacies — no scraping
dependency.**

### Backend read-endpoint gaps (a sub-track; small)

These exist in the DB but have no candidate read path yet — needed by the UI:
`GET /companies` + `GET /companies/{id}`; cover-letter read (`GET /cover-letters/...` + version
history); candidacy/posting detail; `GET /boards` (integration status); external-form state.

### Milestones

- **M1 — Home + activity (replace the hardcoded skeleton).** Real `/activities` feed, real next
  run, real board integration status (`GET /boards`), live titles/criteria. *(Most visible; also
  the surface ① produces.)*
- **M2 — Jobs route.** Feed filtered to `shortlisted` + `alternative_outreach`; job detail
  (posting + why-matched + company summary). Optional pipeline/Kanban view.
- **M3 — Cover letters route.** The **review → revise → approve loop** on web (reuse ARC-129),
  version history, spoken-note (TTS) playback. The one human gate before applying.
- **M4 — Companies route.** List / Kanban by enrichment status; company detail + contacts.
- **M5 — Profile route.** View live profile, version history, edit preferences (endpoints mostly
  exist).
- **Sub-track — backend read endpoints** (above), landed just-in-time per consuming milestone.

**Deferred (explicitly out of scope now):** "how many jobs did Archer dismiss and why /
industry insights / resume-improvement" analytics — revisit after the system has run for a while.

---

## Sequencing

1. **① Daily Run Activation** — first (confirmed). Make the heartbeat correct + observable.
2. **③ Web App — Daily Dashboard** — in parallel (visible value on fixture data).
3. **② Board Integration** — last / overlapping; the riskiest, externally-gated track.

## Linear mapping (what gets created on approval)

- **Reopen** project *Job Collection & Matching* → add milestone **Daily Run Activation** (6 issues).
- **New** project *Board Integration* → milestones **M0–M4** with the per-board recipe issues.
- **New** project *Web App — Daily Dashboard* → milestones **M1–M5** + read-endpoint sub-track,
  each with a Cypress E2E test.

## Open questions for the user

1. **"11:00" timezone** — SAST (→09:00 UTC) assumed. Confirm.
2. **Cross-board `content_hash` dedup** — pull forward into ①, or leave deferred?
3. **Cadence** — single daily trigger with internal fan-out (recommended) vs. staggered
   per-board cron entries (the old 08:00/08:15/08:30 idea)?
