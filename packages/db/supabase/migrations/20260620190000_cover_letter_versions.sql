/**
* COVER-LETTER VERSIONS — whole-version history per candidacy (the approvable unit).
*
* The cover letter is the only thing Archer puts in front of an employer in the
* candidate's name, so it is drafted, reviewed and approved as a versioned unit —
* mirroring the profile version model (20260620150000_archer_profile_spine.sql):
*   - cover_letter_versions: one whole submitted draft per row, scoped to a
*     candidacy. version_no is a per-candidacy monotonic ordinal so versions cycle
*     and roll back in a stable order; the one row with status='approved' per
*     candidacy is the "active" version (a partial unique index enforces it).
*   - content holds the assembled letter; details jsonb carries the long tail
*     (the Scribe's provenance, the spoken-note artifact ref, etc.).
*
* Conventions match archer_core / archer_profile_spine: typed enum, the shared
* public.set_updated_at() trigger, query indexes, and RLS "own rows only" for
* authenticated reads keyed on auth.uid(). The agent writes versions via the
* service role (which bypasses RLS), so the table exposes reads only.
*
* Scope (ARC-14): the schema + the active-version pointer. The proposal-driven
* approve / edit / reject loop and the Scribe draft-assembly path land later in
* the Applications project (they consume this table, they do not change it).
*/

-- ============================================================================
-- Enum — a version's lifecycle, mirroring profile_version_status. A draft is
-- proposed for approval; on approve it becomes the active version (the prior
-- active one is superseded); reject/rollback let the user cycle between versions.
-- ============================================================================
create type public.cover_letter_version_status as enum (
  'draft', 'proposed', 'approved', 'rejected', 'superseded'
);

-- ============================================================================
-- cover_letter_versions — a whole cover-letter draft per candidacy (the
-- approvable unit). user_id is carried directly (not just via the candidacy) so
-- RLS keys on auth.uid() without a join, matching the profile spine tables.
-- ============================================================================
create table public.cover_letter_versions (
  id uuid primary key default gen_random_uuid(),
  candidacy_id uuid not null references public.candidacies (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  version_no int not null,
  status public.cover_letter_version_status not null default 'draft',
  label text,
  content text not null default '',
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (candidacy_id, version_no)
);
create index cover_letter_versions_candidacy_id_idx on public.cover_letter_versions (candidacy_id);
create index cover_letter_versions_user_id_idx on public.cover_letter_versions (user_id);
create index cover_letter_versions_candidacy_status_idx
  on public.cover_letter_versions (candidacy_id, status);
-- At most one active (approved) version per candidacy — setActive flips the prior
-- approved row to 'superseded' as it approves a new one (cycle/rollback).
create unique index cover_letter_versions_one_active_idx
  on public.cover_letter_versions (candidacy_id)
  where status = 'approved';

-- ============================================================================
-- updated_at trigger
-- ============================================================================
create trigger set_cover_letter_versions_updated_at before update on public.cover_letter_versions
  for each row execute function public.set_updated_at();

-- ============================================================================
-- Row-Level Security — own rows only (reads). The agent assembles and approves
-- versions via the service role (which bypasses RLS), so no write policy is
-- needed; authenticated users only ever read their own cover-letter versions.
-- ============================================================================
alter table public.cover_letter_versions enable row level security;
create policy "Can view own cover letter versions." on public.cover_letter_versions
  for select to authenticated using ((select auth.uid()) = user_id);
