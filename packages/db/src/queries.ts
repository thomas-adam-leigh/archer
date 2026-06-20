// Typed data-access layer over the Archer schema. Thin, hand-written queries so
// the rest of the tool layer never embeds SQL. Grows one helper at a time as the
// CLI / API need it. All functions take a `Db` from createDb().
import type { Db } from "./client.js";
import type { Database, Json } from "./database.types.js";

type Row<T extends keyof Database["public"]["Tables"]> = Database["public"]["Tables"][T]["Row"];
type Enum<T extends keyof Database["public"]["Enums"]> = Database["public"]["Enums"][T];

export type Board = Row<"boards">;
export type Activity = Row<"activities">;
export type TargetTitle = Row<"target_titles">;
export type Profile = Row<"profiles">;
export type Thread = Row<"threads">;

// ── threads (the per-user conversation spine) ─────────────────────────────
/** A user's threads, newest first. The signup trigger bootstraps the first one
 *  (see 20260620120000_bootstrap_first_thread.sql); later runs may open more. */
export async function listThreads(db: Db, userId: string): Promise<Thread[]> {
  return await db<Thread[]>`
    select * from threads where user_id = ${userId} order by created_at desc`;
}

// ── boards ────────────────────────────────────────────────────────────────
export async function listBoards(db: Db): Promise<Board[]> {
  return await db<Board[]>`select * from boards order by slug`;
}

export async function getBoard(db: Db, slug: string): Promise<Board | undefined> {
  const rows = await db<Board[]>`select * from boards where slug = ${slug}`;
  return rows[0];
}

export async function setBoardStatus(
  db: Db,
  slug: string,
  patch: { collect?: Enum<"integration_status">; apply?: Enum<"integration_status"> },
): Promise<Board | undefined> {
  const rows = await db<Board[]>`
    update boards set
      collect_status = coalesce(${patch.collect ?? null}::integration_status, collect_status),
      apply_status   = coalesce(${patch.apply ?? null}::integration_status, apply_status)
    where slug = ${slug}
    returning *`;
  return rows[0];
}

// ── activities (the universal run primitive) ──────────────────────────────
export interface StartActivityInput {
  type: Enum<"activity_type">;
  userId?: string | null;
  boardSlug?: string | null;
  postingId?: string | null;
  candidacyId?: string | null;
  companyId?: string | null;
  detail?: Record<string, unknown>;
}

export async function startActivity(db: Db, input: StartActivityInput): Promise<Activity> {
  const rows = await db<Activity[]>`
    insert into activities
      (type, status, user_id, board_slug, posting_id, candidacy_id, company_id, detail, started_at)
    values
      (${input.type}, 'in_progress', ${input.userId ?? null}, ${input.boardSlug ?? null},
       ${input.postingId ?? null}, ${input.candidacyId ?? null}, ${input.companyId ?? null},
       ${input.detail ? db.json(input.detail as never) : null}, now())
    returning *`;
  return rows[0];
}

export async function succeedActivity(
  db: Db,
  id: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await db`
    update activities set
      status = 'succeeded', finished_at = now(),
      detail = coalesce(${detail ? db.json(detail as never) : null}::jsonb, detail)
    where id = ${id}`;
}

export async function failActivity(
  db: Db,
  id: string,
  error: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await db`
    update activities set
      status = 'failed', finished_at = now(), error = ${error},
      detail = coalesce(${detail ? db.json(detail as never) : null}::jsonb, detail)
    where id = ${id}`;
}

// ── target titles (the collect search keys) ───────────────────────────────
export async function listTargetTitles(
  db: Db,
  userId: string,
  opts: { activeOnly?: boolean } = {},
): Promise<TargetTitle[]> {
  if (opts.activeOnly) {
    return await db<TargetTitle[]>`
      select * from target_titles where user_id = ${userId} and is_active order by created_at`;
  }
  return await db<TargetTitle[]>`
    select * from target_titles where user_id = ${userId} order by created_at`;
}

export async function addTargetTitle(db: Db, userId: string, title: string): Promise<TargetTitle> {
  const rows = await db<TargetTitle[]>`
    insert into target_titles (user_id, title) values (${userId}, ${title}) returning *`;
  return rows[0];
}

export async function removeTargetTitle(db: Db, id: string): Promise<void> {
  await db`delete from target_titles where id = ${id}`;
}

// ── profile ───────────────────────────────────────────────────────────────
export async function getProfile(db: Db, userId: string): Promise<Profile | undefined> {
  const rows = await db<Profile[]>`select * from profiles where user_id = ${userId}`;
  return rows[0];
}

export type ProfilePatch = Partial<
  Pick<
    Profile,
    | "about"
    | "location"
    | "willing_remote"
    | "work_pref"
    | "current_salary"
    | "preferred_salary"
    | "notice_period"
    | "years_experience"
    | "resume_url"
    | "resume_text"
    | "portfolio_url"
    | "linkedin_url"
  >
>;

export async function upsertProfile(db: Db, userId: string, patch: ProfilePatch): Promise<Profile> {
  if (Object.keys(patch).length === 0) {
    const existing = await getProfile(db, userId);
    if (existing) return existing;
  }
  const insertRow = { user_id: userId, ...patch };
  const rows = await db<Profile[]>`
    insert into profiles ${db(insertRow as never)}
    on conflict (user_id) do update set ${db(patch as never)}
    returning *`;
  return rows[0];
}

// ── candidacies (the jobs kanban) ─────────────────────────────────────────
export type Candidacy = Row<"candidacies">;

/** A candidacy joined with its posting/company for human-readable listing. */
export interface CandidacyListItem {
  id: string;
  status: Enum<"candidacy_status">;
  triage_decision: Enum<"triage_decision"> | null;
  posting_title: string;
  board_slug: string;
  company_name: string | null;
  created_at: string;
}

export async function listCandidacies(
  db: Db,
  userId: string,
  opts: { status?: Enum<"candidacy_status"> } = {},
): Promise<CandidacyListItem[]> {
  if (opts.status) {
    return await db<CandidacyListItem[]>`
      select c.id, c.status, c.triage_decision, p.title as posting_title,
             p.board_slug, co.name as company_name, c.created_at
      from candidacies c
      join postings p on p.id = c.posting_id
      left join companies co on co.id = p.company_id
      where c.user_id = ${userId} and c.status = ${opts.status}::candidacy_status
      order by c.created_at desc`;
  }
  return await db<CandidacyListItem[]>`
    select c.id, c.status, c.triage_decision, p.title as posting_title,
           p.board_slug, co.name as company_name, c.created_at
    from candidacies c
    join postings p on p.id = c.posting_id
    left join companies co on co.id = p.company_id
    where c.user_id = ${userId}
    order by c.created_at desc`;
}

export async function getCandidacy(db: Db, id: string): Promise<Candidacy | undefined> {
  const rows = await db<Candidacy[]>`select * from candidacies where id = ${id}`;
  return rows[0];
}

export async function setCandidacyStatus(
  db: Db,
  id: string,
  status: Enum<"candidacy_status">,
  opts: { reason?: string; triageDecision?: Enum<"triage_decision"> } = {},
): Promise<Candidacy | undefined> {
  const rows = await db<Candidacy[]>`
    update candidacies set
      status = ${status}::candidacy_status,
      status_changed_at = now(),
      triage_decision = coalesce(${opts.triageDecision ?? null}::triage_decision, triage_decision),
      triage_reason = coalesce(${opts.reason ?? null}, triage_reason)
    where id = ${id}
    returning *`;
  return rows[0];
}

// ── collect: idempotent upserts ───────────────────────────────────────────
export async function upsertCompany(db: Db, name: string): Promise<string> {
  const rows = await db<{ id: string }[]>`
    insert into companies (name) values (${name})
    on conflict (normalized_name) do update set name = excluded.name
    returning id`;
  return rows[0].id;
}

export interface UpsertPostingInput {
  boardSlug: string;
  url: string;
  title: string;
  companyId?: string | null;
  companyNameRaw?: string | null;
  externalId?: string | null;
  location?: string | null;
  workMode?: Enum<"work_mode">;
  salaryRaw?: string | null;
  description?: string | null;
  postedOn?: string | null;
  contentHash?: string | null;
}

/** Insert or refresh a posting (idempotent on board_slug + url). `inserted` is
 *  true when the row was newly created (xmax = 0), false when it already existed. */
export async function upsertPosting(
  db: Db,
  p: UpsertPostingInput,
): Promise<{ id: string; inserted: boolean }> {
  const rows = await db<{ id: string; inserted: boolean }[]>`
    insert into postings
      (board_slug, url, title, company_id, company_name_raw, external_id,
       location, work_mode, salary_raw, description, posted_on, content_hash, collected_at)
    values
      (${p.boardSlug}, ${p.url}, ${p.title}, ${p.companyId ?? null}, ${p.companyNameRaw ?? null},
       ${p.externalId ?? null}, ${p.location ?? null}, ${p.workMode ?? "unknown"}::work_mode,
       ${p.salaryRaw ?? null}, ${p.description ?? null}, ${p.postedOn ?? null},
       ${p.contentHash ?? null}, now())
    on conflict (board_slug, url) do update set
      title = excluded.title,
      company_id = coalesce(excluded.company_id, postings.company_id),
      company_name_raw = excluded.company_name_raw,
      location = excluded.location,
      work_mode = excluded.work_mode,
      salary_raw = excluded.salary_raw,
      description = excluded.description,
      posted_on = excluded.posted_on,
      collected_at = now()
    returning id, (xmax = 0) as inserted`;
  return rows[0];
}

/** Create a candidacy unless the user already pursues this posting. Returns the
 *  new row, or null when it already existed (one candidacy per user per posting). */
export async function insertCandidacy(
  db: Db,
  userId: string,
  postingId: string,
): Promise<{ id: string } | null> {
  const rows = await db<{ id: string }[]>`
    insert into candidacies (user_id, posting_id) values (${userId}, ${postingId})
    on conflict (user_id, posting_id) do nothing
    returning id`;
  return rows[0] ?? null;
}

// ── interaction: runs + events (the AG-UI run log) ─────────────────────────
// The durable spine for the AG-UI run lifecycle (see services/api/src/agui.ts):
// open a run, append its ordered event log, then close it with a terminal status.
export type Run = Row<"runs">;
export type InteractionEvent = Row<"events">;

export interface CreateRunInput {
  threadId: string;
  parentRunId?: string | null;
  input?: Json | null;
}

/** Open a new AG-UI run on a thread (status defaults to 'running'). */
export async function createRun(db: Db, run: CreateRunInput): Promise<Run> {
  const rows = await db<Run[]>`
    insert into runs (thread_id, parent_run_id, input)
    values (${run.threadId}, ${run.parentRunId ?? null},
            ${run.input != null ? db.json(run.input as never) : null})
    returning *`;
  return rows[0];
}

export interface NewEvent {
  type: Enum<"event_type">;
  data?: Json | null;
}

/** Append events to a run in emission order; `seq` is the per-run 0-based ordinal
 *  (the (run_id, seq) unique index makes replay and ordering deterministic). */
export async function appendEvents(
  db: Db,
  threadId: string,
  runId: string,
  events: NewEvent[],
): Promise<InteractionEvent[]> {
  const out: InteractionEvent[] = [];
  for (let seq = 0; seq < events.length; seq++) {
    const e = events[seq];
    const rows = await db<InteractionEvent[]>`
      insert into events (run_id, thread_id, seq, type, data)
      values (${runId}, ${threadId}, ${seq}, ${e.type}::event_type,
              ${e.data != null ? db.json(e.data as never) : null})
      returning *`;
    out.push(rows[0]);
  }
  return out;
}

/** One event as the history-restore projection consumes it, in replay order. */
export interface ThreadEvent {
  type: Enum<"event_type">;
  data: Json | null;
  seq: number;
  run_id: string;
}

/** The full ordered event log for a thread (across all its runs), oldest first —
 *  the replayable source a client folds into a StateSnapshot + MessagesSnapshot.
 *  Ordered by run start then per-run seq, so multi-run threads replay in order. */
export async function loadThreadEvents(db: Db, threadId: string): Promise<ThreadEvent[]> {
  return await db<ThreadEvent[]>`
    select e.type, e.data, e.seq::int as seq, e.run_id
    from events e
    join runs r on r.id = e.run_id
    where e.thread_id = ${threadId}
    order by r.started_at asc, e.seq asc`;
}

export interface FinishRunPatch {
  status: Enum<"run_status">;
  outcome?: Json | null;
  error?: string | null;
}

/** Close a run with its terminal status + outcome (or error). */
export async function finishRun(
  db: Db,
  id: string,
  patch: FinishRunPatch,
): Promise<Run | undefined> {
  const rows = await db<Run[]>`
    update runs set
      status = ${patch.status}::run_status,
      outcome = coalesce(${patch.outcome != null ? db.json(patch.outcome as never) : null}::jsonb, outcome),
      error = coalesce(${patch.error ?? null}, error),
      finished_at = now()
    where id = ${id}
    returning *`;
  return rows[0];
}

// ── interaction: the interrupt → approval substrate (proposals table) ──────
// A run that pauses for a human emits an interrupt; we durably back each one with
// a proposals row (kind 'tool_call'). The interrupt's locator lives in plan jsonb
// — the binding between the AG-UI interrupt and its approval — and the decision is
// recorded on the same row (status + decided_at + decision_note). No new table:
// the interaction migration deliberately reuses public.proposals.

export interface InterruptProposalInput {
  threadId: string;
  runId: string;
  interruptId: string;
  toolCallId: string;
  action: string;
  title: string;
  rationale?: string | null;
}

/** Open a proposal for one emitted interrupt (status 'submitted' = awaiting a
 *  decision). The plan carries the locator linking it back to the interrupt. */
export async function createInterruptProposal(
  db: Db,
  p: InterruptProposalInput,
): Promise<{ id: string }> {
  const plan = {
    threadId: p.threadId,
    runId: p.runId,
    interruptId: p.interruptId,
    toolCallId: p.toolCallId,
    action: p.action,
  };
  const rows = await db<{ id: string }[]>`
    insert into proposals (kind, title, rationale, plan, status, created_by)
    values ('tool_call', ${p.title}, ${p.rationale ?? null}, ${db.json(plan as never)},
            'submitted', 'agent')
    returning id`;
  return rows[0];
}

/** One interrupt of a thread, projected from its proposals (the locator + status). */
export interface ThreadInterrupt {
  proposalId: string;
  interruptId: string;
  runId: string;
  toolCallId: string;
  action: string | null;
  status: Enum<"proposal_status">;
}

/** Every interrupt ever raised on a thread, oldest first — the route splits these
 *  into open (status 'submitted') vs decided to enforce the resume contract. */
export async function loadThreadInterrupts(db: Db, threadId: string): Promise<ThreadInterrupt[]> {
  return await db<ThreadInterrupt[]>`
    select id as "proposalId",
           plan->>'interruptId' as "interruptId",
           plan->>'runId' as "runId",
           plan->>'toolCallId' as "toolCallId",
           plan->>'action' as action,
           status
    from proposals
    where kind = 'tool_call' and plan->>'threadId' = ${threadId}
    order by created_at asc`;
}

/** Record a human's decision on an interrupt's proposal. Idempotent: only a
 *  still-open ('submitted') proposal is decided, so a replayed resume is a no-op.
 *  Returns the row when this call made the decision, undefined when already decided. */
export async function decideInterruptProposal(
  db: Db,
  proposalId: string,
  patch: { status: Enum<"proposal_status">; note?: string | null },
): Promise<{ id: string } | undefined> {
  const rows = await db<{ id: string }[]>`
    update proposals set
      status = ${patch.status}::proposal_status,
      decided_at = now(),
      decision_note = coalesce(${patch.note ?? null}, decision_note)
    where id = ${proposalId} and status = 'submitted'
    returning id`;
  return rows[0];
}
