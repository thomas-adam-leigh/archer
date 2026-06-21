# Mobile Onboarding — build spec

The reference brief for the **Mobile Onboarding** Linear project (team `ARC`,
issues **ARC‑62 → ARC‑82**). The autonomous loop's `prompt.md` points here for the
full picture; Linear's per‑issue descriptions hold the precise acceptance criteria.

**Goal:** completely implement the candidate **onboarding** experience in the
**Lynx mobile app** (`apps/mobile`), from sign‑up up until the user is directed
*out* of onboarding to the home screen. Mobile only — web/desktop are deferred to a
separate future project.

---

## The journey (what we're building)

1. **Sign up → straight into onboarding.** Auth already works: GoTrue REST via Lynx's
   global `fetch` (`apps/mobile/src/lib/auth.ts`), session held in app state.
2. **Meet Archer** + two paths:
   > "Hi, I'm Archer. I'm here to help you find your next role. Before I can start
   > searching on your behalf, I need to understand who you are, what you've done, and
   > where you want to go."
   - **Upload my résumé**
   - **Start from scratch**
3. **Résumé path:** upload a PDF/DOCX → it's stored in a private Supabase Storage
   bucket → an agent ingests it (real extraction, **not** text‑paste) and reconstructs a
   **structured profile** (the spine: work experience, education, skills, certs,
   courses, projects — plus profile‑wide attributes). The user sees a **non‑interruptible
   processing** screen streaming live status ("Archer is reading your résumé / extracting
   your experience / building your profile") over Supabase Realtime. 30s–2min. Then the
   first **draft profile** appears.
4. **Review** the draft, rendered like a modern résumé (full name, contact, links,
   professional summary, work experience, education, courses & certifications, skills) →
   **Approve**, or give feedback ("Add more information" / "Change something" / "Improve
   this profile") by text **or voice** → Archer redrafts live → loop until approved.
5. **Job preferences:** Archer proposes ~5 target titles from the profile (e.g. *Senior
   Agentic AI Engineer, TypeScript Developer, Full‑Stack Engineer, AI Platform Engineer,
   Software Engineer*). Approve or give feedback (text/voice, e.g. "re‑rank these three")
   → live update → loop until approved. Also capture **≥1 rule‑out** (negative criterion).
6. **Start‑from‑scratch path:** instead of a résumé, a guided multi‑turn conversation
   (text + voicenote) where Archer asks about work, education, skills, interests, goals
   and titles, accreting the **same** structured profile — converging on the same review
   → preferences flow.
7. **Completion → home.** On approved profile **and** titles, onboarding is complete →
   the account is **submitted for the Acceptance Gate** (kept by design) → redirect to
   **home**, which reflects account status ("Archer is reviewing your profile / will start
   searching once you're accepted" → "Archer is searching…" once accepted). Onboarding is
   fully **resumable** — relaunching restores the exact step.

---

## What already exists (do NOT rebuild) vs the gaps

The backend (Completed projects, ARC‑26→61) already provides most of the contract:

**Built:**
- Profile **spine** + `profile_versions` (draft/proposed/approved, max 1 approved/user) —
  `packages/db/supabase/migrations/20260620150000_archer_profile_spine.sql`.
- AG‑UI substrate: `threads`/`runs`/`events`/`messages`/`thread_state`; **Realtime on
  `events`**; `GET /agui/threads/:id/history` restore — `20260620090000_archer_interaction.sql`.
- Endpoints: `GET /onboarding/state`, `POST /onboarding/run`, `POST /onboarding/resume`,
  `POST /onboarding/voicenote`, `POST /onboarding/proposals/:id/decide` (owner‑gated today),
  `/titles`, `/criteria`, `/accounts/*` (Acceptance Gate, ARC‑31) — `services/api/src/app.ts`.
- Real **STT** edge function (`packages/db/supabase/functions/transcribe`, audio never
  persisted). Real swappable **LLM** (OpenRouter/MiniMax via `@archer/llm`, `services/api/src/brain.ts`).

**Genuine gaps this project closes (the issues):**
- No `resumes` Storage bucket. Résumé extraction is a **stub** (`stubResumeExtractor` in
  `services/api/src/ingest.ts` returns empty) — needs real PDF/DOCX → text → LLM → spine.
- The profile‑decide route is **owner‑only**; the candidate must self‑approve their own draft.
- No LLM **job‑title suggestion**; no **resumable‑step** endpoint; `onboardingRun` is
  single‑shot (needs a **multi‑turn guided** run for start‑from‑scratch).
- The entire **Lynx client** for the flow above.

---

## Milestones & issues (ARC‑62 → ARC‑82, dependency‑wired)

1. **Backend: résumé ingestion → streamed run → proposed profile** — `ARC‑62` bucket+RLS ·
   `ARC‑63` PDF/DOCX text extraction · `ARC‑64` LLM structuring → attributes **+ spine** ·
   `ARC‑65` wrap as a 3‑phase streamed AG‑UI run.
2. **Backend: onboarding state · self‑approval · titles · completion** — `ARC‑66`
   `/onboarding/progress` · `ARC‑67` candidate self‑approval · `ARC‑68` LLM title suggestion ·
   `ARC‑69` completion → Acceptance Gate.
3. **Mobile foundation** — `ARC‑70` API client + persistent session · `ARC‑71` AG‑UI/Realtime
   consumer + history restore · `ARC‑72` voice input (→ `/transcribe`) · `ARC‑73` router + intro.
4. **Mobile: résumé upload → processing → draft** — `ARC‑74` file picker + upload ·
   `ARC‑75` non‑interruptible streamed processing screen.
5. **Mobile: profile review + feedback loop** — `ARC‑76` resume‑style render · `ARC‑77`
   approve / redraft loop (text + voice).
6. **Mobile: job preferences** — `ARC‑78` suggested titles + approval loop + capture a rule‑out.
7. **Mobile: conversational "start from scratch"** — `ARC‑79` backend guided multi‑turn run ·
   `ARC‑80` chat UI (text + voicenote), converges on the shared review.
8. **Mobile: completion → home + resumability** — `ARC‑81` account‑status‑aware home ·
   `ARC‑82` restore exact step across restarts.

**Start here (unblocked roots):** `ARC‑62`, `ARC‑66`, `ARC‑67`, `ARC‑70`. Backend (ARC‑62→69,
79) is fully CI‑gated; the mobile issues are verified locally (see below).

---

## Decisions (locked)

- **Keep the Acceptance Gate (ARC‑31).** Completion submits the account for the owner's
  ≤24h review; background search starts only once `accepted`. Onboarding's job ends at
  "submitted → home", not at live search.
- **Résumé ingestion = server‑side extraction via the existing OpenRouter integration,
  wrapped in a streamed AG‑UI run** (no separate Claude‑on‑server). The client streams
  status over Realtime on `events`, then lands on a proposed `profile_version`.
- **PDF first** (DOCX if clean). **Both paths**, résumé path first; the conversational path
  reuses the same review → preferences flow.
- **Candidate self‑approval** of the onboarding draft is the candidate's own action, distinct
  from the owner Acceptance Gate.

---

## Building & verifying the Lynx app (important)

`apps/mobile` is **ReactLynx + Rspeedy** and is **excluded from the root pnpm workspace**
(see `pnpm-workspace.yaml`, `biome.json`, `vitest.config.ts`). It is **not** covered by the
root CI pipeline. Consequences for the loop:

- Install/build/verify mobile work **standalone**, from `apps/mobile`:
  ```sh
  cd apps/mobile
  pnpm install --ignore-workspace   # uses apps/mobile/pnpm-lock.yaml (committed)
  pnpm check                         # biome
  pnpm build                         # rspeedy build — must succeed
  pnpm test                          # vitest (jsdom)
  ```
  A mobile‑only PR's `ci-ok` passes trivially (root CI ignores `apps/mobile`), so **the
  loop MUST run the above locally before merging a mobile issue** — that is the gate.
- **Lynx quirks** (already in the codebase): primitives are `<view>`/`<text>` not
  `<div>`; inputs are uncontrolled — track via `bindinput` + `e.detail.value` (no `value`
  prop); taps via `bindtap`. Dual‑thread runtime → **no `window`/`localStorage`/DOM**; use
  Lynx‑compatible storage for the persisted session. Auth talks GoTrue REST via the global
  `fetch` (not `@supabase/supabase-js`). Config via `import.meta.env.PUBLIC_*`.
- **Never commit** `apps/mobile/.env` (secrets), `node_modules`, `dist`, or the `ios/`
  native dir. Backend issues that touch the schema still follow the normal migration +
  drift‑gate + CI‑green‑merge path.

---

## Client integration contract

See `docs/CLIENT-INTEGRATION.md` for the full contract. In short: the client authenticates
with Supabase (GoTrue), reads its own rows directly under RLS, calls the `/transcribe` edge
function with the user's JWT, drives agent work via the `/onboarding/*` + `/agui/*` routes,
and subscribes to **Supabase Realtime on `events`** (per‑thread) for live status, reconciling
with `GET /agui/threads/:id/history` on reconnect.

## Out of scope (this project)

Approvals inbox, jobs feed, cover‑letter review, full profile/version management, and the
live mission view are **later** mobile surfaces (separate future projects). **Mobile app
deployment** (a Komodo/host build target for the Lynx bundle) is a separate, deferred infra
task — it is **not** part of this feature build and the loop must not attempt it.
