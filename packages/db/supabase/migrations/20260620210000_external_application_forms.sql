/**
* EXTERNAL APPLICATION FORMS — the off-board redirect record (ARC-41).
*
* The apply step lands in one of three places (see services/cli apply adapter):
* an on-board submission (→ applied), a structured failure (→ application_failed),
* or an OFF-BOARD REDIRECT — the board bounces the candidate to an external site
* whose form Archer must complete. This table is that redirect's durable record:
* one row per redirected application, carrying the URL and walking its own status
*   pending → in_progress → completed | failed
* as the external-fill agent works it (the `external_fill` Activity, browser work
* stubbed). The candidacy moves external_pending → applied | application_failed in
* lock-step (see the status machine in apply / external-fill orchestration).
*
* The redirect is raised from an Apply Activity: it inserts the pending row here,
* opens an owner-facing proposal carrying the URL (the agent→owner control channel),
* and pushes a notification — then the candidacy entering external_pending webhooks
* the API (20260620180000_event_engine.sql) to wake the external-fill path.
*
* Conventions match archer_core / cover_letter_versions: a typed status enum, the
* shared public.set_updated_at() trigger, query indexes, and RLS "own rows only"
* for authenticated reads keyed on auth.uid(). The agent writes via the service
* role (which bypasses RLS), so the table exposes reads only.
*/

-- ============================================================================
-- Enum — the form's lifecycle. A redirect inserts a `pending` row; the
-- external-fill Activity flips it to `in_progress` while it works, then to
-- `completed` (application submitted) or `failed` (could not be completed).
-- ============================================================================
create type public.external_form_status as enum (
  'pending', 'in_progress', 'completed', 'failed'
);

-- ============================================================================
-- external_application_forms — one off-board application form per redirect.
-- user_id is carried directly (not just via the candidacy) so RLS keys on
-- auth.uid() without a join, matching the cover_letter_versions table.
-- ============================================================================
create table public.external_application_forms (
  id uuid primary key default gen_random_uuid(),
  candidacy_id uuid not null references public.candidacies (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  -- The approved letter the external form is filled from (provenance); kept even
  -- if that version is later superseded, so set null rather than cascade.
  cover_letter_version_id uuid references public.cover_letter_versions (id) on delete set null,
  url text not null,
  status public.external_form_status not null default 'pending',
  detail jsonb not null default '{}'::jsonb,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index external_application_forms_candidacy_id_idx
  on public.external_application_forms (candidacy_id);
create index external_application_forms_user_id_idx
  on public.external_application_forms (user_id);
create index external_application_forms_candidacy_status_idx
  on public.external_application_forms (candidacy_id, status);
-- At most one OPEN (pending/in_progress) form per candidacy — apply is the one
-- irreversible action, so a candidacy never has two live external forms at once.
create unique index external_application_forms_one_open_idx
  on public.external_application_forms (candidacy_id)
  where status in ('pending', 'in_progress');

-- ============================================================================
-- updated_at trigger
-- ============================================================================
create trigger set_external_application_forms_updated_at before update
  on public.external_application_forms
  for each row execute function public.set_updated_at();

-- ============================================================================
-- Row-Level Security — own rows only (reads). The agent inserts/updates forms
-- via the service role (which bypasses RLS), so no write policy is needed;
-- authenticated users only ever read their own external application forms.
-- ============================================================================
alter table public.external_application_forms enable row level security;
create policy "Can view own external application forms." on public.external_application_forms
  for select to authenticated using ((select auth.uid()) = user_id);
