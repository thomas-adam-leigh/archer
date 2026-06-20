/**
* ARCHER PROFILE SPINE — the candidate's structured tier-1 memory + version history.
*
* Adds the structured profile spine on top of archer_core's flat profiles row, plus
* whole-version history so a draft can be approved, cycled, and rolled back as a unit.
* From docs/Archer-Terminology-and-Architecture.md (structured spine + jsonb flesh):
*   - profile_versions: a whole submitted draft. The approvable/rollback unit; the one
*     row with status='approved' per user is "live" (a partial unique index enforces it).
*   - spine tables (work_experiences, projects, certifications, courses, skills,
*     education): one row per item, carrying typed canonical columns + a details jsonb
*     for the long tail. Each is BOTH user-scoped (user_id, for RLS) and version-scoped
*     (version_id), so the live profile = the spine rows of the approved version.
*   - profiles.attributes: evolving profile-wide jsonb (ideal_job + why, ai_fluency,
*     your-story, Otta-style prompts) for the live profile; each version snapshots its
*     own attributes so a rollback restores them.
*
* Conventions match 20260619101500_archer_core.sql / 20260620090000_archer_interaction.sql:
* typed enums, the shared public.set_updated_at() trigger, query indexes, and RLS
* "own rows only" for authenticated reads keyed on auth.uid(). The apply executor
* materialises approved versions via the service role (which bypasses RLS), so the
* spine tables expose reads only — system writes need no policy.
*/

-- ============================================================================
-- Enum — a version's lifecycle. A draft is proposed for approval; on approve it
-- becomes the live version (the prior live one is superseded); reject/rollback
-- let the user cycle between versions.
-- ============================================================================
create type public.profile_version_status as enum (
  'draft', 'proposed', 'approved', 'rejected', 'superseded'
);

-- ============================================================================
-- profile_versions — a whole submitted profile draft (the approvable unit).
-- version_no is a per-user monotonic ordinal (unique per user); attributes
-- snapshots the profile-wide jsonb at this version so a rollback restores it.
-- ============================================================================
create table public.profile_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  version_no int not null,
  status public.profile_version_status not null default 'draft',
  label text,
  attributes jsonb not null default '{}'::jsonb,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, version_no)
);
create index profile_versions_user_id_idx on public.profile_versions (user_id);
create index profile_versions_user_status_idx on public.profile_versions (user_id, status);
-- At most one live (approved) version per user — the apply executor flips the
-- prior approved row to 'superseded' as it approves a new one (cycle/rollback).
create unique index profile_versions_one_live_idx on public.profile_versions (user_id)
  where status = 'approved';

-- ============================================================================
-- profiles — extend the flat archer_core row with the live profile-wide jsonb.
-- "Which version is live" is the profile_versions row with status='approved'.
-- ============================================================================
alter table public.profiles
  add column attributes jsonb not null default '{}'::jsonb;

-- ============================================================================
-- Spine tables — one row per item. Each carries user_id (RLS) + version_id
-- (version scoping) + typed canonical columns + a details jsonb for the long tail.
-- ============================================================================

-- WORK_EXPERIENCES — roles held.
create table public.work_experiences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  version_id uuid not null references public.profile_versions (id) on delete cascade,
  title text not null,
  organization text,
  employment_type text,
  location text,
  start_date date,
  end_date date,
  is_current boolean not null default false,
  description text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index work_experiences_user_id_idx on public.work_experiences (user_id);
create index work_experiences_version_id_idx on public.work_experiences (version_id);

-- PROJECTS — portfolio / side projects.
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  version_id uuid not null references public.profile_versions (id) on delete cascade,
  name text not null,
  role text,
  url text,
  start_date date,
  end_date date,
  description text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index projects_user_id_idx on public.projects (user_id);
create index projects_version_id_idx on public.projects (version_id);

-- CERTIFICATIONS — professional certifications.
create table public.certifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  version_id uuid not null references public.profile_versions (id) on delete cascade,
  name text not null,
  issuer text,
  issued_on date,
  expires_on date,
  credential_id text,
  url text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index certifications_user_id_idx on public.certifications (user_id);
create index certifications_version_id_idx on public.certifications (version_id);

-- COURSES — completed courses / training.
create table public.courses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  version_id uuid not null references public.profile_versions (id) on delete cascade,
  name text not null,
  provider text,
  completed_on date,
  url text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index courses_user_id_idx on public.courses (user_id);
create index courses_version_id_idx on public.courses (version_id);

-- SKILLS — discrete skills the Matchmaker reads.
create table public.skills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  version_id uuid not null references public.profile_versions (id) on delete cascade,
  name text not null,
  category text,
  proficiency text,
  years_experience int,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index skills_user_id_idx on public.skills (user_id);
create index skills_version_id_idx on public.skills (version_id);

-- EDUCATION — formal education.
create table public.education (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  version_id uuid not null references public.profile_versions (id) on delete cascade,
  institution text not null,
  degree text,
  field_of_study text,
  start_date date,
  end_date date,
  grade text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index education_user_id_idx on public.education (user_id);
create index education_version_id_idx on public.education (version_id);

-- ============================================================================
-- updated_at triggers
-- ============================================================================
create trigger set_profile_versions_updated_at before update on public.profile_versions
  for each row execute function public.set_updated_at();
create trigger set_work_experiences_updated_at before update on public.work_experiences
  for each row execute function public.set_updated_at();
create trigger set_projects_updated_at before update on public.projects
  for each row execute function public.set_updated_at();
create trigger set_certifications_updated_at before update on public.certifications
  for each row execute function public.set_updated_at();
create trigger set_courses_updated_at before update on public.courses
  for each row execute function public.set_updated_at();
create trigger set_skills_updated_at before update on public.skills
  for each row execute function public.set_updated_at();
create trigger set_education_updated_at before update on public.education
  for each row execute function public.set_updated_at();

-- ============================================================================
-- Row-Level Security — own rows only (reads). The apply executor materialises
-- versions via the service role (which bypasses RLS), so no write policy is
-- needed; authenticated users only ever read their own spine.
-- ============================================================================
alter table public.profile_versions enable row level security;
create policy "Can view own profile versions." on public.profile_versions
  for select to authenticated using ((select auth.uid()) = user_id);

alter table public.work_experiences enable row level security;
create policy "Can view own work experiences." on public.work_experiences
  for select to authenticated using ((select auth.uid()) = user_id);

alter table public.projects enable row level security;
create policy "Can view own projects." on public.projects
  for select to authenticated using ((select auth.uid()) = user_id);

alter table public.certifications enable row level security;
create policy "Can view own certifications." on public.certifications
  for select to authenticated using ((select auth.uid()) = user_id);

alter table public.courses enable row level security;
create policy "Can view own courses." on public.courses
  for select to authenticated using ((select auth.uid()) = user_id);

alter table public.skills enable row level security;
create policy "Can view own skills." on public.skills
  for select to authenticated using ((select auth.uid()) = user_id);

alter table public.education enable row level security;
create policy "Can view own education." on public.education
  for select to authenticated using ((select auth.uid()) = user_id);
