/**
* ARCHER INTERACTION SCHEMA — the AG-UI conversation spine.
*
* Adds the interaction layer on top of archer_core: the durable tables every
* client plugs into over the AG-UI contract. Models the run lifecycle from
* docs/docs/ag-ui/ (RunStarted -> step/text/tool-call/state events -> RunFinished):
*   - threads: one per-user conversation; the unit clients subscribe to.
*   - runs: one AG-UI run per row; parent_run_id carries resume/branch lineage.
*   - events: the ordered, append-only AG-UI event log (the replayable source of truth).
*   - messages: chat turns incl. activity + reasoning roles (the tier-2 corpus).
*   - thread_state: the thread's shared state object (StateSnapshot / JSON-Patch target).
*
* Conventions match 20260619101500_archer_core.sql: typed enums, the shared
* public.set_updated_at() trigger, query indexes, and RLS "own rows only" for
* authenticated users (reads keyed on auth.uid() via the owning thread), with
* system writes left to the service role (which bypasses RLS). The approval
* substrate reuses the existing public.proposals table — no new table here.
*/

-- ============================================================================
-- Enums — the AG-UI vocabulary
-- ============================================================================

-- A run's terminal/active state. AG-UI runs start running and end completed
-- (RunFinished{outcome:success}), interrupted (RunFinished{outcome:interrupt}),
-- or error (RunError).
create type public.run_status as enum ('running', 'completed', 'interrupted', 'error');

-- The AG-UI event types (concepts/02-events.md): lifecycle, text message, tool
-- call, state management, activity, reasoning, and special events.
create type public.event_type as enum (
  'run_started', 'run_finished', 'run_error',
  'step_started', 'step_finished',
  'text_message_start', 'text_message_content', 'text_message_end', 'text_message_chunk',
  'tool_call_start', 'tool_call_args', 'tool_call_end', 'tool_call_chunk', 'tool_call_result',
  'state_snapshot', 'state_delta', 'messages_snapshot',
  'activity_snapshot', 'activity_delta',
  'reasoning_start', 'reasoning_message', 'reasoning_end',
  'raw', 'custom'
);

-- Message roles (concepts/05-messages.md), incl. activity + reasoning.
create type public.message_role as enum (
  'user', 'assistant', 'system', 'developer', 'tool', 'reasoning', 'activity'
);

-- ============================================================================
-- threads — one per-user conversation (the subscription unit)
-- ============================================================================
create table public.threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index threads_user_id_idx on public.threads (user_id);

-- ============================================================================
-- thread_state — the thread's shared state object (1:1 with a thread).
-- StateSnapshot replaces it; StateDelta applies an RFC-6902 JSON-Patch to it.
-- ============================================================================
create table public.thread_state (
  thread_id uuid primary key references public.threads (id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- runs — one AG-UI run per row. parent_run_id self-references for resume/branch
-- lineage (a resume starts a NEW run whose parent is the interrupted one).
-- ============================================================================
create table public.runs (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads (id) on delete cascade,
  parent_run_id uuid references public.runs (id) on delete set null,
  status public.run_status not null default 'running',
  input jsonb,
  outcome jsonb,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index runs_thread_id_idx on public.runs (thread_id);
create index runs_parent_run_id_idx on public.runs (parent_run_id);

-- ============================================================================
-- events — the ordered, append-only AG-UI event log. seq is a per-run monotonic
-- ordinal; (run_id, seq) is unique so replay and ordering are deterministic.
-- Append-only: no updated_at.
-- ============================================================================
create table public.events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.runs (id) on delete cascade,
  thread_id uuid not null references public.threads (id) on delete cascade,
  seq bigint not null,
  type public.event_type not null,
  data jsonb,
  created_at timestamptz not null default now()
);
create unique index events_run_seq_key on public.events (run_id, seq);
create index events_thread_id_idx on public.events (thread_id);

-- ============================================================================
-- messages — chat turns (incl. activity + reasoning), the tier-2 corpus the
-- Scribe later searches. run_id is nullable (a message can outlive its run).
-- ============================================================================
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads (id) on delete cascade,
  run_id uuid references public.runs (id) on delete set null,
  role public.message_role not null,
  content text,
  name text,
  tool_call_id text,
  tool_calls jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index messages_thread_id_idx on public.messages (thread_id);
create index messages_run_id_idx on public.messages (run_id);

-- ============================================================================
-- updated_at triggers (events is append-only, so it has none)
-- ============================================================================
create trigger set_threads_updated_at before update on public.threads
  for each row execute function public.set_updated_at();
create trigger set_thread_state_updated_at before update on public.thread_state
  for each row execute function public.set_updated_at();
create trigger set_runs_updated_at before update on public.runs
  for each row execute function public.set_updated_at();
create trigger set_messages_updated_at before update on public.messages
  for each row execute function public.set_updated_at();

-- ============================================================================
-- Row-Level Security — own rows only (reads); system writes are service-role.
-- threads own rows key directly on auth.uid(); child tables key through the
-- owning thread. service_role bypasses RLS, so no write policy is needed.
-- ============================================================================
alter table public.threads enable row level security;
create policy "Can view own threads." on public.threads
  for select to authenticated using ((select auth.uid()) = user_id);

alter table public.thread_state enable row level security;
create policy "Can view own thread state." on public.thread_state
  for select to authenticated using (
    exists (
      select 1 from public.threads t
      where t.id = thread_state.thread_id and t.user_id = (select auth.uid())
    )
  );

alter table public.runs enable row level security;
create policy "Can view own runs." on public.runs
  for select to authenticated using (
    exists (
      select 1 from public.threads t
      where t.id = runs.thread_id and t.user_id = (select auth.uid())
    )
  );

alter table public.events enable row level security;
create policy "Can view own events." on public.events
  for select to authenticated using (
    exists (
      select 1 from public.threads t
      where t.id = events.thread_id and t.user_id = (select auth.uid())
    )
  );

alter table public.messages enable row level security;
create policy "Can view own messages." on public.messages
  for select to authenticated using (
    exists (
      select 1 from public.threads t
      where t.id = messages.thread_id and t.user_id = (select auth.uid())
    )
  );
