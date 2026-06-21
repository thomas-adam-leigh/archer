// Typed data-access layer over the Archer schema. Thin, hand-written queries so
// the rest of the tool layer never embeds SQL. Grows one helper at a time as the
// CLI / API need it. All functions take a `Db` from createDb().
import { assertCandidacyTransition } from "./candidacy-status.js";
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

/** The user who owns a thread, or undefined if it doesn't exist. The onboarding
 *  route resolves the profile-version owner from the thread (single source of
 *  truth) rather than trusting a caller-supplied id. */
export async function getThreadOwner(db: Db, threadId: string): Promise<string | undefined> {
  const rows = await db<{ user_id: string }[]>`
    select user_id from threads where id = ${threadId}`;
  return rows[0]?.user_id;
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

/** An activity row projected for the observability feed (newest first). */
export interface ActivityListItem {
  id: string;
  type: Enum<"activity_type">;
  status: Enum<"activity_status">;
  detail: Json | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

/** A user's own activities for the observability read surface (ARC-43), newest
 *  first, optionally filtered by type/status. RLS own-rows-only (scoped on
 *  user_id); system-level rows (user_id null, e.g. deploy) are out of scope. */
export async function listActivities(
  db: Db,
  userId: string,
  opts: { type?: Enum<"activity_type">; status?: Enum<"activity_status">; limit?: number } = {},
): Promise<ActivityListItem[]> {
  const limit = opts.limit ?? 50;
  return await db<ActivityListItem[]>`
    select id, type, status, detail, error, started_at, finished_at, created_at
    from activities
    where user_id = ${userId}
      and (${opts.type ?? null}::activity_type is null or type = ${opts.type ?? null}::activity_type)
      and (${opts.status ?? null}::activity_status is null
           or status = ${opts.status ?? null}::activity_status)
    order by created_at desc
    limit ${limit}`;
}

/** An operator/admin activity row — `listActivities` plus the `user_id` so the
 *  operator can tell whose run it is (and spot system-level rows, user_id null). */
export interface AdminActivityListItem extends ActivityListItem {
  user_id: string | null;
}

/** The operator/admin read surface (ARC-44): recent activities across ALL users
 *  *and* system-level rows (user_id null, e.g. `deploy`), newest first, optionally
 *  filtered by type/status. This is the deliberate counterpart to listActivities'
 *  own-rows-only scoping — it is gated at the API layer by the owner/admin secret
 *  (ARC-51), never exposed on the per-user surface. */
export async function listAllActivities(
  db: Db,
  opts: { type?: Enum<"activity_type">; status?: Enum<"activity_status">; limit?: number } = {},
): Promise<AdminActivityListItem[]> {
  const limit = opts.limit ?? 50;
  return await db<AdminActivityListItem[]>`
    select id, user_id, type, status, detail, error, started_at, finished_at, created_at
    from activities
    where (${opts.type ?? null}::activity_type is null or type = ${opts.type ?? null}::activity_type)
      and (${opts.status ?? null}::activity_status is null
           or status = ${opts.status ?? null}::activity_status)
    order by created_at desc
    limit ${limit}`;
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

// ── negative criteria (the deal-breakers readiness/match key on) ───────────
export type NegativeCriterion = Row<"negative_criteria">;

export async function listNegativeCriteria(db: Db, userId: string): Promise<NegativeCriterion[]> {
  return await db<NegativeCriterion[]>`
    select * from negative_criteria where user_id = ${userId} order by created_at`;
}

export async function addNegativeCriterion(
  db: Db,
  userId: string,
  text: string,
): Promise<NegativeCriterion> {
  const rows = await db<NegativeCriterion[]>`
    insert into negative_criteria (user_id, text) values (${userId}, ${text}) returning *`;
  return rows[0];
}

export async function removeNegativeCriterion(db: Db, id: string): Promise<void> {
  await db`delete from negative_criteria where id = ${id}`;
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
  match_score: number | null;
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
      select c.id, c.status, c.triage_decision, c.match_score, p.title as posting_title,
             p.board_slug, co.name as company_name, c.created_at
      from candidacies c
      join postings p on p.id = c.posting_id
      left join companies co on co.id = p.company_id
      where c.user_id = ${userId} and c.status = ${opts.status}::candidacy_status
      order by c.created_at desc`;
  }
  return await db<CandidacyListItem[]>`
    select c.id, c.status, c.triage_decision, c.match_score, p.title as posting_title,
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
  opts: { reason?: string; triageDecision?: Enum<"triage_decision">; score?: number } = {},
): Promise<Candidacy | undefined> {
  const rows = await db<Candidacy[]>`
    update candidacies set
      status = ${status}::candidacy_status,
      status_changed_at = now(),
      triage_decision = coalesce(${opts.triageDecision ?? null}::triage_decision, triage_decision),
      triage_reason = coalesce(${opts.reason ?? null}, triage_reason),
      match_score = coalesce(${opts.score ?? null}::int, match_score)
    where id = ${id}
    returning *`;
  return rows[0];
}

/**
 * Move a candidacy `to` a new status THROUGH the status machine: load its current
 * status, assert the move is legal (else throw IllegalCandidacyTransitionError), then
 * apply it. This is the guarded entry point the apply phase and the kanban-move API
 * use, so the documented machine (see candidacy-status.ts) is actually enforced —
 * illegal jumps like new → applied are rejected. Raw setCandidacyStatus stays the
 * unguarded primitive for seeding + the deliberate `jobs status` escape hatch.
 * Returns undefined for an unknown candidacy (the caller 404s).
 */
export async function transitionCandidacy(
  db: Db,
  id: string,
  to: Enum<"candidacy_status">,
  opts: { reason?: string; triageDecision?: Enum<"triage_decision">; score?: number } = {},
): Promise<Candidacy | undefined> {
  const current = await getCandidacy(db, id);
  if (!current) return undefined;
  assertCandidacyTransition(current.status, to);
  return await setCandidacyStatus(db, id, to, opts);
}

/** A candidacy joined with the role/company context the Scribe drafts a cover
 *  letter against, plus the owner + status the cover-letter routes gate on. */
export interface CandidacyContext {
  id: string;
  user_id: string;
  status: Enum<"candidacy_status">;
  posting_title: string;
  company_name: string | null;
  /** The board the posting came from — the apply adapter dispatches per board. */
  board_slug: string;
}

/** One candidacy with its posting title + company name + board — the context the
 *  Scribe assembles a draft against, the owner/status a cover-letter run checks,
 *  and the board the apply adapter targets. Undefined if the candidacy does not
 *  exist. */
export async function getCandidacyContext(
  db: Db,
  id: string,
): Promise<CandidacyContext | undefined> {
  const rows = await db<CandidacyContext[]>`
    select c.id, c.user_id, c.status, p.title as posting_title,
           p.board_slug, co.name as company_name
    from candidacies c
    join postings p on p.id = c.posting_id
    left join companies co on co.id = p.company_id
    where c.id = ${id}`;
  return rows[0];
}

/** One `new` candidacy with the posting context the Matchmaker judges it against
 *  (title/company/location/work mode/description). Returned oldest first so a run
 *  triages in arrival order. Only status `new` rows are returned, which is what
 *  makes a re-run idempotent — already-decided candidacies are never re-triaged. */
export interface NewCandidacy {
  id: string;
  posting_title: string;
  company_name: string | null;
  board_slug: string;
  location: string | null;
  work_mode: Enum<"work_mode">;
  description: string | null;
}

export async function listNewCandidacies(db: Db, userId: string): Promise<NewCandidacy[]> {
  return await db<NewCandidacy[]>`
    select c.id, p.title as posting_title, co.name as company_name,
           p.board_slug, p.location, p.work_mode, p.description
    from candidacies c
    join postings p on p.id = c.posting_id
    left join companies co on co.id = p.company_id
    where c.user_id = ${userId} and c.status = 'new'::candidacy_status
    order by c.created_at`;
}

// ── collect: idempotent upserts ───────────────────────────────────────────
export async function upsertCompany(db: Db, name: string): Promise<string> {
  const rows = await db<{ id: string }[]>`
    insert into companies (name) values (${name})
    on conflict (normalized_name) do update set name = excluded.name
    returning id`;
  return rows[0].id;
}

// ── enrich: the Researcher write surface ───────────────────────────────────
// A shortlisted company is enriched (LinkedIn MCP + Firecrawl, stubbed) into the
// already-live companies schema: the columns the schema promotes (website /
// recruitment email / description / linkedin / domain) plus the full tool blob in
// the `enrichment` jsonb, with status walking new → researching → enriched |
// enrichment_failed. The orchestration lives in the CLI (services/cli enrich).
export type Company = Row<"companies">;

/** One company by id, or undefined. */
export async function getCompany(db: Db, id: string): Promise<Company | undefined> {
  const rows = await db<Company[]>`select * from companies where id = ${id}`;
  return rows[0];
}

/** The shortlist gate: true when at least one candidacy (across users) pursues a
 *  posting at this company and has been triaged INTO pursuit — i.e. any status other
 *  than the untriaged `new` or the `dismissed` rejects. This covers a freshly
 *  `shortlisted`/`alternative_outreach` candidacy AND one that has since progressed
 *  past it (e.g. `awaiting_cover_letter` after the enrichment gate ran), so a forced
 *  re-enrich of an already-advanced company is still allowed. Enrichment fires only
 *  behind a shortlist — no wasted research on dismissed or never-matched companies
 *  (candidacy → posting → company join). */
export async function companyHasShortlistedCandidacy(db: Db, companyId: string): Promise<boolean> {
  const rows = await db<{ ok: boolean }[]>`
    select exists (
      select 1 from candidacies c
      join postings p on p.id = c.posting_id
      where p.company_id = ${companyId}
        and c.status not in ('new', 'dismissed')
    ) as ok`;
  return rows[0]?.ok ?? false;
}

/** Move a company through its enrichment lifecycle
 *  (new → researching → enriched | enrichment_failed). Returns the updated row. */
export async function setCompanyStatus(
  db: Db,
  id: string,
  status: Enum<"company_status">,
): Promise<Company | undefined> {
  const rows = await db<Company[]>`
    update companies set status = ${status}::company_status where id = ${id} returning *`;
  return rows[0];
}

export interface CompanyEnrichment {
  websiteUrl?: string | null;
  recruitmentEmail?: string | null;
  description?: string | null;
  linkedinUrl?: string | null;
  domain?: string | null;
  /** The whole (stubbed) tool output, stored verbatim in companies.enrichment. */
  detail: Record<string, unknown>;
}

/** Write an enrichment payload onto a company: the promoted columns (each filled
 *  only when the result carries it, via coalesce) plus the full blob in the
 *  `enrichment` jsonb. Does NOT change `status` (the caller flips it to 'enriched');
 *  set_updated_at bumps updated_at. Idempotent — re-applying overwrites in place. */
export async function saveCompanyEnrichment(
  db: Db,
  id: string,
  e: CompanyEnrichment,
): Promise<void> {
  await db`
    update companies set
      website_url = coalesce(${e.websiteUrl ?? null}, website_url),
      recruitment_email = coalesce(${e.recruitmentEmail ?? null}, recruitment_email),
      description = coalesce(${e.description ?? null}, description),
      linkedin_url = coalesce(${e.linkedinUrl ?? null}, linkedin_url),
      domain = coalesce(${e.domain ?? null}, domain),
      enrichment = ${db.json(e.detail as never)}
    where id = ${id}`;
}

/** Mark a company's enrichment as failed, recording the reason in the `enrichment`
 *  jsonb so it's queryable on the company (the Activity carries the error too). */
export async function failCompanyEnrichment(db: Db, id: string, reason: string): Promise<void> {
  await db`
    update companies set
      status = 'enrichment_failed',
      enrichment = ${db.json({ error: reason } as never)}
    where id = ${id}`;
}

/** One person to promote into public.contacts (structurally the CLI's FoundContact;
 *  phone is omitted by design — the contacts schema has no phone column). */
export interface ContactInput {
  fullName: string;
  email?: string | null;
  linkedinUrl?: string | null;
  roleTitle?: string | null;
}

/** Promote the contacts a (stubbed) enrichment found into public.contacts under the
 *  company FK. Idempotent without a DB unique constraint: each contact is inserted
 *  only when no existing row shares its stable key — company_id + lower(email) when it
 *  carries an email, else company_id + lower(full_name) among the company's
 *  emailless rows — so re-running an enriched company adds no duplicates. Returns the
 *  count of rows newly inserted. */
export async function upsertContacts(
  db: Db,
  companyId: string,
  contacts: ContactInput[],
): Promise<number> {
  let inserted = 0;
  for (const c of contacts) {
    const email = c.email ?? null;
    const rows = await db<{ id: string }[]>`
      insert into contacts (company_id, full_name, email, linkedin_url, role_title)
      select ${companyId}, ${c.fullName}, ${email}, ${c.linkedinUrl ?? null}, ${c.roleTitle ?? null}
      where not exists (
        select 1 from contacts where company_id = ${companyId} and
          case
            when ${email}::text is not null then lower(email) = lower(${email})
            else email is null and lower(full_name) = lower(${c.fullName})
          end
      )
      returning id`;
    if (rows[0]) inserted++;
  }
  return inserted;
}

// ── candidacy gate: enriched → awaiting_cover_letter (ARC-35) ──────────────
/** A candidacy advanced by the enrichment gate, with the context to notify its owner. */
export interface AdvancedCandidacy {
  id: string;
  user_id: string;
  posting_title: string;
}

/** The hand-off that unblocks Applications & Cover Letters: when a company reaches
 *  `enriched`, advance every candidacy behind it that is `shortlisted` /
 *  `alternative_outreach` to `awaiting_cover_letter`. One atomic UPDATE across all
 *  users' candidacies at the company; idempotent by construction — only those two
 *  statuses match, so a re-run (or an already-advanced candidacy) advances nothing.
 *  Returns the rows it moved so the caller can notify each owner. */
export async function advanceCandidaciesToCoverLetter(
  db: Db,
  companyId: string,
): Promise<AdvancedCandidacy[]> {
  return await db<AdvancedCandidacy[]>`
    update candidacies c set
      status = 'awaiting_cover_letter'::candidacy_status,
      status_changed_at = now()
    from postings p
    where c.posting_id = p.id
      and p.company_id = ${companyId}
      and c.status in ('shortlisted', 'alternative_outreach')
    returning c.id, c.user_id, p.title as posting_title`;
}

// ── notifications (per-user pushes) ────────────────────────────────────────
export interface NewNotification {
  userId: string;
  kind?: string;
  title: string;
  body?: string | null;
  ref?: Record<string, unknown> | null;
}

/** Push a notification to a user (cover-letter ready, proposal decided, …). */
export async function createNotification(db: Db, n: NewNotification): Promise<void> {
  await db`
    insert into notifications (user_id, kind, title, body, ref)
    values (${n.userId}, ${n.kind ?? "info"}, ${n.title}, ${n.body ?? null},
            ${n.ref ? db.json(n.ref as never) : null})`;
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
 *  (the (run_id, seq) unique index makes replay and ordering deterministic).
 *  The base `seq` is derived from the run's existing rows, so a second batch on
 *  the same run continues the sequence rather than restarting at 0 (which would
 *  collide on the unique(run_id, seq) index). One multi-row insert keeps the
 *  offset and per-row ordinal assignment atomic within the statement. */
export async function appendEvents(
  db: Db,
  threadId: string,
  runId: string,
  events: NewEvent[],
): Promise<InteractionEvent[]> {
  if (events.length === 0) return [];
  const types = events.map((e) => e.type);
  const data = events.map((e) => (e.data != null ? JSON.stringify(e.data) : null));
  return await db<InteractionEvent[]>`
    insert into events (run_id, thread_id, seq, type, data)
    select ${runId}, ${threadId},
           coalesce((select max(seq) from events where run_id = ${runId}), -1) + ev.ord,
           ev.type::event_type, ev.data::jsonb
    from unnest(${types}::text[], ${data}::text[]) with ordinality as ev(type, data, ord)
    order by ev.ord
    returning *`;
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

// ── interaction: tier-2 message corpus search (full-text) ──────────────────
// The messages table is the deep tier-2 memory (chat turns incl. activity +
// reasoning). This is its retrieval surface: full-text now (an `english`
// to_tsvector GIN index + websearch_to_tsquery, see
// 20260620140000_message_search.sql), embeddings-ready later. Downstream
// consumers (profile distillation, cover-letter drafting) read past conversation
// through here instead of re-querying messages directly.
export type Message = Row<"messages">;

export interface NewMessage {
  threadId: string;
  role: Enum<"message_role">;
  content?: string | null;
  /** The run that produced it, if any — nullable, since a message can outlive its
   *  run (e.g. an ingested transcript that belongs to no AG-UI run). */
  runId?: string | null;
  name?: string | null;
}

/** Persist one chat turn into the tier-2 corpus and return it. The append primitive
 *  behind both run-produced turns and ingested content (transcripts, etc.). */
export async function insertMessage(db: Db, m: NewMessage): Promise<Message> {
  const rows = await db<Message[]>`
    insert into messages (thread_id, run_id, role, content, name)
    values (${m.threadId}, ${m.runId ?? null}, ${m.role}::message_role,
            ${m.content ?? null}, ${m.name ?? null})
    returning *`;
  return rows[0];
}

/** One full-text hit, with its relevance rank (higher = better match). */
export interface MessageSearchHit {
  id: string;
  thread_id: string;
  run_id: string | null;
  role: Enum<"message_role">;
  content: string | null;
  created_at: string;
  rank: number;
}

/** Search a user's own messages by keyword, best match first. Scoped own-rows-only
 *  through the owning thread (mirroring the messages RLS), optionally to one thread.
 *  `query` is parsed with websearch_to_tsquery, so "quoted phrases" and -negation
 *  work and malformed input yields no matches rather than an error. */
export async function searchMessages(
  db: Db,
  userId: string,
  query: string,
  opts: { threadId?: string | null; limit?: number } = {},
): Promise<MessageSearchHit[]> {
  const limit = opts.limit ?? 20;
  const threadId = opts.threadId ?? null;
  return await db<MessageSearchHit[]>`
    select m.id, m.thread_id, m.run_id, m.role, m.content, m.created_at,
           ts_rank(to_tsvector('english', coalesce(m.content, '')),
                   websearch_to_tsquery('english', ${query})) as rank
    from messages m
    join threads t on t.id = m.thread_id
    where t.user_id = ${userId}
      and (${threadId}::uuid is null or m.thread_id = ${threadId}::uuid)
      and to_tsvector('english', coalesce(m.content, ''))
          @@ websearch_to_tsquery('english', ${query})
    order by rank desc, m.created_at desc
    limit ${limit}`;
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
 *  into open (status 'submitted') vs decided to enforce the resume contract.
 *
 *  Covers every interrupt-bearing proposal kind: a 'tool_call' proposal keeps its
 *  AG-UI interrupt locator at the top of plan jsonb, whereas a 'cover_letter_version'
 *  (and any 'external_application') submit nests it one level deeper under
 *  plan->'interrupt'. Reading both paths via coalesce means a cover-letter submit's
 *  open interrupt is visible to the /agui/run gate — without it, a later run on the
 *  same thread slips past pending-interrupts-block-new-input (ARC-48). */
export async function loadThreadInterrupts(db: Db, threadId: string): Promise<ThreadInterrupt[]> {
  return await db<ThreadInterrupt[]>`
    select id as "proposalId",
           coalesce(plan->>'interruptId', plan->'interrupt'->>'interruptId') as "interruptId",
           coalesce(plan->>'runId', plan->'interrupt'->>'runId') as "runId",
           coalesce(plan->>'toolCallId', plan->'interrupt'->>'toolCallId') as "toolCallId",
           plan->>'action' as action,
           status
    from proposals
    where kind in ('tool_call', 'cover_letter_version', 'external_application')
      and coalesce(plan->>'threadId', plan->'interrupt'->>'threadId') = ${threadId}
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

// ── profile versions: the approvable unit + apply executor ─────────────────
// A profile_version is the whole-version draft a user approves as a unit (see
// 20260620150000_archer_profile_spine.sql). The live profile = the spine rows of
// the one version with status 'approved' (a partial unique index enforces ≤1 per
// user) + profiles.attributes synced from that version's snapshot. This is the
// domain-specific apply executor ARC-27 owns: it consumes the Substrate's
// proposal/resume machinery (a kind 'profile_version' proposal stands in for the
// submitted draft) and, on approve, atomically flips the live version. It does
// NOT rebuild the generic interrupt/autonomy primitives.
export type ProfileVersion = Row<"profile_versions">;

export interface NewProfileVersion {
  userId: string;
  label?: string | null;
  /** Profile-wide jsonb snapshot (ideal_job, ai_fluency, your-story, Otta prompts). */
  attributes?: Json;
  details?: Json;
}

/** Create a fresh draft version. `version_no` is the next per-user ordinal, so
 *  versions cycle/rollback in a stable order. Spine child rows are attached by
 *  the caller via the returned `id` (version_id); approval flips this whole unit. */
export async function createProfileVersion(db: Db, v: NewProfileVersion): Promise<ProfileVersion> {
  const rows = await db<ProfileVersion[]>`
    insert into profile_versions (user_id, version_no, status, label, attributes, details)
    values (
      ${v.userId},
      (select coalesce(max(version_no), 0) + 1 from profile_versions where user_id = ${v.userId}),
      'draft',
      ${v.label ?? null},
      ${v.attributes != null ? db.json(v.attributes as never) : db.json({} as never)},
      ${v.details != null ? db.json(v.details as never) : db.json({} as never)}
    )
    returning *`;
  return rows[0];
}

/** The user's live (approved) profile version, or undefined before first approval —
 *  the empty-state signal the onboarding gate keys on. */
export async function getLiveProfileVersion(
  db: Db,
  userId: string,
): Promise<ProfileVersion | undefined> {
  const rows = await db<ProfileVersion[]>`
    select * from profile_versions where user_id = ${userId} and status = 'approved'`;
  return rows[0];
}

export interface VersionProposalInput {
  userId: string;
  versionId: string;
  title: string;
  rationale?: string | null;
}

/** Submit a draft version for approval: open a kind 'profile_version' proposal
 *  (provenance — the {userId, versionId} locator — rides on plan jsonb, not an FK)
 *  and flip the version to 'proposed', atomically. Returns the proposal id. */
export async function submitVersionProposal(
  db: Db,
  p: VersionProposalInput,
): Promise<{ id: string }> {
  return await db.begin(async (tx) => {
    const plan = { kind: "profile_version", userId: p.userId, versionId: p.versionId };
    const rows = await tx<{ id: string }[]>`
      insert into proposals (kind, title, rationale, plan, status, created_by)
      values ('profile_version', ${p.title}, ${p.rationale ?? null},
              ${tx.json(plan as never)}, 'submitted', 'agent')
      returning id`;
    await tx`
      update profile_versions set status = 'proposed'
      where id = ${p.versionId} and user_id = ${p.userId} and status = 'draft'`;
    return rows[0];
  });
}

/** A human's decision on a submitted version proposal. `approve` (optionally with
 *  `edits` = approve-with-edits, a full replacement of the version's profile-wide
 *  fields) materialises the version as live; `reject` leaves the live profile
 *  untouched. */
export type VersionDecision =
  | {
      action: "approve";
      edits?: { attributes?: Json; label?: string | null };
      note?: string | null;
    }
  | { action: "reject"; note?: string | null };

export interface VersionApplyResult {
  /** Terminal proposal status: 'completed' | 'rejected' | 'failed' (or the prior
   *  terminal status on an idempotent replay of an already-decided proposal). */
  proposalStatus: Enum<"proposal_status">;
  /** The target version's status after the decision, if the version still exists. */
  versionStatus: Enum<"profile_version_status"> | null;
  /** Set when the apply failed: the live profile was left untouched. */
  error?: string;
}

/**
 * The profile-version apply executor. Decides a submitted 'profile_version'
 * proposal:
 *  - approve / approve-with-edits: in ONE transaction, optionally apply the
 *    edited payload, supersede the prior live version, flip the target version to
 *    'approved', and sync profiles.attributes from its snapshot. The proposal
 *    becomes 'completed'. Any failure rolls the transaction back (the live profile
 *    is untouched) and the proposal is marked 'failed'.
 *  - reject: mark the proposal 'rejected' and the version 'rejected'; the live
 *    profile is untouched.
 * Idempotent: only a still-'submitted' proposal is acted on, so a replay is a
 * no-op that returns the proposal's existing terminal state.
 */
export async function applyVersionProposal(
  db: Db,
  proposalId: string,
  decision: VersionDecision,
): Promise<VersionApplyResult> {
  if (decision.action === "reject") {
    const claimed = await db<{ plan: { userId: string; versionId: string } }[]>`
      update proposals set
        status = 'rejected', decided_at = now(),
        decision_note = coalesce(${decision.note ?? null}, decision_note)
      where id = ${proposalId} and kind = 'profile_version' and status = 'submitted'
      returning plan`;
    if (!claimed[0]) return await replayedOutcome(db, proposalId);
    const { userId, versionId } = claimed[0].plan;
    await db`
      update profile_versions set status = 'rejected'
      where id = ${versionId} and user_id = ${userId} and status in ('proposed', 'draft')`;
    return { proposalStatus: "rejected", versionStatus: await versionStatus(db, versionId) };
  }

  // approve / approve-with-edits. Claim the proposal to 'in_progress' first
  // (idempotent on 'submitted'); a concurrent or replayed call sees no row.
  const claimed = await db<{ plan: { userId: string; versionId: string } }[]>`
    update proposals set status = 'in_progress', decided_at = now(),
      decision_note = coalesce(${decision.note ?? null}, decision_note)
    where id = ${proposalId} and kind = 'profile_version' and status = 'submitted'
    returning plan`;
  if (!claimed[0]) return await replayedOutcome(db, proposalId);
  const { userId, versionId } = claimed[0].plan;
  const edits = decision.edits;

  try {
    await db.begin(async (tx) => {
      if (edits) {
        await tx`
          update profile_versions set
            attributes = coalesce(${edits.attributes != null ? tx.json(edits.attributes as never) : null}::jsonb, attributes),
            label = coalesce(${edits.label ?? null}, label)
          where id = ${versionId} and user_id = ${userId}`;
      }
      // Supersede the prior live version so the partial unique index never clashes.
      await tx`
        update profile_versions set status = 'superseded'
        where user_id = ${userId} and status = 'approved'`;
      // Flip the target version live — only a still-proposable version qualifies.
      const approved = await tx<{ attributes: Json }[]>`
        update profile_versions set status = 'approved'
        where id = ${versionId} and user_id = ${userId} and status in ('proposed', 'draft')
        returning attributes`;
      if (!approved[0]) {
        throw new Error(`version ${versionId} is not in a proposable state`);
      }
      // Sync the live profile-wide jsonb from the now-live version's snapshot.
      await tx`
        insert into profiles (user_id, attributes)
        values (${userId}, ${tx.json(approved[0].attributes as never)})
        on conflict (user_id) do update set attributes = excluded.attributes`;
      await tx`update proposals set status = 'completed' where id = ${proposalId}`;
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db`
      update proposals set status = 'failed', decision_note = ${message}
      where id = ${proposalId}`;
    return {
      proposalStatus: "failed",
      versionStatus: await versionStatus(db, versionId),
      error: message,
    };
  }

  return { proposalStatus: "completed", versionStatus: await versionStatus(db, versionId) };
}

// ── version read + cycle/rollback ──────────────────────────────────────────
/** The user's whole version history in stable ordinal order (draft → live →
 *  superseded), so a client can render the timeline and pick a target to cycle to. */
export async function listProfileVersions(db: Db, userId: string): Promise<ProfileVersion[]> {
  return await db<ProfileVersion[]>`
    select * from profile_versions where user_id = ${userId} order by version_no`;
}

/** A single version of the user's, or undefined (scoped to user_id so one user can
 *  never read another's version even on the service-role path). */
export async function getProfileVersion(
  db: Db,
  userId: string,
  versionId: string,
): Promise<ProfileVersion | undefined> {
  const rows = await db<ProfileVersion[]>`
    select * from profile_versions where id = ${versionId} and user_id = ${userId}`;
  return rows[0];
}

export interface RollbackResult {
  versionId: string;
  /** The target version's status after the rollback, or null if it didn't exist. */
  versionStatus: Enum<"profile_version_status"> | null;
  /** Set when the rollback was refused; the live profile was left untouched. */
  error?: string;
}

/**
 * Cycle/rollback the live profile to an earlier version: in ONE transaction,
 * supersede the current live version and re-approve the target, then re-sync
 * profiles.attributes from the target's snapshot. Only an already-materialised
 * version ('approved' or 'superseded') is a valid target — you can't skip the
 * proposal path to make a never-approved draft live. Rolling back to the version
 * that is already live is an idempotent no-op.
 */
export async function rollbackToVersion(
  db: Db,
  userId: string,
  versionId: string,
): Promise<RollbackResult> {
  return await db.begin<RollbackResult>(async (tx) => {
    const target = await tx<{ status: Enum<"profile_version_status">; attributes: Json }[]>`
      select status, attributes from profile_versions
      where id = ${versionId} and user_id = ${userId}`;
    if (!target[0]) return { versionId, versionStatus: null, error: "version not found" };
    if (target[0].status !== "approved" && target[0].status !== "superseded") {
      return {
        versionId,
        versionStatus: target[0].status,
        error: `cannot roll back to a ${target[0].status} version`,
      };
    }
    // Supersede the current live version (if any other) so the partial unique
    // index on 'approved' never clashes, then re-approve the target.
    await tx`
      update profile_versions set status = 'superseded'
      where user_id = ${userId} and status = 'approved' and id <> ${versionId}`;
    await tx`
      update profile_versions set status = 'approved'
      where id = ${versionId} and user_id = ${userId}`;
    await tx`
      insert into profiles (user_id, attributes)
      values (${userId}, ${tx.json(target[0].attributes as never)})
      on conflict (user_id) do update set attributes = excluded.attributes`;
    return { versionId, versionStatus: "approved" };
  });
}

// ── profile spine writer (shared: résumé ingest + conversational onboarding) ─
// A version's spine is the structured tier-1 memory (work_experiences, education,
// skills, certifications, courses, projects). Both the résumé-structuring path
// (ARC-64) and the conversational onboarding path (Milestone 7) reconstruct a draft
// and attach its spine rows to a freshly-created version via this writer — they
// produce the same ProfileSpineDraft shape so the persistence stays in one place.

export interface NewWorkExperience {
  title: string;
  organization?: string | null;
  employmentType?: string | null;
  location?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  isCurrent?: boolean | null;
  description?: string | null;
  details?: Json;
}
export interface NewEducation {
  institution: string;
  degree?: string | null;
  fieldOfStudy?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  grade?: string | null;
  details?: Json;
}
export interface NewSkill {
  name: string;
  category?: string | null;
  proficiency?: string | null;
  yearsExperience?: number | null;
  details?: Json;
}
export interface NewCertification {
  name: string;
  issuer?: string | null;
  issuedOn?: string | null;
  expiresOn?: string | null;
  credentialId?: string | null;
  url?: string | null;
  details?: Json;
}
export interface NewCourse {
  name: string;
  provider?: string | null;
  completedOn?: string | null;
  url?: string | null;
  details?: Json;
}
export interface NewProject {
  name: string;
  role?: string | null;
  url?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  description?: string | null;
  details?: Json;
}

/** A reconstructed profile's structured spine — every list optional, each item one
 *  spine row. The empty draft (all absent) writes nothing. */
export interface ProfileSpineDraft {
  workExperiences?: NewWorkExperience[];
  education?: NewEducation[];
  skills?: NewSkill[];
  certifications?: NewCertification[];
  courses?: NewCourse[];
  projects?: NewProject[];
}

const asJson = (db: Db, v: Json | undefined) => db.json((v ?? {}) as never);

/**
 * Attach a draft's spine rows to a version (`versionId`), all user-scoped for RLS.
 * Hand-written per-table inserts (résumés carry few rows); a `null`/absent field
 * leaves the column at its default. Call on a freshly-created draft version before
 * it is submitted for approval; idempotency is the caller's (one writer per version).
 */
export async function writeProfileSpine(
  db: Db,
  userId: string,
  versionId: string,
  spine: ProfileSpineDraft,
): Promise<void> {
  for (const w of spine.workExperiences ?? []) {
    await db`
      insert into work_experiences
        (user_id, version_id, title, organization, employment_type, location,
         start_date, end_date, is_current, description, details)
      values (${userId}, ${versionId}, ${w.title}, ${w.organization ?? null},
              ${w.employmentType ?? null}, ${w.location ?? null}, ${w.startDate ?? null},
              ${w.endDate ?? null}, ${w.isCurrent ?? false}, ${w.description ?? null},
              ${asJson(db, w.details)})`;
  }
  for (const e of spine.education ?? []) {
    await db`
      insert into education
        (user_id, version_id, institution, degree, field_of_study, start_date,
         end_date, grade, details)
      values (${userId}, ${versionId}, ${e.institution}, ${e.degree ?? null},
              ${e.fieldOfStudy ?? null}, ${e.startDate ?? null}, ${e.endDate ?? null},
              ${e.grade ?? null}, ${asJson(db, e.details)})`;
  }
  for (const s of spine.skills ?? []) {
    await db`
      insert into skills (user_id, version_id, name, category, proficiency, years_experience, details)
      values (${userId}, ${versionId}, ${s.name}, ${s.category ?? null},
              ${s.proficiency ?? null}, ${s.yearsExperience ?? null}, ${asJson(db, s.details)})`;
  }
  for (const cert of spine.certifications ?? []) {
    await db`
      insert into certifications
        (user_id, version_id, name, issuer, issued_on, expires_on, credential_id, url, details)
      values (${userId}, ${versionId}, ${cert.name}, ${cert.issuer ?? null},
              ${cert.issuedOn ?? null}, ${cert.expiresOn ?? null}, ${cert.credentialId ?? null},
              ${cert.url ?? null}, ${asJson(db, cert.details)})`;
  }
  for (const co of spine.courses ?? []) {
    await db`
      insert into courses (user_id, version_id, name, provider, completed_on, url, details)
      values (${userId}, ${versionId}, ${co.name}, ${co.provider ?? null},
              ${co.completedOn ?? null}, ${co.url ?? null}, ${asJson(db, co.details)})`;
  }
  for (const p of spine.projects ?? []) {
    await db`
      insert into projects
        (user_id, version_id, name, role, url, start_date, end_date, description, details)
      values (${userId}, ${versionId}, ${p.name}, ${p.role ?? null}, ${p.url ?? null},
              ${p.startDate ?? null}, ${p.endDate ?? null}, ${p.description ?? null},
              ${asJson(db, p.details)})`;
  }
}

// ── resume / portfolio ingest → proposed version ──────────────────────────
// A resume/portfolio upload must never touch the live profile: its extracted
// content becomes a PROPOSED version that flows through the exact same proposals
// / apply-executor path onboarding uses (createProfileVersion → submitVersionProposal
// → applyVersionProposal). This owns the orchestration + provenance only; the
// file→content extraction is the stubbed CLI boundary upstream (services/api/src/ingest.ts).

export interface IngestVersionInput {
  userId: string;
  /** What was uploaded ('resume' | 'portfolio') — logged on the activity + version. */
  source: string;
  /** Reference to the raw uploaded file (storage path/URL), recorded for provenance. */
  storageRef: string;
  filename?: string | null;
  /** The extractor's profile-wide attributes snapshot for the proposed version. */
  attributes: Json;
  /** The structured spine (work_experiences, education, skills, …) reconstructed
   *  from the upload, attached version-scoped to the proposed version. */
  spine?: ProfileSpineDraft;
  /** The extractor's provenance/details for the proposed version. */
  details?: Json;
  /** Proposal title shown to the human reviewer (defaults to a sensible prompt). */
  title?: string;
}

export interface IngestVersionResult {
  activityId: string;
  versionId: string;
  proposalId: string;
}

/**
 * Ingest extracted file content into a PROPOSED profile version (never the live
 * profile). Logs a `proposal_exec` activity carrying the raw-file storage reference,
 * creates a draft version from the extracted attributes, and submits it through the
 * same proposals path the onboarding flow uses — so the resulting proposal is decided
 * by the existing apply executor (applyVersionProposal). The version is left
 * 'proposed': only an explicit approval makes it live. Returns the created ids.
 */
export async function ingestProposedVersion(
  db: Db,
  input: IngestVersionInput,
): Promise<IngestVersionResult> {
  // The raw-file provenance, carried through both writes (succeedActivity REPLACES
  // detail, so the success update must re-include the storage reference, not drop it).
  const provenance = {
    source: input.source,
    storageRef: input.storageRef,
    filename: input.filename ?? null,
  };
  const activity = await startActivity(db, {
    type: "proposal_exec",
    userId: input.userId,
    detail: provenance,
  });
  const version = await createProfileVersion(db, {
    userId: input.userId,
    label: input.source === "portfolio" ? "portfolio import" : "resume import",
    attributes: input.attributes,
    details: input.details,
  });
  if (input.spine) await writeProfileSpine(db, input.userId, version.id, input.spine);
  const proposal = await submitVersionProposal(db, {
    userId: input.userId,
    versionId: version.id,
    title: input.title ?? "Approve your imported profile",
  });
  await succeedActivity(db, activity.id, {
    ...provenance,
    versionId: version.id,
    proposalId: proposal.id,
  });
  return { activityId: activity.id, versionId: version.id, proposalId: proposal.id };
}

// ── voicenote ingest → transcript message (tier-2) ─────────────────────────
// A voicenote becomes a transcript MESSAGE in the thread — the deep tier-2 source
// the Scribe later reads, never a profile mutation. This owns the backend
// orchestration + provenance: a `transcribe` activity, then the transcript
// persisted as a message. The audio→text transcription happens at the edge
// (ARC-53: the `transcribe` Supabase edge function → ElevenLabs); the audio is
// never persisted and the backend only ever receives the transcript TEXT.

export interface IngestVoicenoteInput {
  /** The thread the transcript message lands in; the owner is resolved upstream. */
  threadId: string;
  userId: string;
  filename?: string | null;
  /** The transcribed text (from the STT edge function) to persist as a message. */
  transcript: string;
  /** Which STT provider produced the transcript (e.g. "elevenlabs"). */
  provider: string;
}

export interface IngestVoicenoteResult {
  activityId: string;
  messageId: string;
}

/**
 * Ingest a transcribed voicenote into the tier-2 corpus. Logs a `transcribe`
 * activity, persists the transcript as a `user` message on the thread (run-less —
 * it belongs to no AG-UI run), and marks the activity succeeded with the
 * resulting message id. The audio is never persisted (transcription happens at
 * the edge); only the transcript text reaches here. Returns the created ids.
 */
export async function ingestVoicenote(
  db: Db,
  input: IngestVoicenoteInput,
): Promise<IngestVoicenoteResult> {
  // Provenance, carried through both writes (succeedActivity REPLACES detail, so
  // the success update must re-include it). No audio reference: nothing about the
  // bytes is stored — only which provider produced the text, and an optional name.
  const provenance = {
    kind: "voicenote",
    filename: input.filename ?? null,
    provider: input.provider,
  };
  const activity = await startActivity(db, {
    type: "transcribe",
    userId: input.userId,
    detail: provenance,
  });
  const message = await insertMessage(db, {
    threadId: input.threadId,
    role: "user",
    content: input.transcript,
  });
  await succeedActivity(db, activity.id, { ...provenance, messageId: message.id });
  return { activityId: activity.id, messageId: message.id };
}

// ── acceptance gate: account lifecycle + readiness + ≤24h owner review ──────
// The first human gate (ARC-31). A user onboards, then SUBMITS for review; an
// owner (service role) ACCEPTS or REJECTS with a note. Acceptance additionally
// requires a mechanical readiness check — 1–5 target titles + ≥1 negative
// criterion + a complete-enough profile (an approved profile version). The
// account row is provisioned just-in-time on first submit (defaulting to
// 'onboarding' for any user without one). collect/match is gated on 'accepted'.
export type Account = Row<"accounts">;
export type AccountStatus = Enum<"account_status">;

/** A user's account row, or undefined before first submit (= still 'onboarding'). */
export async function getAccount(db: Db, userId: string): Promise<Account | undefined> {
  const rows = await db<Account[]>`select * from accounts where user_id = ${userId}`;
  return rows[0];
}

/** Whether a user is accepted — the enforceable gate for collect/match. */
export async function isAccepted(db: Db, userId: string): Promise<boolean> {
  const rows = await db<{ ok: boolean }[]>`
    select exists (
      select 1 from accounts where user_id = ${userId} and status = 'accepted'
    ) as ok`;
  return rows[0]?.ok ?? false;
}

/** The mechanical readiness check acceptance requires: 1–5 target titles + ≥1
 *  negative criterion + a complete-enough profile (an approved profile version).
 *  `reasons` lists every unmet criterion (empty when ready). */
export interface Readiness {
  ready: boolean;
  targetTitles: number;
  negativeCriteria: number;
  hasLiveProfile: boolean;
  reasons: string[];
}

/** Pure: turn the three readiness counts into the verdict + unmet reasons. */
function readinessFromCounts(titles: number, criteria: number, live: boolean): Readiness {
  const reasons: string[] = [];
  if (titles < 1) reasons.push("needs 1–5 active target titles (has 0)");
  else if (titles > 5) reasons.push(`at most 5 active target titles (has ${titles})`);
  if (criteria < 1) reasons.push("needs at least one negative criterion");
  if (!live) reasons.push("needs a complete profile (no approved version yet)");
  return {
    ready: reasons.length === 0,
    targetTitles: titles,
    negativeCriteria: criteria,
    hasLiveProfile: live,
    reasons,
  };
}

export async function checkReadiness(db: Db, userId: string): Promise<Readiness> {
  const rows = await db<{ titles: number; criteria: number; live: boolean }[]>`
    select
      (select count(*)::int from target_titles where user_id = ${userId} and is_active) as titles,
      (select count(*)::int from negative_criteria where user_id = ${userId}) as criteria,
      exists (select 1 from profile_versions where user_id = ${userId} and status = 'approved') as live`;
  const { titles, criteria, live } = rows[0];
  return readinessFromCounts(titles, criteria, live);
}

/** Submit the account for review. Provisions the row just-in-time and moves it to
 *  'submitted' from 'onboarding' or 'rejected' (a rejected user may resubmit);
 *  idempotent / a no-op for an already submitted/under_review/accepted account. */
export async function submitAccountForReview(db: Db, userId: string): Promise<Account> {
  const rows = await db<Account[]>`
    insert into accounts (user_id, status, submitted_at)
    values (${userId}, 'submitted', now())
    on conflict (user_id) do update set
      status = case
        when accounts.status in ('onboarding', 'rejected') then 'submitted'::account_status
        else accounts.status end,
      submitted_at = case
        when accounts.status in ('onboarding', 'rejected') then now()
        else accounts.submitted_at end
    returning *`;
  return rows[0];
}

/** An owner's decision on a submitted account:
 *   - 'review': move submitted → under_review (the owner starts the ≤24h review).
 *   - 'accept': REQUIRES the readiness check; moves submitted|under_review →
 *     accepted (atomically re-checking readiness in the same transaction). Blocked
 *     with the unmet `readiness` reasons and the status left unchanged otherwise.
 *   - 'reject': move submitted|under_review → rejected, recording the note.
 *  Owner-only in practice (service-role path); RLS has no client write policy. */
export type AccountDecision =
  | { action: "review" }
  | { action: "accept"; note?: string | null }
  | { action: "reject"; note?: string | null };

export interface AccountDecisionResult {
  /** The account status after the decision, or null if the account doesn't exist. */
  status: AccountStatus | null;
  /** Included for an 'accept' attempt — why it was (or wasn't) allowed. */
  readiness?: Readiness;
  /** Set when the decision was refused (not ready, or not awaiting review). */
  error?: string;
}

export async function decideAccount(
  db: Db,
  userId: string,
  decision: AccountDecision,
): Promise<AccountDecisionResult> {
  if (decision.action === "review") {
    const rows = await db<{ status: AccountStatus }[]>`
      update accounts set status = 'under_review'
      where user_id = ${userId} and status = 'submitted'
      returning status`;
    if (rows[0]) return { status: rows[0].status };
    return {
      status: (await getAccount(db, userId))?.status ?? null,
      error: "account not submitted",
    };
  }

  if (decision.action === "reject") {
    const rows = await db<{ status: AccountStatus }[]>`
      update accounts set
        status = 'rejected', reviewed_at = now(),
        review_note = coalesce(${decision.note ?? null}, review_note)
      where user_id = ${userId} and status in ('submitted', 'under_review')
      returning status`;
    if (rows[0]) return { status: rows[0].status };
    return {
      status: (await getAccount(db, userId))?.status ?? null,
      error: "account not awaiting review",
    };
  }

  // accept — the readiness gate. Re-check inside the transaction so a concurrent
  // profile/title change can't slip an unready account through (TOCTOU-safe).
  const note = decision.note ?? null;
  return await db.begin<AccountDecisionResult>(async (tx) => {
    const counts = await tx<{ titles: number; criteria: number; live: boolean }[]>`
      select
        (select count(*)::int from target_titles where user_id = ${userId} and is_active) as titles,
        (select count(*)::int from negative_criteria where user_id = ${userId}) as criteria,
        exists (select 1 from profile_versions where user_id = ${userId} and status = 'approved') as live`;
    const { titles, criteria, live } = counts[0];
    const readiness = readinessFromCounts(titles, criteria, live);
    const current = await tx<{ status: AccountStatus }[]>`
      select status from accounts where user_id = ${userId}`;
    if (!readiness.ready) {
      return {
        status: current[0]?.status ?? null,
        readiness,
        error: `readiness check failed: ${readiness.reasons.join("; ")}`,
      };
    }
    const rows = await tx<{ status: AccountStatus }[]>`
      update accounts set
        status = 'accepted', reviewed_at = now(),
        review_note = coalesce(${note}, review_note)
      where user_id = ${userId} and status in ('submitted', 'under_review')
      returning status`;
    if (rows[0]) return { status: rows[0].status, readiness };
    return { status: current[0]?.status ?? null, readiness, error: "account not awaiting review" };
  });
}

/** The current status of a version, or null if it no longer exists. */
async function versionStatus(
  db: Db,
  versionId: string,
): Promise<Enum<"profile_version_status"> | null> {
  const rows = await db<{ status: Enum<"profile_version_status"> }[]>`
    select status from profile_versions where id = ${versionId}`;
  return rows[0]?.status ?? null;
}

/** The outcome of a replay (the proposal was already decided): report its current
 *  status and the target version's status without mutating anything. */
async function replayedOutcome(db: Db, proposalId: string): Promise<VersionApplyResult> {
  const rows = await db<{ status: Enum<"proposal_status">; plan: { versionId?: string } }[]>`
    select status, plan from proposals where id = ${proposalId}`;
  const proposal = rows[0];
  if (!proposal) throw new Error(`proposal ${proposalId} not found`);
  const vId = proposal.plan?.versionId;
  return {
    proposalStatus: proposal.status,
    versionStatus: vId ? await versionStatus(db, vId) : null,
  };
}

// ── cover-letter versions (whole-version history per candidacy) ───────────────
// Schema: 20260620190000_cover_letter_versions.sql. Mirrors the profile version
// model — one approvable row per draft, one 'approved' (active) version per
// candidacy. The proposal-driven approve/edit/reject loop lands later (it
// consumes these helpers); ARC-14 is the schema + create/list/get/setActive.
export type CoverLetterVersion = Row<"cover_letter_versions">;

export interface NewCoverLetterVersion {
  candidacyId: string;
  userId: string;
  label?: string | null;
  /** The assembled letter text (the Scribe fills this; empty until then). */
  content?: string;
  details?: Json;
}

/** Create a fresh draft cover-letter version for a candidacy. `version_no` is the
 *  next per-candidacy ordinal, so versions cycle/roll back in a stable order. */
export async function createCoverLetterVersion(
  db: Db,
  v: NewCoverLetterVersion,
): Promise<CoverLetterVersion> {
  const rows = await db<CoverLetterVersion[]>`
    insert into cover_letter_versions (candidacy_id, user_id, version_no, status, label, content, details)
    values (
      ${v.candidacyId},
      ${v.userId},
      (select coalesce(max(version_no), 0) + 1 from cover_letter_versions
         where candidacy_id = ${v.candidacyId}),
      'draft',
      ${v.label ?? null},
      ${v.content ?? ""},
      ${v.details != null ? db.json(v.details as never) : db.json({} as never)}
    )
    returning *`;
  return rows[0];
}

/** All versions for a candidacy, oldest first (version_no order) — the history
 *  the client renders for review and rollback. */
export async function listCoverLetterVersions(
  db: Db,
  candidacyId: string,
): Promise<CoverLetterVersion[]> {
  return await db<CoverLetterVersion[]>`
    select * from cover_letter_versions
    where candidacy_id = ${candidacyId}
    order by version_no asc`;
}

/** A single cover-letter version by id, or undefined if it does not exist. */
export async function getCoverLetterVersion(
  db: Db,
  id: string,
): Promise<CoverLetterVersion | undefined> {
  const rows = await db<CoverLetterVersion[]>`
    select * from cover_letter_versions where id = ${id}`;
  return rows[0];
}

/** The candidacy's active (approved) cover-letter version, or undefined before
 *  the first approval — the empty-state signal the apply gate keys on. */
export async function getActiveCoverLetterVersion(
  db: Db,
  candidacyId: string,
): Promise<CoverLetterVersion | undefined> {
  const rows = await db<CoverLetterVersion[]>`
    select * from cover_letter_versions
    where candidacy_id = ${candidacyId} and status = 'approved'`;
  return rows[0];
}

/** Make `versionId` the candidacy's one active version: supersede the prior
 *  active row (if any) and flip the target to 'approved', atomically. The partial
 *  unique index guarantees at most one active version per candidacy. Throws if
 *  the version does not belong to the candidacy. */
export async function setActiveCoverLetterVersion(
  db: Db,
  candidacyId: string,
  versionId: string,
): Promise<CoverLetterVersion> {
  return await db.begin(async (tx) => {
    await tx`
      update cover_letter_versions set status = 'superseded'
      where candidacy_id = ${candidacyId} and status = 'approved' and id <> ${versionId}`;
    const rows = await tx<CoverLetterVersion[]>`
      update cover_letter_versions set status = 'approved'
      where id = ${versionId} and candidacy_id = ${candidacyId}
      returning *`;
    if (!rows[0]) {
      throw new Error(`cover-letter version ${versionId} not found for candidacy ${candidacyId}`);
    }
    return rows[0];
  });
}

/** Submit a draft cover-letter version for review: flip `draft → proposed` (the
 *  "submitted" state the Scribe leaves a freshly assembled letter in). The full
 *  proposal/interrupt approve-edit-reject loop is layered on later; this is the
 *  minimal submit the draft-assembly path needs. Throws if the version does not
 *  exist or is not a draft. */
export async function submitCoverLetterVersion(
  db: Db,
  versionId: string,
): Promise<CoverLetterVersion> {
  const rows = await db<CoverLetterVersion[]>`
    update cover_letter_versions set status = 'proposed'
    where id = ${versionId} and status = 'draft'
    returning *`;
  if (!rows[0]) {
    throw new Error(`cover-letter version ${versionId} not found or not a draft`);
  }
  return rows[0];
}

/** Archer's spoken note for a cover letter — the audio artifact a client plays
 *  aloud. The migration reserves the version's `details` jsonb for "the spoken-note
 *  artifact ref"; this merges it in under `spokenNote` (preserving other keys, and
 *  replacing any prior note) so the artifact is recorded on the version itself, not
 *  assumed to pre-exist. The synthesis is stubbed/swappable (services/api/tts.ts);
 *  this only persists the reference. Throws if the version does not exist. */
export async function recordCoverLetterSpokenNote(
  db: Db,
  versionId: string,
  note: { audioUrl: string; provider: string; durationMs: number },
): Promise<CoverLetterVersion> {
  const rows = await db<CoverLetterVersion[]>`
    update cover_letter_versions
    set details = details || ${db.json({ spokenNote: note } as never)}
    where id = ${versionId}
    returning *`;
  if (!rows[0]) {
    throw new Error(`cover-letter version ${versionId} not found`);
  }
  return rows[0];
}

// ── cover-letter revision loop (proposal-driven approve / edit / reject) ───────
// The cover-letter analogue of submitVersionProposal/applyVersionProposal (ARC-38).
// A proposed draft is submitted for review (a kind 'cover_letter_version' proposal,
// candidacy drafting → in_review); the owner then approves (optionally with edits),
// which materialises the version as the candidacy's one active letter (the prior
// active one superseded) and advances in_review → approved, or rejects, which
// returns the candidacy to drafting with the feedback captured. Provenance — the
// {candidacyId, userId, versionId} locator and the AG-UI interrupt it backs — rides
// on the proposal's plan jsonb; the candidacy FK ties it durably to the candidacy.

/** The AG-UI interrupt a submit run emitted, recorded on the proposal so any client
 *  can resolve the same proposal it surfaces. */
export interface CoverLetterInterruptRef {
  threadId: string;
  runId: string;
  interruptId: string;
  toolCallId: string;
}

export interface CoverLetterProposalInput {
  candidacyId: string;
  userId: string;
  versionId: string;
  title: string;
  rationale?: string | null;
  interrupt?: CoverLetterInterruptRef;
}

/** Submit a proposed cover-letter version for review: open a kind
 *  'cover_letter_version' proposal and advance the candidacy drafting → in_review,
 *  atomically. The draft is flipped to 'proposed' if it is still a draft (so submit
 *  is robust whether or not the Scribe already proposed it). Returns the proposal id. */
export async function submitCoverLetterVersionProposal(
  db: Db,
  p: CoverLetterProposalInput,
): Promise<{ id: string }> {
  return await db.begin(async (tx) => {
    const plan = {
      kind: "cover_letter_version",
      candidacyId: p.candidacyId,
      userId: p.userId,
      versionId: p.versionId,
      ...(p.interrupt ? { interrupt: p.interrupt } : {}),
    };
    const rows = await tx<{ id: string }[]>`
      insert into proposals (kind, title, rationale, plan, status, created_by, candidacy_id)
      values ('cover_letter_version', ${p.title}, ${p.rationale ?? null},
              ${tx.json(plan as never)}, 'submitted', 'agent', ${p.candidacyId})
      returning id`;
    await tx`
      update cover_letter_versions set status = 'proposed'
      where id = ${p.versionId} and candidacy_id = ${p.candidacyId} and status = 'draft'`;
    await tx`
      update candidacies set status = 'in_review', status_changed_at = now()
      where id = ${p.candidacyId} and status = 'drafting'`;
    return rows[0];
  });
}

/** A human's decision on a submitted cover-letter version proposal. `approve`
 *  (optionally with `edits` = approve-with-edits, a full replacement of the
 *  letter's fields) makes the version the candidacy's active letter; `reject`
 *  returns the candidacy to drafting with the feedback captured. */
export type CoverLetterVersionDecision =
  | {
      action: "approve";
      edits?: { content?: string; label?: string | null; details?: Json };
      note?: string | null;
    }
  | { action: "reject"; note?: string | null };

export interface CoverLetterApplyResult {
  /** Terminal proposal status: 'completed' | 'rejected' | 'failed' (or the prior
   *  terminal status on an idempotent replay of an already-decided proposal). */
  proposalStatus: Enum<"proposal_status">;
  /** The target version's status after the decision, if it still exists. */
  versionStatus: Enum<"cover_letter_version_status"> | null;
  /** The candidacy's status after the decision (approved / drafting / unchanged). */
  candidacyStatus: Enum<"candidacy_status"> | null;
  /** Set when the apply failed: the candidacy's active letter was left untouched. */
  error?: string;
}

/**
 * The cover-letter version apply executor. Decides a submitted
 * 'cover_letter_version' proposal:
 *  - approve / approve-with-edits: in ONE transaction, optionally apply the edited
 *    payload, supersede the prior active version, flip the target version to
 *    'approved', and advance the candidacy in_review → approved. The proposal
 *    becomes 'completed'. Any failure rolls the transaction back (the active letter
 *    is untouched) and the proposal is marked 'failed'.
 *  - reject: mark the proposal 'rejected' and the version 'rejected', and return the
 *    candidacy in_review → drafting so a fresh draft can be assembled and resubmitted.
 * Idempotent: only a still-'submitted' proposal is acted on, so a replay is a no-op
 * that returns the proposal's existing terminal state.
 */
export async function applyCoverLetterVersionProposal(
  db: Db,
  proposalId: string,
  decision: CoverLetterVersionDecision,
): Promise<CoverLetterApplyResult> {
  if (decision.action === "reject") {
    const claimed = await db<{ plan: { candidacyId: string; versionId: string } }[]>`
      update proposals set
        status = 'rejected', decided_at = now(),
        decision_note = coalesce(${decision.note ?? null}, decision_note)
      where id = ${proposalId} and kind = 'cover_letter_version' and status = 'submitted'
      returning plan`;
    if (!claimed[0]) return await coverLetterReplayedOutcome(db, proposalId);
    const { candidacyId, versionId } = claimed[0].plan;
    await db.begin(async (tx) => {
      await tx`
        update cover_letter_versions set status = 'rejected'
        where id = ${versionId} and candidacy_id = ${candidacyId} and status in ('proposed', 'draft')`;
      await tx`
        update candidacies set status = 'drafting', status_changed_at = now()
        where id = ${candidacyId} and status = 'in_review'`;
    });
    return await coverLetterOutcome(db, proposalId, candidacyId, versionId);
  }

  // approve / approve-with-edits. Claim the proposal to 'in_progress' first
  // (idempotent on 'submitted'); a concurrent or replayed call sees no row.
  const claimed = await db<{ plan: { candidacyId: string; versionId: string } }[]>`
    update proposals set status = 'in_progress', decided_at = now(),
      decision_note = coalesce(${decision.note ?? null}, decision_note)
    where id = ${proposalId} and kind = 'cover_letter_version' and status = 'submitted'
    returning plan`;
  if (!claimed[0]) return await coverLetterReplayedOutcome(db, proposalId);
  const { candidacyId, versionId } = claimed[0].plan;
  const edits = decision.edits;

  try {
    await db.begin(async (tx) => {
      if (edits) {
        await tx`
          update cover_letter_versions set
            content = coalesce(${edits.content ?? null}, content),
            label = coalesce(${edits.label ?? null}, label),
            details = coalesce(${edits.details != null ? tx.json(edits.details as never) : null}::jsonb, details)
          where id = ${versionId} and candidacy_id = ${candidacyId}`;
      }
      // Supersede the prior active version so the partial unique index never clashes.
      await tx`
        update cover_letter_versions set status = 'superseded'
        where candidacy_id = ${candidacyId} and status = 'approved' and id <> ${versionId}`;
      // Flip the target version active — only a still-proposable version qualifies.
      const approved = await tx<{ id: string }[]>`
        update cover_letter_versions set status = 'approved'
        where id = ${versionId} and candidacy_id = ${candidacyId} and status in ('proposed', 'draft')
        returning id`;
      if (!approved[0]) {
        throw new Error(`cover-letter version ${versionId} is not in a proposable state`);
      }
      await tx`
        update candidacies set status = 'approved', status_changed_at = now()
        where id = ${candidacyId} and status = 'in_review'`;
      await tx`update proposals set status = 'completed' where id = ${proposalId}`;
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db`
      update proposals set status = 'failed', decision_note = ${message}
      where id = ${proposalId}`;
    return {
      ...(await coverLetterOutcome(db, proposalId, candidacyId, versionId)),
      error: message,
    };
  }

  return await coverLetterOutcome(db, proposalId, candidacyId, versionId);
}

/** The current status of a cover-letter version, or null if it no longer exists. */
async function coverLetterVersionStatus(
  db: Db,
  versionId: string,
): Promise<Enum<"cover_letter_version_status"> | null> {
  const rows = await db<{ status: Enum<"cover_letter_version_status"> }[]>`
    select status from cover_letter_versions where id = ${versionId}`;
  return rows[0]?.status ?? null;
}

/** The proposal/version/candidacy status triple after a decision (read back from
 *  the proposal's current status, not assumed from the action). */
async function coverLetterOutcome(
  db: Db,
  proposalId: string,
  candidacyId: string,
  versionId: string,
): Promise<CoverLetterApplyResult> {
  const rows = await db<{ status: Enum<"proposal_status"> }[]>`
    select status from proposals where id = ${proposalId}`;
  return {
    proposalStatus: rows[0]?.status ?? "submitted",
    versionStatus: await coverLetterVersionStatus(db, versionId),
    candidacyStatus: (await getCandidacy(db, candidacyId))?.status ?? null,
  };
}

/** The outcome of a replay (the proposal was already decided): report its current
 *  status and the version/candidacy status without mutating anything. */
async function coverLetterReplayedOutcome(
  db: Db,
  proposalId: string,
): Promise<CoverLetterApplyResult> {
  const rows = await db<
    { status: Enum<"proposal_status">; plan: { candidacyId?: string; versionId?: string } }[]
  >`
    select status, plan from proposals where id = ${proposalId}`;
  const proposal = rows[0];
  if (!proposal) throw new Error(`proposal ${proposalId} not found`);
  return {
    proposalStatus: proposal.status,
    versionStatus: proposal.plan?.versionId
      ? await coverLetterVersionStatus(db, proposal.plan.versionId)
      : null,
    candidacyStatus: proposal.plan?.candidacyId
      ? ((await getCandidacy(db, proposal.plan.candidacyId))?.status ?? null)
      : null,
  };
}

// ── external application forms: the off-board redirect record (ARC-41) ──────
// When the apply adapter reports a `redirect`, the application must be completed
// on an external site. One row per redirect (see
// 20260620210000_external_application_forms.sql) carries the URL and walks
// pending → in_progress → completed | failed as the external-fill agent works it.
export type ExternalApplicationForm = Row<"external_application_forms">;
export type ExternalFormStatus = Enum<"external_form_status">;

export interface NewExternalApplicationForm {
  candidacyId: string;
  userId: string;
  url: string;
  /** The approved letter the form is filled from (provenance). */
  coverLetterVersionId?: string | null;
  detail?: Json;
}

/** Insert a `pending` external application form for a redirected application. */
export async function createExternalApplicationForm(
  db: Db,
  f: NewExternalApplicationForm,
): Promise<ExternalApplicationForm> {
  const rows = await db<ExternalApplicationForm[]>`
    insert into external_application_forms (candidacy_id, user_id, cover_letter_version_id, url, detail)
    values (${f.candidacyId}, ${f.userId}, ${f.coverLetterVersionId ?? null}, ${f.url},
            ${db.json((f.detail ?? {}) as never)})
    returning *`;
  return rows[0];
}

/** Read one external application form by id (undefined if it does not exist). */
export async function getExternalApplicationForm(
  db: Db,
  id: string,
): Promise<ExternalApplicationForm | undefined> {
  const rows = await db<ExternalApplicationForm[]>`
    select * from external_application_forms where id = ${id}`;
  return rows[0];
}

/** The candidacy's one OPEN (pending/in_progress) external form, newest first —
 *  what the external-fill Activity picks up. Undefined when none is open. */
export async function getOpenExternalApplicationForm(
  db: Db,
  candidacyId: string,
): Promise<ExternalApplicationForm | undefined> {
  const rows = await db<ExternalApplicationForm[]>`
    select * from external_application_forms
    where candidacy_id = ${candidacyId} and status in ('pending', 'in_progress')
    order by created_at desc limit 1`;
  return rows[0];
}

/** Advance an external form's status. Stamps started_at on the move to
 *  in_progress and finished_at on completed|failed; merges detail and sets the
 *  error (on failure). Mirrors the Activity lifecycle helpers above. */
export async function setExternalApplicationFormStatus(
  db: Db,
  id: string,
  status: ExternalFormStatus,
  opts: { detail?: Json; error?: string | null } = {},
): Promise<void> {
  await db`
    update external_application_forms set
      status = ${status}::external_form_status,
      detail = detail || ${db.json((opts.detail ?? {}) as never)},
      error = coalesce(${opts.error ?? null}, error),
      started_at = case when ${status} = 'in_progress' then now() else started_at end,
      finished_at = case when ${status} in ('completed', 'failed') then now() else finished_at end
    where id = ${id}`;
}

export interface OpenExternalFormInput extends NewExternalApplicationForm {
  /** The owner-facing proposal title (the agent→owner control channel). */
  title?: string;
}

/** Raise an off-board redirect: insert the pending external form, open an
 *  owner-facing proposal carrying the URL (the durable "interrupt" — the
 *  agent→owner control channel), and push the owner a notification — all in one
 *  transaction. Returns the form + proposal ids. The caller then transitions the
 *  candidacy to external_pending, which webhooks the external-fill path. */
export async function openExternalApplicationForm(
  db: Db,
  f: OpenExternalFormInput,
): Promise<{ formId: string; proposalId: string }> {
  return await db.begin(async (tx) => {
    const [form] = await tx<{ id: string }[]>`
      insert into external_application_forms (candidacy_id, user_id, cover_letter_version_id, url, detail)
      values (${f.candidacyId}, ${f.userId}, ${f.coverLetterVersionId ?? null}, ${f.url},
              ${tx.json((f.detail ?? {}) as never)})
      returning id`;
    const plan = {
      kind: "external_application",
      candidacyId: f.candidacyId,
      userId: f.userId,
      formId: form.id,
      url: f.url,
    };
    const [proposal] = await tx<{ id: string }[]>`
      insert into proposals (kind, title, rationale, plan, status, created_by, candidacy_id)
      values ('external_application', ${f.title ?? "Complete your external application"},
              ${`This role redirected to an external application form: ${f.url}`},
              ${tx.json(plan as never)}, 'submitted', 'agent', ${f.candidacyId})
      returning id`;
    await tx`
      insert into notifications (user_id, kind, title, body, ref)
      values (${f.userId}, 'application', 'An external application needs completing',
              ${`This role redirected off-board — the application form at ${f.url} is being completed.`},
              ${tx.json({ candidacyId: f.candidacyId, formId: form.id, url: f.url } as never)})`;
    return { formId: form.id, proposalId: proposal.id };
  });
}

/** The enriched company behind a candidacy (via its posting), for the external
 *  fill surface's company read. Undefined when the candidacy has no company. */
export async function getCandidacyCompany(
  db: Db,
  candidacyId: string,
): Promise<Company | undefined> {
  const rows = await db<Company[]>`
    select co.* from candidacies c
    join postings p on p.id = c.posting_id
    join companies co on co.id = p.company_id
    where c.id = ${candidacyId}`;
  return rows[0];
}

export type Project = Row<"projects">;

/** A user's portfolio: the projects on their live (approved) profile version.
 *  Empty when there is no approved version or it carries no projects. */
export async function listPortfolioProjects(db: Db, userId: string): Promise<Project[]> {
  return await db<Project[]>`
    select pr.* from projects pr
    join profile_versions v on v.id = pr.version_id
    where v.user_id = ${userId} and v.status = 'approved'
    order by pr.created_at asc`;
}
