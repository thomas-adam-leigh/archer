/**
* ARCHER CORE SCHEMA — the contract for the tool layer.
*
* Models the choreographed state machine from docs/Archer-Terminology-and-Architecture.md:
*   - Shared objective tables (boards, companies, contacts, postings): facts, not
*     user-owned. Authenticated users read; only the service role (the CLI / agents) writes.
*   - Per-user state tables (profiles, target_titles, negative_criteria, candidacies,
*     notifications): carry user_id + RLS "own rows only".
*   - Execution & control (activities, proposals): the universal run primitive and the
*     agent->owner channel. The CI self-heal rails already POST here
*     (infra/komodo/scripts/record-deploy-activity.sh, infra/canary/file-proposal.sh).
*/

-- ============================================================================
-- Enums — the state-machine vocabulary (kanban columns = these values)
-- ============================================================================
create type public.integration_status as enum ('not_integrated', 'in_progress', 'integrated', 'broken');
create type public.work_mode as enum ('remote', 'hybrid', 'office', 'unknown');
create type public.company_status as enum ('new', 'researching', 'enriched', 'enrichment_failed');
create type public.triage_decision as enum ('shortlisted', 'alternative_outreach', 'dismissed');
create type public.candidacy_status as enum (
  'new', 'dismissed', 'shortlisted', 'alternative_outreach',
  'awaiting_cover_letter', 'drafting', 'in_review', 'approved',
  'applying', 'applied', 'external_pending', 'application_failed'
);
create type public.activity_type as enum (
  'collect', 'match', 'enrich', 'cover_letter', 'apply', 'external_fill',
  'proposal_exec', 'cli_repair', 'deploy'
);
create type public.activity_status as enum ('queued', 'in_progress', 'succeeded', 'failed');
create type public.proposal_status as enum ('submitted', 'approved', 'rejected', 'in_progress', 'completed', 'failed');

-- ============================================================================
-- Shared trigger function — keep updated_at honest
-- ============================================================================
create function public.set_updated_at()
returns trigger
set search_path = ''
as $$
  begin
    new.updated_at = now();
    return new;
  end;
$$ language plpgsql;

-- ============================================================================
-- Shared objective tables (no user_id; authenticated read, service role writes)
-- ============================================================================

-- BOARDS — the 3 job sites; the adapter registry. collect/apply integrate
-- independently (a board can collect before apply is built), which drives the
-- sprint-by-sprint integration of each adapter.
create table public.boards (
  slug text primary key,
  name text not null,
  base_url text not null,
  country text not null default 'ZA',
  collect_status public.integration_status not null default 'not_integrated',
  apply_status public.integration_status not null default 'not_integrated',
  cred_env_prefix text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- COMPANIES — employers. Created at collect time but gated at 'new' until a
-- linked candidacy is shortlisted (enrichment is deliberately deferred to save tokens).
create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  normalized_name text generated always as (lower(btrim(name))) stored,
  domain text,
  website_url text,
  linkedin_url text,
  description text,
  recruitment_email text,
  status public.company_status not null default 'new',
  enrichment jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index companies_normalized_name_key on public.companies (normalized_name);

-- CONTACTS — people on a company's team (phone omitted by design; all nullable).
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  full_name text not null,
  email text,
  linkedin_url text,
  role_title text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index contacts_company_id_idx on public.contacts (company_id);

-- POSTINGS — one deduplicated job ad. Within-board dedup is enforced; cross-board
-- merging is deferred (content_hash is here to enable it later without a schema change).
create table public.postings (
  id uuid primary key default gen_random_uuid(),
  board_slug text not null references public.boards (slug),
  external_id text,
  url text not null,
  title text not null,
  company_id uuid references public.companies (id) on delete set null,
  company_name_raw text,
  location text,
  work_mode public.work_mode not null default 'unknown',
  salary_raw text,
  description text,
  posted_on date,
  content_hash text,
  collected_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Idempotent collect: a job's URL is unique per board; external_id too when present.
create unique index postings_board_url_key on public.postings (board_slug, url);
create unique index postings_board_external_key on public.postings (board_slug, external_id)
  where external_id is not null;
create index postings_company_id_idx on public.postings (company_id);

-- ============================================================================
-- Per-user state tables (user_id + RLS own-rows-only)
-- ============================================================================

-- PROFILES — the maturing picture of the candidate. resume_text is what the
-- Matchmaker LLM reads; normalized work/skills/education tables come later.
create table public.profiles (
  user_id uuid primary key references public.users (id) on delete cascade,
  about text,
  location text,
  willing_remote boolean not null default true,
  work_pref public.work_mode not null default 'unknown',
  current_salary text,
  preferred_salary text,
  notice_period text,
  years_experience int,
  resume_url text,
  resume_text text,
  portfolio_url text,
  linkedin_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- TARGET_TITLES — the 1-5 roles a candidate searches under (the collect search keys).
create table public.target_titles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  title text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index target_titles_user_id_idx on public.target_titles (user_id);

-- NEGATIVE_CRITERIA — explicit disqualifiers (e.g. "no C#"), read by the Matchmaker.
create table public.negative_criteria (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  text text not null,
  created_at timestamptz not null default now()
);
create index negative_criteria_user_id_idx on public.negative_criteria (user_id);

-- CANDIDACIES — a specific candidate pursuing a specific posting. Carries the
-- jobs kanban. triage_decision/reason preserve provenance the status would erase.
create table public.candidacies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  posting_id uuid not null references public.postings (id) on delete cascade,
  status public.candidacy_status not null default 'new',
  triage_decision public.triage_decision,
  triage_reason text,
  match_score int,
  status_changed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, posting_id)
);
create index candidacies_user_status_idx on public.candidacies (user_id, status);
create index candidacies_posting_id_idx on public.candidacies (posting_id);

-- ============================================================================
-- Execution & control tables
-- ============================================================================

-- ACTIVITIES — the universal run primitive. Every unit of work (collect, match,
-- enrich, apply, external_fill, deploy, cli_repair) is one row with a status + log.
-- Subjects are typed nullable FKs (integrity over polymorphism). The CI deploy
-- rail inserts {type:'deploy', status, detail:{sha,actor,run_id}}.
create table public.activities (
  id uuid primary key default gen_random_uuid(),
  type public.activity_type not null,
  status public.activity_status not null default 'queued',
  user_id uuid references public.users (id) on delete cascade,
  board_slug text references public.boards (slug),
  posting_id uuid references public.postings (id) on delete set null,
  candidacy_id uuid references public.candidacies (id) on delete set null,
  company_id uuid references public.companies (id) on delete set null,
  detail jsonb,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index activities_type_status_idx on public.activities (type, status);
create index activities_user_id_idx on public.activities (user_id);

-- PROPOSALS — the agent->owner control channel (also drives the build). The canary
-- rail inserts {title, rationale, status:'submitted', plan:{...}}.
create table public.proposals (
  id uuid primary key default gen_random_uuid(),
  kind text,
  title text not null,
  rationale text,
  plan jsonb,
  status public.proposal_status not null default 'submitted',
  created_by text,
  candidacy_id uuid references public.candidacies (id) on delete set null,
  board_slug text references public.boards (slug),
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index proposals_status_idx on public.proposals (status);

-- NOTIFICATIONS — per-user pushes (cover-letter ready, proposal decided, etc.).
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  kind text not null default 'info',
  title text not null,
  body text,
  ref jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_id_idx on public.notifications (user_id);

-- ============================================================================
-- updated_at triggers
-- ============================================================================
create trigger set_boards_updated_at before update on public.boards
  for each row execute function public.set_updated_at();
create trigger set_companies_updated_at before update on public.companies
  for each row execute function public.set_updated_at();
create trigger set_contacts_updated_at before update on public.contacts
  for each row execute function public.set_updated_at();
create trigger set_postings_updated_at before update on public.postings
  for each row execute function public.set_updated_at();
create trigger set_profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();
create trigger set_candidacies_updated_at before update on public.candidacies
  for each row execute function public.set_updated_at();
create trigger set_activities_updated_at before update on public.activities
  for each row execute function public.set_updated_at();
create trigger set_proposals_updated_at before update on public.proposals
  for each row execute function public.set_updated_at();

-- ============================================================================
-- Row-Level Security
-- ============================================================================

-- Shared objective tables: authenticated users read; writes are service-role only
-- (service_role bypasses RLS, so no write policy is needed).
alter table public.boards enable row level security;
create policy "Authenticated can read boards." on public.boards
  for select to authenticated using (true);

alter table public.companies enable row level security;
create policy "Authenticated can read companies." on public.companies
  for select to authenticated using (true);

alter table public.contacts enable row level security;
create policy "Authenticated can read contacts." on public.contacts
  for select to authenticated using (true);

alter table public.postings enable row level security;
create policy "Authenticated can read postings." on public.postings
  for select to authenticated using (true);

-- Per-user tables: own rows only.
alter table public.profiles enable row level security;
create policy "Can view own profile." on public.profiles
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Can insert own profile." on public.profiles
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Can update own profile." on public.profiles
  for update to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

alter table public.target_titles enable row level security;
create policy "Can manage own target titles." on public.target_titles
  for all to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

alter table public.negative_criteria enable row level security;
create policy "Can manage own negative criteria." on public.negative_criteria
  for all to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

alter table public.candidacies enable row level security;
create policy "Can view own candidacies." on public.candidacies
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Can update own candidacies." on public.candidacies
  for update to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

alter table public.notifications enable row level security;
create policy "Can view own notifications." on public.notifications
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Can update own notifications." on public.notifications
  for update to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Per-user live view of activities (own rows). System/owner activities (null
-- user_id, e.g. deploy/collect) are reached via the service role / admin only.
alter table public.activities enable row level security;
create policy "Can view own activities." on public.activities
  for select to authenticated using ((select auth.uid()) = user_id);

-- Proposals are owner/admin-facing: RLS on, no authenticated policy (service role only).
alter table public.proposals enable row level security;

-- ============================================================================
-- Seed — the 3 boards, both capabilities not integrated (sprint-by-sprint).
-- ============================================================================
insert into public.boards (slug, name, base_url, cred_env_prefix) values
  ('pnet', 'PNET', 'https://www.pnet.co.za', 'PNET'),
  ('careerjunction', 'CareerJunction', 'https://www.careerjunction.co.za', 'CAREERJUNCTION'),
  ('careerjet', 'CareerJet', 'https://www.careerjet.co.za', 'CAREERJET');
