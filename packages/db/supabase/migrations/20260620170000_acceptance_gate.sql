/**
* ACCEPTANCE GATE — the account/membership lifecycle + the owner's ≤24h review.
*
* The first of Archer's three human gates (ARC-31). A candidate onboards, builds a
* profile, then SUBMITS for review; an owner (service role / admin) ACCEPTS or
* REJECTS with a note within ~24h, judging depth/sincerity/humanity — which also
* caps cost/abuse. Acceptance additionally requires a mechanical readiness check
* (1–5 target titles + ≥1 negative criterion + a complete-enough profile, i.e. an
* approved profile version); that check lives INSIDE acceptance, enforced by the
* apply path in queries.ts, not as a replacement for the human judgement.
*
* Downstream collect/match is gated on status = 'accepted' (enforced today in the
* API even though collect/match land in a later project).
*
* Conventions match 20260619101500_archer_core.sql: a typed enum, the shared
* public.set_updated_at() trigger, a query index, and RLS "own rows only" for
* authenticated reads keyed on auth.uid(). Lifecycle WRITES (submit, accept,
* reject) go through the service role (which bypasses RLS) via the API — there is
* deliberately no authenticated write policy, so a client can never flip its own
* status to 'accepted' directly; only the gated server path can.
*/

-- ============================================================================
-- Enum — the membership lifecycle. onboarding (default on first contact) →
-- submitted (user asks for review) → under_review (owner is judging) →
-- accepted | rejected (owner's terminal decision; a rejected user may resubmit).
-- ============================================================================
create type public.account_status as enum (
  'onboarding', 'submitted', 'under_review', 'accepted', 'rejected'
);

-- ============================================================================
-- accounts — one membership row per user. Provisioned just-in-time on first
-- submit (mirroring the just-in-time thread path), defaulting to 'onboarding'
-- for any user without a row. review_note carries the owner's accept/reject note.
-- ============================================================================
create table public.accounts (
  user_id uuid primary key references public.users (id) on delete cascade,
  status public.account_status not null default 'onboarding',
  submitted_at timestamptz,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index accounts_status_idx on public.accounts (status);

-- ============================================================================
-- updated_at trigger
-- ============================================================================
create trigger set_accounts_updated_at before update on public.accounts
  for each row execute function public.set_updated_at();

-- ============================================================================
-- Row-Level Security — own row only (reads). Lifecycle writes are service-role
-- only (the gated API path), so no authenticated insert/update policy exists.
-- ============================================================================
alter table public.accounts enable row level security;
create policy "Can view own account." on public.accounts
  for select to authenticated using ((select auth.uid()) = user_id);
