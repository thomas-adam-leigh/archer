import { timingSafeEqual } from "node:crypto";
import {
  type AccountDecision,
  addNegativeCriterion,
  addTargetTitle,
  appendEvents,
  applyCoverLetterVersionProposal,
  applyCoverLetterVersionProposalAsUser,
  applyVersionProposal,
  applyVersionProposalAsUser,
  Constants,
  type CoverLetterVersionDecision,
  checkReadiness,
  completeOnboarding,
  confirmApply,
  createCoverLetterVersion,
  createInterruptProposal,
  createProfileVersion,
  createRun,
  decideAccount,
  decideInterruptProposal,
  type Enums,
  failActivity,
  finishRun,
  getAccount,
  getCandidacy,
  getCandidacyContext,
  getCandidacyDetail,
  getCompanyDetail,
  getCoverLetterVersion,
  getDailyRun,
  getLiveProfileVersion,
  getOnboardingProgress,
  getOpenCoverLetterVersionProposal,
  getOpenProfileVersionProposal,
  getProfile,
  getProfileVersion,
  getThreadOwner,
  IllegalCandidacyTransitionError,
  ingestProposedVersion,
  ingestVoicenote,
  isAccepted,
  type Json,
  listActivities,
  listAllActivities,
  listBoards,
  listCandidacies,
  listCompanies,
  listCoverLetterVersionSummaries,
  listCoverLetterVersions,
  listNegativeCriteria,
  listProfileVersions,
  listTargetTitles,
  loadThreadEvents,
  loadThreadInterrupts,
  type ProfilePatch,
  readProfileSpine,
  recordCoverLetterSpokenNote,
  removeNegativeCriterion,
  removeTargetTitle,
  rollbackToVersion,
  setCandidacyStatus,
  setTargetTitles,
  startActivity,
  submitAccountForReview,
  submitCoverLetterVersion,
  submitCoverLetterVersionProposal,
  submitVersionProposal,
  succeedActivity,
  transitionCandidacy,
  upsertProfile,
  userOwnsCompany,
  type VersionDecision,
  writeProfileSpine,
} from "@archer/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { cors } from "hono/cors";
import {
  classifyRun,
  coverLetterSubmitRun,
  draftAttributes,
  draftContent,
  guidedOnboardingRun,
  interruptsFromEvents,
  onboardingRun,
  outcomeFromEvents,
  type ResolvedInterrupt,
  type RunAgentInput,
  restoreThread,
  resumeIngestRun,
  resumeIngestSegments,
  reviseDraftRun,
  runError,
  runErrorTail,
  runStub,
  scribeRun,
  statusFromEvents,
} from "./agui.js";
import { verifySupabaseJwt } from "./auth.js";
import { getBrain } from "./brain.js";
import { runCli } from "./cli.js";
import { getDb } from "./db.js";
import { signResumeUrl } from "./ingest/sign.js";
import { extractResume } from "./ingest.js";
import { buildTranscript, hasSpine, structureConversation } from "./onboarding/converse.js";
import { reviseDraft } from "./onboarding/revise.js";
import { getScribe } from "./scribe.js";
import { suggestTargetTitles } from "./titles.js";
import { stubSynthesizer } from "./tts.js";

const CANDIDACY_STATUSES = Constants.public.Enums.candidacy_status as readonly string[];
const ACTIVITY_TYPES = Constants.public.Enums.activity_type as readonly string[];
const ACTIVITY_STATUSES = Constants.public.Enums.activity_status as readonly string[];
const COMPANY_STATUSES = Constants.public.Enums.company_status as readonly string[];
// Validate path/query values before they reach the CLI argv or the DB.
const BOARD_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Minimal context shape the auth helpers read — keeps them decoupled from the
// generated per-route Context types the OpenAPIHono handlers carry.
type AuthCtx = { req: { header(name: string): string | undefined } };

// The authenticated caller behind a request. Two planes (ARC-83):
//   • service — the trusted server-to-server caller (shared secret or the non-prod
//     dev opt-in): full trust, may act for ANY user via an explicit `user`/`userId`.
//   • user — an end user proven by their Supabase JWT: scoped to their own
//     `auth.uid` (the verified `sub`); cannot act for anyone else.
type Principal = { kind: "service" } | { kind: "user"; userId: string };

// The shared-secret check (server-to-server). Fail closed: require the secret
// (constant-time compare); with no secret set, deny unless the non-prod dev opt-in
// (ARCHER_API_DEV_OPEN=1) is on.
function serviceSecretOk(c: AuthCtx): boolean {
  const secret = process.env.ARCHER_API_SECRET;
  if (secret) return safeEqual(c.req.header("x-archer-secret") ?? "", secret);
  return process.env.NODE_ENV !== "production" && process.env.ARCHER_API_DEV_OPEN === "1";
}

// Server-to-server gate for the internal control plane (commands, webhooks): the
// shared service secret only. These routes drive the CLI / cron and are never
// reached by an end user's JWT, so JWT auth is deliberately NOT accepted here.
function authorized(c: AuthCtx): boolean {
  return serviceSecretOk(c);
}

// User-facing gate (ARC-83): accept EITHER a valid service secret (full trust) OR
// a valid Supabase JWT (scoped to the verified user). Fail closed — a Bearer token
// that is present but invalid/expired/tampered is rejected, never silently ignored.
async function authenticate(c: AuthCtx): Promise<Principal | null> {
  if (serviceSecretOk(c)) return { kind: "service" };
  const header = c.req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const userId = await verifySupabaseJwt(match[1]);
  return userId ? { kind: "user", userId } : null;
}

// Resolve the effective user for a single-user route. A JWT user is pinned to its
// own verified `sub`: identity comes from the TOKEN, never from caller input — a
// mismatching explicit `user`/`userId` is refused (403), closing the
// impersonation hole. The service caller keeps the existing
// requested-or-`ARCHER_USER_ID` behaviour (full trust).
function scopedUser(
  principal: Principal,
  requested: string | undefined,
): { user: string } | { error: string; status: 400 | 403 } {
  if (principal.kind === "user") {
    if (requested && requested !== principal.userId) {
      return { error: "forbidden: token does not match requested user", status: 403 };
    }
    return { user: principal.userId };
  }
  const user = requested ?? process.env.ARCHER_USER_ID;
  if (!user || !UUID_RE.test(user)) return { error: "invalid user", status: 400 };
  return { user };
}

// Ownership check for routes whose owner the server resolves itself (e.g. the
// thread owner): the service caller may act for anyone; a JWT user only for their
// own resources.
function principalOwns(principal: Principal, ownerId: string): boolean {
  return principal.kind === "service" || principal.userId === ownerId;
}

// Owner/admin gate for the human-decision routes — account acceptance and the
// profile/cover-letter version approvals (ARC-51). These resolve a human gate, so
// they require a SEPARATE owner credential (ARCHER_API_ADMIN_SECRET via the
// `x-archer-admin-secret` header), not the general service secret: a caller
// holding only the service secret must not be able to accept accounts or approve
// versions. Mirrors `authorized`'s fail-closed shape — require the owner secret
// when set, else allow only the explicit non-prod dev opt-in.
function ownerAuthorized(c: AuthCtx): boolean {
  const adminSecret = process.env.ARCHER_API_ADMIN_SECRET;
  if (adminSecret) return safeEqual(c.req.header("x-archer-admin-secret") ?? "", adminSecret);
  return process.env.NODE_ENV !== "production" && process.env.ARCHER_API_DEV_OPEN === "1";
}

// Fail-closed-in-prod startup invariant (ARC-55). `authorized`/`ownerAuthorized`
// only fall back to the dev-open bypass when `NODE_ENV !== "production"`, so a
// production deploy that simply forgot `ARCHER_API_SECRET` would boot and serve a
// uselessly locked (every request 401) — or, if NODE_ENV were also wrong, an open —
// API. Assert the high-value service secret is present in production and crash
// loudly at boot instead, so the misconfiguration is caught before traffic. Pure
// and env-injectable so it's unit-testable; `index.ts` calls it before `serve`.
export function assertSecureStartup(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === "production" && !env.ARCHER_API_SECRET) {
    throw new Error(
      "Refusing to start: ARCHER_API_SECRET must be set in production (fail-closed). " +
        "The Hono API is a server-to-server control plane; see docs/SECURITY-OPS-RUNBOOK.md.",
    );
  }
}

// ── Shared zod schemas ──────────────────────────────────────────────────────
// A UUID string, and the board slug guard, both surfaced in the OpenAPI doc and
// enforced as real request validation (a failure becomes a 400 via defaultHook).
const Uuid = z.string().regex(UUID_RE);
const Board = z.string().regex(BOARD_RE);
const candidacyStatus = z.enum(CANDIDACY_STATUSES as unknown as [string, ...string[]]);
const activityType = z.enum(ACTIVITY_TYPES as unknown as [string, ...string[]]);
const activityStatus = z.enum(ACTIVITY_STATUSES as unknown as [string, ...string[]]);
const companyStatus = z.enum(COMPANY_STATUSES as unknown as [string, ...string[]]);
// A `YYYY-MM-DD` calendar date (UTC) — the daily-run grouping key (ARC-143).
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// Response bodies stay permissive (`z.any()`) so each handler's existing return
// shape satisfies every declared status without churn — and the heavy event/spread
// literals are cast to a shallow type at the `c.json` call to keep TypeScript's
// instantiation depth in check (TS2589). The value of this issue is the *request*
// validation, which stays fully typed. The two documented routes (`/`, `/health`)
// pass an explicit schema so their published contract — and the typed `hc` client
// the CLI's `health` command relies on — stays precise.
const OkBody = z.any();
const ErrBody = z.any();
const jsonBody = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});
const ok = <T extends z.ZodType>(description = "OK", schema: T = OkBody as unknown as T) =>
  jsonBody(schema, description);
// The error responses each route may emit; spread the ones a route uses.
const ERR = {
  400: jsonBody(ErrBody, "Invalid request"),
  401: jsonBody(ErrBody, "Unauthorized"),
  403: jsonBody(ErrBody, "Forbidden"),
  404: jsonBody(ErrBody, "Not found"),
  409: jsonBody(ErrBody, "Conflict"),
  500: jsonBody(ErrBody, "Server error"),
  502: jsonBody(ErrBody, "Upstream CLI error"),
};

const SERVICE_SECURITY = [{ serviceSecret: [] }];
const OWNER_SECURITY = [{ ownerSecret: [] }];

// The allowed `profiles.work_pref` values (ARC-133), straight from the schema's
// runtime enum so they can't drift from the migration.
type WorkMode = Enums<"work_mode">;
const WORK_MODES: readonly WorkMode[] = Constants.public.Enums.work_mode;

// One OpenAPIHono per route group. The route definitions are split across several
// groups and merged with `.route()` below: a single 35-link `.openapi()` chain
// blows TypeScript's generic instantiation depth (TS2589), whereas grouping keeps
// each chain short while the merged `AppType` still carries every route for `hc`.
//
// `defaultHook` turns any failed zod validation (params/query/body) into a 400 —
// preserving the API's existing "invalid request → 400" contract instead of the
// library's default. Auth (401) still runs inside the handler, so the fail-closed
// tests that send a *valid* payload with no secret continue to see 401.
const mk = () =>
  new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: "invalid request", issues: result.error.issues }, 400);
      }
    },
  });

const gCore = mk()
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      responses: {
        200: ok("Service identity", z.object({ name: z.string(), status: z.string() })),
      },
    }),
    (c) => c.json({ name: "archer-api", status: "ok" }),
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/health",
      responses: { 200: ok("Health probe", z.object({ status: z.string() })) },
    }),
    (c) => c.json({ status: "ok" }),
  )
  // Trigger a collect run by invoking the CLI (browser work stays in the CLI).
  .openapi(
    createRoute({
      method: "post",
      path: "/commands/collect/{board}",
      security: SERVICE_SECURITY,
      request: { params: z.object({ board: Board }), query: z.object({ user: Uuid.optional() }) },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403], 502: ERR[502] },
    }),
    async (c) => {
      if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
      const { board } = c.req.valid("param");
      const user = c.req.valid("query").user ?? process.env.ARCHER_USER_ID;
      // Acceptance gate (ARC-31): collect/match run only for an accepted account.
      if (user && !(await isAccepted(getDb(), user))) {
        return c.json({ error: "account not accepted" }, 403);
      }
      const args = ["collect", board, "--json"];
      if (user) args.push("--user", user);
      const res = await runCli(args);
      if (res.code !== 0) {
        return c.json({ error: res.stderr.trim() || "collect failed", code: res.code }, 502);
      }
      return c.json(JSON.parse(res.stdout));
    },
  )
  // Trigger a Matchmaker pass by invoking the CLI. This is the per-minute matcher
  // cron's target (20260620180000_event_engine.sql): the cron only POSTs here when
  // `new` candidacies exist, and `match` is itself a no-op when there are none.
  .openapi(
    createRoute({
      method: "post",
      path: "/commands/match",
      security: SERVICE_SECURITY,
      request: { query: z.object({ user: Uuid.optional() }) },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403], 502: ERR[502] },
    }),
    async (c) => {
      if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
      const user = c.req.valid("query").user ?? process.env.ARCHER_USER_ID;
      if (user && !(await isAccepted(getDb(), user))) {
        return c.json({ error: "account not accepted" }, 403);
      }
      const args = ["match", "--json"];
      if (user) args.push("--user", user);
      const res = await runCli(args);
      if (res.code !== 0) {
        return c.json({ error: res.stderr.trim() || "match failed", code: res.code }, 502);
      }
      return c.json(JSON.parse(res.stdout));
    },
  )
  // Trigger a company enrichment by invoking the CLI (the Researcher's LinkedIn MCP +
  // Firecrawl calls stay in the CLI process, stubbed for now). Same "API runs the CLI"
  // model as collect/match — the run is real, the tools are faked. Company-scoped (no
  // user gate): enrichment fires for shortlisted companies, not per requesting user.
  .openapi(
    createRoute({
      method: "post",
      path: "/commands/enrich/{companyId}",
      security: SERVICE_SECURITY,
      request: { params: z.object({ companyId: Uuid }) },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 502: ERR[502] },
    }),
    async (c) => {
      if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
      const { companyId } = c.req.valid("param");
      const res = await runCli(["enrich", companyId, "--json"]);
      if (res.code !== 0) {
        return c.json({ error: res.stderr.trim() || "enrich failed", code: res.code }, 502);
      }
      return c.json(JSON.parse(res.stdout));
    },
  )
  // Trigger an apply by invoking the CLI (the apply adapter's browser automation
  // stays in the CLI process, stubbed for now). Same "API runs the CLI" model as
  // collect/match/enrich — the run is real, the browser work is faked. The CLI
  // gates on an `approved` cover letter, so this fires the one irreversible action
  // only on a candidacy whose letter the owner already approved (ARC-38).
  .openapi(
    createRoute({
      method: "post",
      path: "/commands/apply/{candidacyId}",
      security: SERVICE_SECURITY,
      request: { params: z.object({ candidacyId: Uuid }) },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 502: ERR[502] },
    }),
    async (c) => {
      if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
      const { candidacyId } = c.req.valid("param");
      const res = await runCli(["apply", candidacyId, "--json"]);
      if (res.code !== 0) {
        return c.json({ error: res.stderr.trim() || "apply failed", code: res.code }, 502);
      }
      return c.json(JSON.parse(res.stdout));
    },
  );

const gFeed = mk()
  // Jobs feed (ARC-11): a user's candidacies joined to their posting/company —
  // title, board, company, status, triage decision, match score — optionally
  // filtered by status. RLS own-rows-only (scoped on user_id); the thin clients
  // poll this for the kanban and write via the transition command below. Live
  // fan-out itself rides the Substrate's Realtime transport on the events table.
  .openapi(
    createRoute({
      method: "get",
      path: "/jobs",
      security: SERVICE_SECURITY,
      request: { query: z.object({ user: Uuid.optional(), status: candidacyStatus.optional() }) },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403] },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const q = c.req.valid("query");
      const resolved = scopedUser(principal, q.user);
      if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
      const user = resolved.user;
      const jobs = await listCandidacies(getDb(), user, { status: q.status as never });
      return c.json({ user, jobs });
    },
  )
  // Job detail (ARC-146): one candidacy with its full posting, the why-matched
  // (triage decision/reason/match score), a company summary, and any external-form
  // state — the data behind the M2 job-detail view. JWT-scoped own rows: a missing
  // candidacy 404s, another user's candidacy 403s (ownership read off the row's
  // user_id, never the request), so a caller can only read their own.
  .openapi(
    createRoute({
      method: "get",
      path: "/candidacies/{id}",
      security: SERVICE_SECURITY,
      request: { params: z.object({ id: Uuid }) },
      responses: { 200: ok(), 401: ERR[401], 403: ERR[403], 404: ERR[404] },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const { id } = c.req.valid("param");
      const candidacy = await getCandidacyDetail(getDb(), id);
      if (!candidacy) return c.json({ error: "unknown candidacy" }, 404);
      if (!principalOwns(principal, candidacy.user_id)) {
        return c.json({ error: "forbidden" }, 403);
      }
      return c.json({ candidacy });
    },
  )
  // Apply-confirm (ARC-165): the owner's explicit go-ahead on an approved candidacy —
  // the gate the one irreversible action (apply) waits behind. Approving a cover
  // letter does NOT auto-apply; the owner must confirm here, which stamps the
  // confirmation and then fires the apply via the CLI (same "API runs the CLI" model
  // as /commands/apply). JWT-scoped own rows: another user's candidacy 403s, a missing
  // one 404s. Only an `approved` candidacy is awaiting confirmation — anything else
  // (still drafting, already applying/applied, dismissed) is rejected 409, so you can
  // neither confirm before the letter is approved nor re-confirm an in-flight apply.
  .openapi(
    createRoute({
      method: "post",
      path: "/candidacies/{id}/apply-confirm",
      security: SERVICE_SECURITY,
      request: { params: z.object({ id: Uuid }) },
      responses: {
        200: ok(),
        401: ERR[401],
        403: ERR[403],
        404: ERR[404],
        409: ERR[409],
        502: ERR[502],
      },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const { id } = c.req.valid("param");
      const candidacy = await getCandidacy(getDb(), id);
      if (!candidacy) return c.json({ error: "unknown candidacy" }, 404);
      if (!principalOwns(principal, candidacy.user_id)) {
        return c.json({ error: "forbidden" }, 403);
      }
      const confirmed = await confirmApply(getDb(), id);
      if (!confirmed) {
        return c.json(
          { error: `candidacy is not awaiting apply-confirm (status: ${candidacy.status})` },
          409,
        );
      }
      // Confirmation stamped — fire the apply. The CLI re-reads the now-confirmed
      // candidacy, so its apply-confirm gate passes and the application proceeds.
      const res = await runCli(["apply", id, "--json"]);
      if (res.code !== 0) {
        return c.json({ error: res.stderr.trim() || "apply failed", code: res.code }, 502);
      }
      return c.json(JSON.parse(res.stdout));
    },
  )
  // Activities feed (ARC-43): a user's own runs (collect/match/enrich/cover_letter/
  // apply/external_fill/proposal_exec/transcribe) — the observability read surface
  // over the universal Activity primitive, newest first, optionally filtered by
  // type/status. RLS own-rows-only (scoped on user_id); system-level rows (e.g.
  // `deploy`, user_id null) are deliberately hidden here — the operator surfaces
  // them via the owner-gated GET /admin/activities below.
  .openapi(
    createRoute({
      method: "get",
      path: "/activities",
      security: SERVICE_SECURITY,
      request: {
        query: z.object({
          user: Uuid.optional(),
          type: activityType.optional(),
          status: activityStatus.optional(),
        }),
      },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403] },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const q = c.req.valid("query");
      const resolved = scopedUser(principal, q.user);
      if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
      const user = resolved.user;
      const activities = await listActivities(getDb(), user, {
        type: q.type as never,
        status: q.status as never,
      });
      return c.json({ user, activities });
    },
  )
  // Daily-run summary (ARC-143): the user's collect activities for one UTC day rolled
  // up into a single coherent story the Web App dashboard renders — per-board outcomes
  // plus the run totals, with an overall `status` that moves `in_progress` → `done`.
  // Defaults to today; `?date=YYYY-MM-DD` fetches a past run. Scoped like /activities
  // (own rows; the optional `?user=` is owner-resolved by scopedUser).
  .openapi(
    createRoute({
      method: "get",
      path: "/activities/daily",
      security: SERVICE_SECURITY,
      request: {
        query: z.object({
          user: Uuid.optional(),
          date: IsoDate.optional(),
        }),
      },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403] },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const q = c.req.valid("query");
      const resolved = scopedUser(principal, q.user);
      if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
      const user = resolved.user;
      const run = await getDailyRun(getDb(), user, { date: q.date });
      return c.json({ user, run });
    },
  )
  // Boards integration status (ARC-147): the seeded job boards with their per-
  // capability collect/apply integration status — the data behind the home "boards
  // I'll sweep" panel (which boards are live for collect vs apply). No per-user data,
  // so any authenticated principal may read it; the internal columns (credential env
  // prefix, base URL) are deliberately projected away and never exposed.
  .openapi(
    createRoute({
      method: "get",
      path: "/boards",
      security: SERVICE_SECURITY,
      responses: { 200: ok(), 401: ERR[401] },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const boards = (await listBoards(getDb())).map((b) => ({
        slug: b.slug,
        name: b.name,
        collect_status: b.collect_status,
        apply_status: b.apply_status,
      }));
      return c.json({ boards });
    },
  )
  // Companies list (ARC-144): the user's relevant companies — those attached to one
  // of their candidacies — with the enrichment `status` the dashboard's company
  // kanban groups by, optionally filtered by `?status=`. RLS own-rows-only (scoped
  // via the candidacy→posting→company join); the raw enrichment blob and recruitment
  // email are left to the per-company detail read below.
  .openapi(
    createRoute({
      method: "get",
      path: "/companies",
      security: SERVICE_SECURITY,
      request: {
        query: z.object({ user: Uuid.optional(), status: companyStatus.optional() }),
      },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403] },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const q = c.req.valid("query");
      const resolved = scopedUser(principal, q.user);
      if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
      const user = resolved.user;
      const companies = await listCompanies(getDb(), user, { status: q.status as never });
      return c.json({ user, companies });
    },
  )
  // Company detail (ARC-144): one company with its full identity, the enrichment
  // payload the Researcher wrote, and its contacts — the data behind the M4
  // company-detail view. JWT-scoped own rows: a company is the user's only if they
  // hold a candidacy there, so an unknown id 404s and a company they have no
  // candidacy with 403s (the service caller may read any).
  .openapi(
    createRoute({
      method: "get",
      path: "/companies/{id}",
      security: SERVICE_SECURITY,
      request: { params: z.object({ id: Uuid }) },
      responses: { 200: ok(), 401: ERR[401], 403: ERR[403], 404: ERR[404] },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const { id } = c.req.valid("param");
      const company = await getCompanyDetail(getDb(), id);
      if (!company) return c.json({ error: "unknown company" }, 404);
      if (principal.kind === "user" && !(await userOwnsCompany(getDb(), principal.userId, id))) {
        return c.json({ error: "forbidden" }, 403);
      }
      return c.json({ company });
    },
  )
  // Cover-letter version history (ARC-145): a candidacy's cover-letter versions as
  // history summaries (version_no/status/label/created_at), the list the M3 Cover
  // letters route renders. Carries the open (submitted) cover_letter_version
  // proposal's id + target version (ARC-150) — null when none is awaiting a
  // decision — so the review loop self-decides it (the cover-letter analogue of
  // `/onboarding/progress`'s openProposalId). JWT-scoped own rows: ownership is read
  // off the candidacy (an unknown candidacy 404s, another user's 403s) before any
  // version is listed.
  .openapi(
    createRoute({
      method: "get",
      path: "/candidacies/{id}/cover-letters",
      security: SERVICE_SECURITY,
      request: { params: z.object({ id: Uuid }) },
      responses: { 200: ok(), 401: ERR[401], 403: ERR[403], 404: ERR[404] },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const { id } = c.req.valid("param");
      const candidacy = await getCandidacy(getDb(), id);
      if (!candidacy) return c.json({ error: "unknown candidacy" }, 404);
      if (!principalOwns(principal, candidacy.user_id)) {
        return c.json({ error: "forbidden" }, 403);
      }
      const versions = await listCoverLetterVersionSummaries(getDb(), id);
      const open = await getOpenCoverLetterVersionProposal(getDb(), id);
      return c.json({
        versions,
        openProposalId: open?.proposalId ?? null,
        proposedVersionId: open?.versionId ?? null,
      });
    },
  )
  // Cover-letter version detail (ARC-145): one version's full content + status +
  // the `details` long tail (incl. the spoken-note artifact audioUrl/provider) —
  // the data behind a single letter in the review loop. JWT-scoped own rows: the
  // version carries user_id directly, so an unknown id 404s and another user's 403s.
  .openapi(
    createRoute({
      method: "get",
      path: "/cover-letters/{versionId}",
      security: SERVICE_SECURITY,
      request: { params: z.object({ versionId: Uuid }) },
      responses: { 200: ok(), 401: ERR[401], 403: ERR[403], 404: ERR[404] },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const { versionId } = c.req.valid("param");
      const version = await getCoverLetterVersion(getDb(), versionId);
      if (!version) return c.json({ error: "unknown cover-letter version" }, 404);
      if (!principalOwns(principal, version.user_id)) {
        return c.json({ error: "forbidden" }, 403);
      }
      return c.json({ version });
    },
  )
  // Operator/admin activity view (ARC-44): the same observability feed, but across
  // ALL users *and* system-level rows (user_id null, e.g. `deploy`) that the
  // per-user /activities surface hides. Owner-gated (ARCHER_API_ADMIN_SECRET, the
  // ARC-51 identity) — not the general service secret — so a normal caller never
  // sees system or other users' runs. Each row carries `user_id` so the operator
  // can attribute it (null = a system run).
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/activities",
      security: OWNER_SECURITY,
      request: {
        query: z.object({
          type: activityType.optional(),
          status: activityStatus.optional(),
        }),
      },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403] },
    }),
    async (c) => {
      if (!ownerAuthorized(c)) return c.json({ error: "unauthorized" }, 401);
      const q = c.req.valid("query");
      const activities = await listAllActivities(getDb(), {
        type: q.type as never,
        status: q.status as never,
      });
      return c.json({ activities });
    },
  )
  // DB-only command: move a candidacy through the kanban (in-process, no CLI). The
  // move goes through the status machine (transitionCandidacy), so an illegal jump
  // (e.g. new → applied) is rejected 409 rather than silently corrupting the kanban.
  .openapi(
    createRoute({
      method: "post",
      path: "/commands/candidacies/{id}/transition",
      security: SERVICE_SECURITY,
      request: {
        params: z.object({ id: Uuid }),
        body: jsonBody(
          z.object({ to: candidacyStatus, reason: z.string().optional() }),
          "Target status",
        ),
      },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 404: ERR[404], 409: ERR[409] },
    }),
    async (c) => {
      if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
      const { id } = c.req.valid("param");
      const { to, reason } = c.req.valid("json");
      try {
        const updated = await transitionCandidacy(getDb(), id, to as never, { reason });
        if (!updated) return c.json({ error: "unknown candidacy" }, 404);
        return c.json({ id: updated.id, status: updated.status });
      } catch (err) {
        if (err instanceof IllegalCandidacyTransitionError) {
          return c.json({ error: err.message, from: err.from, to: err.to }, 409);
        }
        throw err;
      }
    },
  )
  // AG-UI run lifecycle: open a run, drive the stubbed agent, persist its ordered
  // event log, then close the run with its terminal status/outcome. The agent is a
  // deterministic stub (see ./agui.ts) — the run loop is real, the brain is stubbed.
  //
  // The interrupt/resume contract is enforced here from the thread's open vs
  // decided interrupts (classifyRun): a fresh request while interrupts are open is
  // a RunError; a resume opens a CHILD run (parent_run_id set), records the human's
  // decision on the proposal substrate, and continues; a replayed resume is a no-op.
  .openapi(
    createRoute({
      method: "post",
      path: "/agui/run",
      security: SERVICE_SECURITY,
      request: {
        body: jsonBody(z.looseObject({ threadId: Uuid }), "AG-UI RunAgentInput"),
      },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403], 409: ERR[409] },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const input = c.req.valid("json") as unknown as RunAgentInput;
      const threadId = input.threadId;
      const db = getDb();
      const asJson = input as unknown as Json;

      // A JWT user may only drive runs on their own thread (the service caller may
      // act on any). Identity comes from the verified token, not the request body.
      if (principal.kind === "user") {
        const owner = await getThreadOwner(db, threadId);
        if (owner !== principal.userId) return c.json({ error: "forbidden" }, 403);
      }

      const interrupts = await loadThreadInterrupts(db, threadId);
      const open = interrupts.filter((i) => i.status === "submitted").map((i) => i.interruptId);
      const decided = interrupts.filter((i) => i.status !== "submitted").map((i) => i.interruptId);
      const decision = classifyRun({ resume: input.resume, state: { open, decided } });

      // Contract violation: persist a bounded RunError run so it stays auditable.
      if (decision.action === "error") {
        const run = await createRun(db, { threadId, input: asJson });
        const events = runError(threadId, run.id, decision.reason);
        await appendEvents(db, threadId, run.id, events);
        await finishRun(db, run.id, { status: "error", error: decision.reason });
        return c.json(
          { threadId, runId: run.id, status: "error", error: decision.reason, events } as Record<
            string,
            unknown
          >,
          409,
        );
      }

      // Idempotent replay: the interrupts are already decided — do nothing.
      if (decision.action === "replay") {
        return c.json({ threadId, status: "noop", replay: true });
      }

      // Resume: record each decision on its proposal, then open a child run whose
      // parent is the interrupted run and let the stub continue from the payload.
      if (decision.action === "resume") {
        const byId = new Map(interrupts.map((i) => [i.interruptId, i]));
        const resolved: ResolvedInterrupt[] = [];
        let parentRunId: string | null = null;
        for (const d of decision.resolves) {
          const loc = byId.get(d.interruptId);
          if (!loc) continue; // classifyRun guarantees membership; satisfies the types
          const payload = (d.payload ?? {}) as { approved?: boolean; editedArgs?: Json };
          const approved = d.status === "resolved" && payload.approved === true;
          await decideInterruptProposal(db, loc.proposalId, {
            status: approved ? "approved" : "rejected",
            note: approved ? "approved" : "rejected",
          });
          resolved.push({
            interruptId: d.interruptId,
            toolCallId: loc.toolCallId,
            approved,
            editedArgs: payload.editedArgs,
          });
          parentRunId = loc.runId;
        }
        const run = await createRun(db, { threadId, parentRunId, input: asJson });
        const events = runStub({ threadId, runId: run.id, input, parentRunId, resolved });
        await appendEvents(db, threadId, run.id, events);
        const status = statusFromEvents(events);
        await finishRun(db, run.id, { status, outcome: outcomeFromEvents(events) ?? null });
        return c.json({ threadId, runId: run.id, status, parentRunId, events } as Record<
          string,
          unknown
        >);
      }

      // Fresh run. The conversational reply is real LLM output (brain.ts); the run
      // loop scaffolding (lifecycle, autonomy-gated tool proposal) stays deterministic.
      // The candidate's input turn is recorded to the event log too (runStub), so the
      // restored transcript holds both sides — what /onboarding/guided structures the
      // profile from (ARC-84). Conversational voice answers reach here as text
      // (transcribed client-side), so spoken answers count identically.
      const run = await createRun(db, { threadId, input: asJson });
      const reply = await getBrain()(input);
      const events = runStub({ threadId, runId: run.id, input, reply });
      await appendEvents(db, threadId, run.id, events);
      const status = statusFromEvents(events);
      // An interrupt outcome durably backs each interrupt with a proposals row.
      if (status === "interrupted") {
        for (const it of interruptsFromEvents(events)) {
          await createInterruptProposal(db, {
            threadId,
            runId: run.id,
            interruptId: it.id,
            toolCallId: it.toolCallId,
            action: it.action ?? "unknown",
            title: it.message ?? "Approval required",
            rationale: it.reason ?? null,
          });
        }
      }
      await finishRun(db, run.id, { status, outcome: outcomeFromEvents(events) ?? null });
      return c.json({ threadId, runId: run.id, status, events } as Record<string, unknown>);
    },
  )
  // History restore: fold the thread's persisted event log into a StateSnapshot +
  // MessagesSnapshot (+ the replayable log) so a reconnecting or brand-new client
  // rebuilds the conversation identically to what a live subscriber accumulated.
  // Live fan-out itself rides Supabase Realtime on the events table (RLS-scoped
  // per user) — see 20260620130000_realtime_fanout.sql.
  .openapi(
    createRoute({
      method: "get",
      path: "/agui/threads/{threadId}/history",
      security: SERVICE_SECURITY,
      request: { params: z.object({ threadId: Uuid }) },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403] },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const { threadId } = c.req.valid("param");
      const db = getDb();
      // A JWT user may only read their own thread's history (the service caller any).
      if (principal.kind === "user") {
        const owner = await getThreadOwner(db, threadId);
        if (owner !== principal.userId) return c.json({ error: "forbidden" }, 403);
      }
      const events = await loadThreadEvents(db, threadId);
      const { state, messages } = restoreThread(events);
      return c.json({ threadId, state, messages, events } as Record<string, unknown>);
    },
  );

const gOnboard = mk()
  // ── Candidate onboarding (ARC-28) ──────────────────────────────────────────
  // Empty-state gate: a user with no live (approved) profile version is in
  // onboarding mode. The thin clients key their empty-state on this.
  .openapi(
    createRoute({
      method: "get",
      path: "/onboarding/state",
      security: SERVICE_SECURITY,
      request: { query: z.object({ user: Uuid.optional() }) },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403] },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const resolved = scopedUser(principal, c.req.valid("query").user);
      if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
      const user = resolved.user;
      const live = await getLiveProfileVersion(getDb(), user);
      return c.json({ user, onboarding: !live, liveVersionId: live?.id ?? null });
    },
  )
  // The precise, resumable onboarding step (ARC-66): the full step machine
  // (intro → processing → review → titles → submitting → done) + the stage flags
  // the spec's resumability questions key on, extending the coarse
  // /onboarding/state. Also exposes the open profile-version proposal
  // (openProposalId/proposedVersionId, ARC-86) so the review screen can self-approve
  // (POST …/decide/self) and resumability can restore the review step. Pure read;
  // same own-rows auth.
  .openapi(
    createRoute({
      method: "get",
      path: "/onboarding/progress",
      security: SERVICE_SECURITY,
      request: { query: z.object({ user: Uuid.optional() }) },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403] },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const resolved = scopedUser(principal, c.req.valid("query").user);
      if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
      const user = resolved.user;
      const progress = await getOnboardingProgress(getDb(), user);
      return c.json({ user, ...progress });
    },
  )
  // Drive one onboarding run: the scripted Guide assembles a profile draft in
  // AG-UI shared state (StateSnapshot + JSON-Patch deltas), then the assembled
  // draft is submitted as a proposed profile VERSION through the apply executor.
  // The version owner is resolved from the thread, not trusted from the caller.
  .openapi(
    createRoute({
      method: "post",
      path: "/onboarding/run",
      security: SERVICE_SECURITY,
      request: {
        body: jsonBody(
          z.object({ threadId: Uuid, draft: z.record(z.string(), z.any()).optional() }),
          "Onboarding draft",
        ),
      },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403], 404: ERR[404] },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const body = c.req.valid("json");
      const threadId = body.threadId;
      const db = getDb();
      const userId = await getThreadOwner(db, threadId);
      if (!userId) return c.json({ error: "unknown thread" }, 404);
      if (!principalOwns(principal, userId)) return c.json({ error: "forbidden" }, 403);

      const run = await createRun(db, { threadId, input: body as unknown as Json });
      const events = onboardingRun({ threadId, runId: run.id, draft: body.draft });
      await appendEvents(db, threadId, run.id, events);
      const status = statusFromEvents(events);
      await finishRun(db, run.id, { status, outcome: outcomeFromEvents(events) ?? null });

      // Fold the run's shared state and submit the assembled draft as a version.
      const attributes = draftAttributes(restoreThread(events).state);
      const version = await createProfileVersion(db, {
        userId,
        label: "onboarding draft",
        attributes,
      });
      const proposal = await submitVersionProposal(db, {
        userId,
        versionId: version.id,
        title: "Approve your profile",
      });
      return c.json({
        threadId,
        runId: run.id,
        status,
        versionId: version.id,
        proposalId: proposal.id,
        attributes,
        events,
      } as Record<string, unknown>);
    },
  )
  // Finalize the conversational "start from scratch" path (ARC-79): fold the thread's
  // gathered conversation into a structured draft (attributes + spine) with the real
  // LLM, persist it as a PROPOSED profile_version incl. spine (the same spine writer
  // the résumé path uses), and emit a guided run that converges on the shared review
  // (phase:"complete" + versionId/proposalId, like /onboarding/resume). The brain's
  // multi-turn ASKING happens earlier over /agui/run; this is the structure+propose
  // step. The owner is resolved from the thread, not trusted from the caller.
  .openapi(
    createRoute({
      method: "post",
      path: "/onboarding/guided",
      security: SERVICE_SECURITY,
      request: {
        body: jsonBody(z.object({ threadId: Uuid }), "Guided onboarding finalize"),
      },
      responses: {
        200: ok(),
        400: ERR[400],
        401: ERR[401],
        403: ERR[403],
        404: ERR[404],
        500: ERR[500],
      },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const { threadId } = c.req.valid("json");
      const db = getDb();
      const userId = await getThreadOwner(db, threadId);
      if (!userId) return c.json({ error: "unknown thread" }, 404);
      if (!principalOwns(principal, userId)) return c.json({ error: "forbidden" }, 403);

      const transcript = buildTranscript(
        restoreThread(await loadThreadEvents(db, threadId)).messages,
      );
      const run = await createRun(db, { threadId, input: { threadId } as unknown as Json });
      try {
        // Structure the conversation → attributes + spine (real LLM, mocked in CI).
        const { attributes, spine } = await structureConversation(transcript);
        const version = await createProfileVersion(db, {
          userId,
          label: "onboarding draft",
          attributes,
        });
        if (hasSpine(spine)) await writeProfileSpine(db, userId, version.id, spine);
        const proposal = await submitVersionProposal(db, {
          userId,
          versionId: version.id,
          title: "Approve your profile",
        });
        const events = guidedOnboardingRun({
          threadId,
          runId: run.id,
          draft: { attributes, spine },
          versionId: version.id,
          proposalId: proposal.id,
        });
        await appendEvents(db, threadId, run.id, events);
        await finishRun(db, run.id, {
          status: statusFromEvents(events),
          outcome: outcomeFromEvents(events) ?? null,
        });
        return c.json({
          threadId,
          runId: run.id,
          status: "proposed",
          versionId: version.id,
          proposalId: proposal.id,
          attributes,
        } as Record<string, unknown>);
      } catch (err) {
        // Structuring failed (no/invalid model JSON): record an auditable run_error
        // so the client can retry, then 500 — mirroring the résumé-ingest failure path.
        const message = err instanceof Error ? err.message : "guided onboarding failed";
        const events = runError(threadId, run.id, message);
        await appendEvents(db, threadId, run.id, events);
        await finishRun(db, run.id, { status: "error", error: message });
        return c.json({ error: message }, 500);
      }
    },
  )
  // Revise the open proposed draft from the candidate's feedback (ARC-85, unblocking
  // ARC-77's review feedback/redraft loop). Loads the user's open profile-version
  // proposal + its draft (attributes + spine), re-uses the source it was built from —
  // the retained résumé text (kept on the version's details by /onboarding/resume) or,
  // for a conversation draft, the thread transcript — and asks the LLM to AMEND the
  // draft per the feedback (never blanking it). Persists the result as a NEW proposed
  // version, rejects the superseded one so exactly one proposal stays open (ARC-86),
  // and emits a streamed run that converges on the shared review (phase:"complete" +
  // versionId/proposalId, like /onboarding/resume). Owner resolved from the thread.
  .openapi(
    createRoute({
      method: "post",
      path: "/onboarding/revise",
      security: SERVICE_SECURITY,
      request: {
        body: jsonBody(
          z.object({ threadId: Uuid, feedback: z.string().min(1).max(4000) }),
          "Revise draft from feedback",
        ),
      },
      responses: {
        200: ok(),
        400: ERR[400],
        401: ERR[401],
        403: ERR[403],
        404: ERR[404],
        500: ERR[500],
      },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const { threadId, feedback } = c.req.valid("json");
      const db = getDb();
      const userId = await getThreadOwner(db, threadId);
      if (!userId) return c.json({ error: "unknown thread" }, 404);
      if (!principalOwns(principal, userId)) return c.json({ error: "forbidden" }, 403);

      // The draft to revise is the user's currently-open proposed version.
      const open = await getOpenProfileVersionProposal(db, userId);
      if (!open) return c.json({ error: "no open draft to revise" }, 404);
      const current = await getProfileVersion(db, userId, open.versionId);
      if (!current) return c.json({ error: "no open draft to revise" }, 404);
      const currentSpine = await readProfileSpine(db, userId, open.versionId);

      // Re-use the draft's source so the revision keeps facts the feedback doesn't
      // touch: the retained résumé text if this is a résumé draft, else the thread's
      // conversation transcript (the résumé thread has no candidate turns to fold).
      const details = (current.details ?? {}) as { resumeText?: unknown; resumeUrl?: unknown };
      const resumeText = typeof details.resumeText === "string" ? details.resumeText : undefined;
      // Carry the durable résumé URL forward too, so approving a revised draft keeps
      // profiles.resume_url pointing at the uploaded file rather than nulling it (ARC-131).
      const resumeUrl = typeof details.resumeUrl === "string" ? details.resumeUrl : undefined;
      const source =
        resumeText ??
        buildTranscript(restoreThread(await loadThreadEvents(db, threadId)).messages) ??
        undefined;

      const run = await createRun(db, {
        threadId,
        input: { threadId, feedback } as unknown as Json,
      });
      try {
        const revised = await reviseDraft({
          current: {
            attributes: (current.attributes ?? {}) as Record<string, Json>,
            spine: currentSpine,
          },
          feedback,
          source: source || undefined,
        });
        const version = await createProfileVersion(db, {
          userId,
          label: "revised draft",
          attributes: revised.attributes as Json,
          // Carry the résumé text + durable URL forward so a re-revision still has its
          // source and approval keeps profiles.resume_url (ARC-85, ARC-131).
          details: {
            source: "revision",
            revisedFrom: open.versionId,
            model: revised.model,
            ...(resumeText ? { resumeText } : {}),
            ...(resumeUrl ? { resumeUrl } : {}),
          },
        });
        if (hasSpine(revised.spine)) await writeProfileSpine(db, userId, version.id, revised.spine);
        const proposal = await submitVersionProposal(db, {
          userId,
          versionId: version.id,
          title: "Approve your profile",
        });
        // Supersede the prior draft so the review screen sees exactly one open
        // proposal (ARC-86). Done only after the new one lands, so a structuring
        // failure leaves the original draft intact for a retry.
        await applyVersionProposal(db, open.proposalId, {
          action: "reject",
          note: "superseded by your revision",
        });
        const events = reviseDraftRun({
          threadId,
          runId: run.id,
          versionId: version.id,
          proposalId: proposal.id,
        });
        await appendEvents(db, threadId, run.id, events);
        await finishRun(db, run.id, {
          status: statusFromEvents(events),
          outcome: outcomeFromEvents(events) ?? null,
        });
        return c.json({
          threadId,
          runId: run.id,
          status: "proposed",
          versionId: version.id,
          proposalId: proposal.id,
          attributes: revised.attributes,
        } as Record<string, unknown>);
      } catch (err) {
        // Revision failed (no/invalid model JSON): record an auditable run_error so
        // the client can retry, then 500 — mirroring the résumé-ingest failure path.
        const message = err instanceof Error ? err.message : "draft revision failed";
        const events = runError(threadId, run.id, message);
        await appendEvents(db, threadId, run.id, events);
        await finishRun(db, run.id, { status: "error", error: message });
        return c.json({ error: message }, 500);
      }
    },
  )
  // Decide a submitted profile-version proposal: approve (optionally with edits)
  // materialises it as the live profile via the apply executor; reject leaves the
  // live profile untouched. Closes the onboarding round trip to an approved version.
  .openapi(
    createRoute({
      method: "post",
      path: "/onboarding/proposals/{proposalId}/decide",
      security: OWNER_SECURITY,
      request: {
        params: z.object({ proposalId: Uuid }),
        // `action` is validated in the handler so the owner gate (401) runs first.
        body: jsonBody(z.looseObject({}), "Decision"),
      },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403] },
    }),
    async (c) => {
      if (!ownerAuthorized(c)) return c.json({ error: "unauthorized" }, 401);
      const { proposalId } = c.req.valid("param");
      const body = c.req.valid("json") as {
        action?: string;
        edits?: { attributes?: Json; label?: string | null };
        note?: string | null;
      };
      if (body.action !== "approve" && body.action !== "reject") {
        return c.json({ error: "'action' must be approve or reject" }, 400);
      }
      const decision: VersionDecision =
        body.action === "approve"
          ? { action: "approve", edits: body.edits, note: body.note }
          : { action: "reject", note: body.note };
      const result = await applyVersionProposal(getDb(), proposalId, decision);
      return c.json({ proposalId, ...result });
    },
  )
  // Self-serve sibling of the owner decide route (ARC-67): the CANDIDATE approves
  // or rejects their OWN profile-version proposal with the service secret — no
  // owner admin secret — scoped to the caller-supplied `user` (which a trusted
  // gateway maps from `auth.uid()`). Authorization keys on the proposal's own
  // plan.userId, so a caller can only decide their own proposal; anyone else's is
  // a 403. The owner-gated /onboarding/proposals/:id/decide stays for operator
  // Acceptance-Gate actions, which remain separate and intact.
  .openapi(
    createRoute({
      method: "post",
      path: "/onboarding/proposals/{proposalId}/decide/self",
      security: SERVICE_SECURITY,
      request: {
        params: z.object({ proposalId: Uuid }),
        // `action` is validated in the handler so the service gate (401) runs first.
        body: jsonBody(z.looseObject({ userId: Uuid.optional() }), "Self-decision"),
      },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403] },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const { proposalId } = c.req.valid("param");
      const body = c.req.valid("json") as {
        userId?: string;
        action?: string;
        edits?: { attributes?: Json; label?: string | null };
        note?: string | null;
      };
      const resolved = scopedUser(principal, body.userId ?? c.req.query("user"));
      if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
      const user = resolved.user;
      if (body.action !== "approve" && body.action !== "reject") {
        return c.json({ error: "'action' must be approve or reject" }, 400);
      }
      const decision: VersionDecision =
        body.action === "approve"
          ? { action: "approve", edits: body.edits, note: body.note }
          : { action: "reject", note: body.note };
      const result = await applyVersionProposalAsUser(getDb(), proposalId, user, decision);
      if ("forbidden" in result) return c.json({ error: "forbidden" }, 403);
      return c.json({ proposalId, ...result });
    },
  )
  // Suggest target job titles from the candidate's approved profile (ARC-68): read
  // the live version (attributes + spine) and ask the real LLM for ~5 ranked titles.
  // A pure read — re-callable with `feedback`/`current` to re-rank/refine. Approving
  // the chosen set is the separate write below. Needs a profile, so 409 before one.
  .openapi(
    createRoute({
      method: "post",
      path: "/onboarding/titles/suggest",
      security: SERVICE_SECURITY,
      request: {
        body: jsonBody(
          z.looseObject({
            userId: Uuid.optional(),
            feedback: z.string().optional(),
            current: z.array(z.string()).optional(),
          }),
          "Title-suggestion request",
        ),
      },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403], 409: ERR[409] },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const body = c.req.valid("json") as {
        userId?: string;
        feedback?: string;
        current?: string[];
      };
      const resolved = scopedUser(principal, body.userId ?? c.req.query("user"));
      if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
      const user = resolved.user;
      const db = getDb();
      const live = await getLiveProfileVersion(db, user);
      if (!live) return c.json({ error: "no approved profile to suggest titles from" }, 409);
      const spine = await readProfileSpine(db, user, live.id);
      const { titles, model } = await suggestTargetTitles(
        { attributes: live.attributes, spine },
        { feedback: body.feedback, current: body.current },
      );
      return c.json({ user, suggestions: titles, model });
    },
  )
  // Approve the chosen/ordered title set (ARC-68): replace target_titles with the
  // 1–5 titles the candidate accepted, in order. The end of the suggest→re-rank
  // loop; idempotent for a given list. Separate from the per-title /titles CRUD.
  .openapi(
    createRoute({
      method: "post",
      path: "/onboarding/titles/approve",
      security: SERVICE_SECURITY,
      request: {
        body: jsonBody(
          z.looseObject({ userId: Uuid.optional(), titles: z.array(z.string()).optional() }),
          "Approved title set",
        ),
      },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403] },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const body = c.req.valid("json") as { userId?: string; titles?: string[] };
      const resolved = scopedUser(principal, body.userId ?? c.req.query("user"));
      if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
      const user = resolved.user;
      const cleaned = (body.titles ?? [])
        .map((t) => (typeof t === "string" ? t.trim() : ""))
        .filter((t) => t.length > 0 && t.length <= 256);
      if (cleaned.length < 1 || cleaned.length > 5) {
        return c.json({ error: "titles must be 1–5 non-empty strings (≤256 chars)" }, 400);
      }
      const titles = await setTargetTitles(getDb(), user, cleaned);
      return c.json({ user, titles });
    },
  )
  // Complete onboarding (ARC-69): the candidate's final action. Onboarding is
  // "complete" only when the readiness check passes — an approved profile version,
  // 1–5 active target titles, and ≥1 negative criterion. When ready, submit the
  // account for the owner's Acceptance Gate (kept by design, ARC-31); otherwise
  // refuse with the unmet reasons (409), leaving the account untouched. Background
  // search still starts only on owner acceptance — completion lands at 'submitted',
  // not at live search. Same own-rows service-role auth as the other onboarding
  // routes; `progress`/`/accounts/state` then drive the "in review → searching once
  // accepted" home state.
  .openapi(
    createRoute({
      method: "post",
      path: "/onboarding/complete",
      security: SERVICE_SECURITY,
      request: {
        body: jsonBody(z.looseObject({ userId: Uuid.optional() }), "Complete onboarding"),
      },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403], 409: ERR[409] },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const body = c.req.valid("json") as { userId?: string };
      const resolved = scopedUser(principal, body.userId ?? c.req.query("user"));
      if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
      const user = resolved.user;
      const result = await completeOnboarding(getDb(), user);
      // Not complete yet (readiness unmet) is a 409 conflict, not a submit.
      if (!result.submitted) {
        return c.json(
          {
            user,
            status: result.status ?? "onboarding",
            readiness: result.readiness,
            error: `onboarding incomplete: ${result.readiness.reasons.join("; ")}`,
          },
          409,
        );
      }
      return c.json({ user, status: result.status, readiness: result.readiness });
    },
  );

const gCover = mk()
  // ── Cover-letter draft assembly (ARC-37) ───────────────────────────────────
  // Drive one Scribe run: the scripted Scribe assembles a cover-letter draft in
  // AG-UI shared state (StateSnapshot + a JSON-Patch delta), then the assembled
  // letter is persisted as a PROPOSED cover-letter version and the candidacy
  // advances awaiting_cover_letter → drafting. The version owner is resolved from
  // the thread (not trusted from the caller), and the candidacy must belong to
  // that owner and be ready for a cover letter. The proposal/interrupt approve-
  // edit-reject loop lands in a later milestone (it consumes this proposed version).
  .openapi(
    createRoute({
      method: "post",
      path: "/cover-letters/run",
      security: SERVICE_SECURITY,
      request: {
        body: jsonBody(
          z.looseObject({ threadId: Uuid, candidacyId: Uuid }),
          "Cover-letter draft request",
        ),
      },
      responses: {
        200: ok(),
        400: ERR[400],
        401: ERR[401],
        403: ERR[403],
        404: ERR[404],
        409: ERR[409],
      },
    }),
    async (c) => {
      if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
      const body = c.req.valid("json") as {
        threadId: string;
        candidacyId: string;
        highlights?: unknown;
      };
      const threadId = body.threadId;
      const candidacyId = body.candidacyId;
      const db = getDb();
      const userId = await getThreadOwner(db, threadId);
      if (!userId) return c.json({ error: "unknown thread" }, 404);
      const candidacy = await getCandidacyContext(db, candidacyId);
      if (!candidacy) return c.json({ error: "unknown candidacy" }, 404);
      if (candidacy.user_id !== userId) {
        return c.json({ error: "candidacy not owned by thread owner" }, 403);
      }
      if (candidacy.status !== "awaiting_cover_letter" && candidacy.status !== "drafting") {
        return c.json(
          { error: `candidacy is not ready for a cover letter (status: ${candidacy.status})` },
          409,
        );
      }

      // Candidate highlights woven into the letter: the caller's, else string
      // attributes from the live profile version (the candidate's own words).
      const live = await getLiveProfileVersion(db, userId);
      const attrs = (live?.attributes ?? {}) as Record<string, unknown>;
      const highlights = Array.isArray(body.highlights)
        ? body.highlights.filter((h): h is string => typeof h === "string")
        : Object.values(attrs)
            .filter((v): v is string => typeof v === "string")
            .slice(0, 3);

      const run = await createRun(db, { threadId, input: body as unknown as Json });
      // Draft the letter with the real, swappable LLM (mock in tests, deterministic
      // assembler when no key); the run loop stays pure (see ./scribe.ts, ./agui.ts).
      const context = {
        roleTitle: candidacy.posting_title,
        companyName: candidacy.company_name,
        highlights,
      };
      const letter = await getScribe()(context);
      const events = scribeRun({ threadId, runId: run.id, context, content: letter });
      await appendEvents(db, threadId, run.id, events);
      const status = statusFromEvents(events);
      await finishRun(db, run.id, { status, outcome: outcomeFromEvents(events) ?? null });

      // Fold the run's shared state and persist the assembled letter as a proposed
      // (submitted) version, then advance the candidacy into drafting.
      const content = draftContent(restoreThread(events).state);
      const version = await createCoverLetterVersion(db, {
        candidacyId,
        userId,
        label: "scribe draft",
        content,
      });
      const submitted = await submitCoverLetterVersion(db, version.id);
      await setCandidacyStatus(db, candidacyId, "drafting");
      return c.json({
        threadId,
        runId: run.id,
        status,
        candidacyId,
        versionId: version.id,
        versionStatus: submitted.status,
        content,
        events,
      } as Record<string, unknown>);
    },
  )
  // ── Cover-letter revision loop (ARC-38) ────────────────────────────────────
  // Submit the candidacy's proposed draft for review: drive a run that re-presents
  // the assembled letter and ENDS ON A tool_call INTERRUPT (approve / reject /
  // approve-with-edits), back that interrupt with a 'cover_letter_version' proposal,
  // and advance the candidacy drafting → in_review. The owner is resolved from the
  // thread (not trusted from the caller). The owner then resolves the proposal via
  // /cover-letters/proposals/:id/decide from any client.
  .openapi(
    createRoute({
      method: "post",
      path: "/cover-letters/submit",
      security: SERVICE_SECURITY,
      request: {
        body: jsonBody(z.object({ threadId: Uuid, candidacyId: Uuid }), "Cover-letter submit"),
      },
      responses: {
        200: ok(),
        400: ERR[400],
        401: ERR[401],
        403: ERR[403],
        404: ERR[404],
        409: ERR[409],
      },
    }),
    async (c) => {
      if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
      const { threadId, candidacyId } = c.req.valid("json");
      const db = getDb();
      const userId = await getThreadOwner(db, threadId);
      if (!userId) return c.json({ error: "unknown thread" }, 404);
      const candidacy = await getCandidacyContext(db, candidacyId);
      if (!candidacy) return c.json({ error: "unknown candidacy" }, 404);
      if (candidacy.user_id !== userId) {
        return c.json({ error: "candidacy not owned by thread owner" }, 403);
      }
      if (candidacy.status !== "drafting") {
        return c.json(
          { error: `candidacy is not ready to submit (status: ${candidacy.status})` },
          409,
        );
      }
      // The proposed draft the Scribe left for this candidacy (newest wins).
      const proposed = (await listCoverLetterVersions(db, candidacyId))
        .filter((v) => v.status === "proposed")
        .at(-1);
      if (!proposed) return c.json({ error: "no proposed cover-letter version to submit" }, 409);

      const run = await createRun(db, { threadId, input: { threadId, candidacyId } as Json });
      const events = coverLetterSubmitRun({
        threadId,
        runId: run.id,
        versionId: proposed.id,
        content: proposed.content,
      });
      await appendEvents(db, threadId, run.id, events);
      const status = statusFromEvents(events);
      await finishRun(db, run.id, { status, outcome: outcomeFromEvents(events) ?? null });

      // Back the interrupt with a cover_letter_version proposal + advance to in_review.
      const [interrupt] = interruptsFromEvents(events);
      const proposal = await submitCoverLetterVersionProposal(db, {
        candidacyId,
        userId,
        versionId: proposed.id,
        title: "Approve your cover letter",
        interrupt: interrupt
          ? { threadId, runId: run.id, interruptId: interrupt.id, toolCallId: interrupt.toolCallId }
          : undefined,
      });
      return c.json({
        threadId,
        runId: run.id,
        status,
        candidacyId,
        versionId: proposed.id,
        proposalId: proposal.id,
        interruptId: interrupt?.id ?? null,
        events,
      } as Record<string, unknown>);
    },
  )
  // Decide a submitted cover-letter version proposal: approve (optionally with
  // edits) makes the version the candidacy's active letter and advances it to
  // approved; reject returns it to drafting with the feedback captured. Idempotent.
  .openapi(
    createRoute({
      method: "post",
      path: "/cover-letters/proposals/{proposalId}/decide",
      security: OWNER_SECURITY,
      request: {
        params: z.object({ proposalId: Uuid }),
        // `action` is validated in the handler so the owner gate (401) runs first.
        body: jsonBody(z.looseObject({}), "Decision"),
      },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403] },
    }),
    async (c) => {
      if (!ownerAuthorized(c)) return c.json({ error: "unauthorized" }, 401);
      const { proposalId } = c.req.valid("param");
      const body = c.req.valid("json") as {
        action?: string;
        edits?: { content?: string; label?: string | null; details?: Json };
        note?: string | null;
      };
      if (body.action !== "approve" && body.action !== "reject") {
        return c.json({ error: "'action' must be approve or reject" }, 400);
      }
      const decision: CoverLetterVersionDecision =
        body.action === "approve"
          ? { action: "approve", edits: body.edits, note: body.note }
          : { action: "reject", note: body.note };
      const result = await applyCoverLetterVersionProposal(getDb(), proposalId, decision);
      return c.json({ proposalId, ...result });
    },
  )
  // Self-serve sibling of the owner decide route (ARC-161): the CANDIDATE approves
  // or rejects their OWN cover-letter version proposal with the service secret — no
  // owner admin secret — scoped to the caller-supplied `user` (which a trusted
  // gateway maps from `auth.uid()`). The cover-letter analogue of the profile
  // /onboarding/proposals/:id/decide/self route (ARC-67): authorization keys on the
  // proposal's own plan.userId, so a caller can only decide their own proposal;
  // anyone else's (or an unknown one) is a 403. The owner-gated
  // /cover-letters/proposals/:id/decide stays for operator actions, separate + intact.
  .openapi(
    createRoute({
      method: "post",
      path: "/cover-letters/proposals/{proposalId}/decide/self",
      security: SERVICE_SECURITY,
      request: {
        params: z.object({ proposalId: Uuid }),
        // `action` is validated in the handler so the service gate (401) runs first.
        body: jsonBody(z.looseObject({ userId: Uuid.optional() }), "Self-decision"),
      },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403] },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const { proposalId } = c.req.valid("param");
      const body = c.req.valid("json") as {
        userId?: string;
        action?: string;
        edits?: { content?: string; label?: string | null; details?: Json };
        note?: string | null;
      };
      const resolved = scopedUser(principal, body.userId ?? c.req.query("user"));
      if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
      const user = resolved.user;
      if (body.action !== "approve" && body.action !== "reject") {
        return c.json({ error: "'action' must be approve or reject" }, 400);
      }
      const decision: CoverLetterVersionDecision =
        body.action === "approve"
          ? { action: "approve", edits: body.edits, note: body.note }
          : { action: "reject", note: body.note };
      const result = await applyCoverLetterVersionProposalAsUser(
        getDb(),
        proposalId,
        user,
        decision,
      );
      if ("forbidden" in result) return c.json({ error: "forbidden" }, 403);
      return c.json({ proposalId, ...result });
    },
  )
  // ── Spoken-note generation (ARC-39) ────────────────────────────────────────
  // Generate Archer's spoken note for a cover-letter version: synthesise the audio
  // (stubbed ElevenLabs TTS boundary, ./tts.ts) inside a `spoken_note` activity and
  // record the artifact (audio URL + provider) on the version's `details` jsonb —
  // so the note is produced on demand, never assumed to pre-exist on the client.
  // The version owner is resolved from the thread (not trusted from the caller).
  .openapi(
    createRoute({
      method: "post",
      path: "/cover-letters/spoken-note",
      security: SERVICE_SECURITY,
      request: {
        body: jsonBody(z.object({ threadId: Uuid, versionId: Uuid }), "Spoken-note request"),
      },
      responses: {
        200: ok(),
        400: ERR[400],
        401: ERR[401],
        403: ERR[403],
        404: ERR[404],
        500: ERR[500],
      },
    }),
    async (c) => {
      if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
      const { threadId, versionId } = c.req.valid("json");
      const db = getDb();
      const userId = await getThreadOwner(db, threadId);
      if (!userId) return c.json({ error: "unknown thread" }, 404);
      const version = await getCoverLetterVersion(db, versionId);
      if (!version) return c.json({ error: "unknown cover-letter version" }, 404);
      if (version.user_id !== userId) {
        return c.json({ error: "cover-letter version not owned by thread owner" }, 403);
      }

      // Stubbed TTS boundary: the letter text → a spoken-note audio artifact ref.
      const activity = await startActivity(db, {
        type: "spoken_note",
        userId,
        candidacyId: version.candidacy_id,
        detail: { versionId },
      });
      try {
        const note = stubSynthesizer({ versionId, text: version.content });
        await recordCoverLetterSpokenNote(db, versionId, note);
        await succeedActivity(db, activity.id, {
          audioUrl: note.audioUrl,
          provider: note.provider,
        });
        return c.json({
          threadId,
          candidacyId: version.candidacy_id,
          versionId,
          activityId: activity.id,
          spokenNote: note,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "spoken-note generation failed";
        await failActivity(db, activity.id, message);
        return c.json({ error: message }, 500);
      }
    },
  );

const gIngest = mk()
  // Resume / portfolio ingest (ARC-29/63/64/65): an uploaded file is extracted into
  // a PROPOSED profile version — never the live profile — as a STREAMED AG-UI run so
  // the client renders live status. The run emits three ordered progress phases
  // ("reading your résumé" → "extracting your experience" → "building your profile")
  // on the thread's `events` (Realtime-published, replayable via history) and finishes
  // carrying the proposed `versionId`/`proposalId`. Real extraction (./ingest.ts)
  // downloads the file from the private bucket, pulls its text, and structures it into
  // attributes + spine via the LLM; ingestProposedVersion records a proposal_exec
  // activity and submits the structured content (incl. spine) through the same
  // proposals/apply-executor path onboarding uses. The owner is resolved from the
  // thread (not trusted from the caller), like /onboarding/run. The candidate approves
  // the proposal later on the review screen via /onboarding/proposals/:id/decide.
  .openapi(
    createRoute({
      method: "post",
      path: "/onboarding/resume",
      security: SERVICE_SECURITY,
      request: {
        body: jsonBody(
          z.looseObject({
            threadId: Uuid,
            storageRef: z.string(),
            filename: z.string().optional(),
            kind: z.string().optional(),
          }),
          "Ingest request",
        ),
      },
      responses: {
        200: ok(),
        400: ERR[400],
        401: ERR[401],
        403: ERR[403],
        404: ERR[404],
        500: ERR[500],
      },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const body = c.req.valid("json") as {
        threadId: string;
        storageRef?: string;
        filename?: string;
        kind?: string;
      };
      const storageRef = body.storageRef;
      if (typeof storageRef !== "string" || storageRef.length === 0 || storageRef.length > 1024) {
        return c.json({ error: "storageRef must be a non-empty string (≤1024 chars)" }, 400);
      }
      const db = getDb();
      const threadId = body.threadId;
      const user = await getThreadOwner(db, threadId);
      if (!user) return c.json({ error: "unknown thread" }, 404);
      if (!principalOwns(principal, user)) return c.json({ error: "forbidden" }, 403);
      // Inferred as the literal union "resume" | "portfolio" (not the named IngestKind
      // alias) so the response type stays portable across the hc<AppType> CLI client.
      const kind = body.kind === "portfolio" ? "portfolio" : "resume";
      const filename = typeof body.filename === "string" ? body.filename : undefined;

      const run = await createRun(db, { threadId, input: body as unknown as Json });
      // Stream the ingest phases live: append each phase's events as that phase's work
      // runs (reading → extracting → building → complete) rather than one terminal
      // batch, so subscribers see real progress. The segments concatenate to exactly
      // resumeIngestRun(...), preserving the replay invariant (ARC-123).
      const segments = resumeIngestSegments({ threadId, runId: run.id });
      // Tracks whether `run_started` has streamed, so a mid-phase failure appends a bare
      // run_error tail instead of a duplicate run_started.
      let started = false;
      try {
        // Real extraction: file → text (ARC-63) → structured draft incl. spine (ARC-64),
        // streaming reading/extracting/building as each phase's work begins.
        const extraction = await extractResume(
          { kind, storageRef, filename },
          {
            onPhase: async (phase) => {
              if (phase === "reading") started = true;
              await appendEvents(db, threadId, run.id, segments[phase]);
            },
          },
        );
        // Mint a durable, resolvable URL for the uploaded résumé and keep it on the
        // version's details, so approval materialises it into profiles.resume_url
        // (ARC-131). Best-effort: the bucket read already succeeded above, so signing
        // almost always does too — but a sign failure must not fail the ingest, so we
        // omit the URL and leave resume_url null rather than aborting onboarding.
        let resumeUrl: string | null = null;
        try {
          resumeUrl = await signResumeUrl(storageRef);
        } catch {
          resumeUrl = null;
        }
        const details = { ...(extraction.details as Record<string, Json>), resumeUrl };
        const result = await ingestProposedVersion(db, {
          userId: user,
          source: kind,
          storageRef,
          filename,
          attributes: extraction.attributes as Json,
          spine: extraction.spine,
          details: details as Json,
        });
        await appendEvents(
          db,
          threadId,
          run.id,
          segments.complete({ versionId: result.versionId, proposalId: result.proposalId }),
        );
        // The one-shot log equals the streamed accumulation — use it as the replay
        // reference for the run's terminal status + outcome.
        const events = resumeIngestRun({
          threadId,
          runId: run.id,
          versionId: result.versionId,
          proposalId: result.proposalId,
        });
        await finishRun(db, run.id, {
          status: statusFromEvents(events),
          outcome: outcomeFromEvents(events) ?? null,
        });
        return c.json({
          threadId,
          runId: run.id,
          kind,
          status: "proposed",
          ...result,
        });
      } catch (err) {
        // Ingestion failed (download/parse/LLM): record it as an auditable, replayable
        // run_error so the processing screen can surface a retry, then 500. If the run
        // already streamed its start, append only the run_error tail (no duplicate
        // run_started); otherwise emit a full run_started + run_error.
        const message = err instanceof Error ? err.message : "résumé ingestion failed";
        const events = started
          ? runErrorTail(threadId, run.id, message)
          : runError(threadId, run.id, message);
        await appendEvents(db, threadId, run.id, events);
        await finishRun(db, run.id, { status: "error", error: message });
        return c.json({ error: message }, 500);
      }
    },
  )
  // Voicenote ingest (ARC-30, edge STT per ARC-53): the transcript text is
  // persisted as a tier-2 message on the thread — the deep source the Scribe later
  // reads, never a profile mutation. Transcription happens at the edge (the
  // `transcribe` Supabase edge function → ElevenLabs); the audio is never persisted
  // and this route receives only the resulting TEXT. It records a `transcribe`
  // activity (provider/filename provenance, no audio reference), then stores the
  // transcript message. The thread owner (not the caller) resolves the activity's
  // user, mirroring the onboarding routes.
  .openapi(
    createRoute({
      method: "post",
      path: "/onboarding/voicenote",
      security: SERVICE_SECURITY,
      request: {
        body: jsonBody(
          z.looseObject({
            threadId: Uuid,
            transcript: z.string(),
            filename: z.string().optional(),
            provider: z.string().optional(),
          }),
          "Voicenote transcript",
        ),
      },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403], 404: ERR[404] },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const body = c.req.valid("json") as {
        threadId?: string;
        transcript?: string;
        filename?: string;
        provider?: string;
      };
      const threadId = body.threadId;
      if (!threadId || !UUID_RE.test(threadId)) return c.json({ error: "invalid threadId" }, 400);
      const transcript = body.transcript;
      if (
        typeof transcript !== "string" ||
        transcript.trim().length === 0 ||
        transcript.length > 100_000
      ) {
        return c.json({ error: "transcript must be a non-empty string (≤100000 chars)" }, 400);
      }
      const filename = typeof body.filename === "string" ? body.filename : undefined;
      const provider = typeof body.provider === "string" ? body.provider : "elevenlabs";
      const db = getDb();
      const userId = await getThreadOwner(db, threadId);
      if (!userId) return c.json({ error: "unknown thread" }, 404);
      if (!principalOwns(principal, userId)) return c.json({ error: "forbidden" }, 403);
      const result = await ingestVoicenote(db, {
        threadId,
        userId,
        filename,
        transcript,
        provider,
      });
      return c.json({ threadId, status: "transcribed", transcript, ...result });
    },
  );

const gAccount = mk()
  // ── Acceptance gate (ARC-31) ────────────────────────────────────────────────
  // The first human gate: an account lifecycle (onboarding → submitted →
  // under_review → accepted | rejected). Read a user's gate state + the mechanical
  // readiness check (1–5 target titles + negative criteria + an approved profile
  // version) the owner's acceptance requires.
  .openapi(
    createRoute({
      method: "get",
      path: "/accounts/state",
      security: SERVICE_SECURITY,
      request: { query: z.object({ user: Uuid.optional() }) },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403] },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const resolved = scopedUser(principal, c.req.valid("query").user);
      if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
      const user = resolved.user;
      const db = getDb();
      const account = await getAccount(db, user);
      const readiness = await checkReadiness(db, user);
      return c.json({ user, status: account?.status ?? "onboarding", readiness });
    },
  )
  // A user submits their account for review (just-in-time provisions the row).
  .openapi(
    createRoute({
      method: "post",
      path: "/accounts/submit",
      security: SERVICE_SECURITY,
      request: { body: jsonBody(z.looseObject({ userId: Uuid.optional() }), "Submit account") },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403] },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const body = c.req.valid("json") as { userId?: string };
      const resolved = scopedUser(principal, body.userId ?? c.req.query("user"));
      if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
      const user = resolved.user;
      const account = await submitAccountForReview(getDb(), user);
      return c.json({ user, status: account.status });
    },
  )
  // The owner's ≤24h review decision: start review, accept (requires readiness),
  // or reject with a note. Owner-facing (the service-role path) like the
  // profile-version decide route; RLS has no client write policy on accounts.
  .openapi(
    createRoute({
      method: "post",
      path: "/accounts/{userId}/decide",
      security: OWNER_SECURITY,
      request: {
        params: z.object({ userId: Uuid }),
        // `action` is validated in the handler so the owner gate (401) runs first.
        body: jsonBody(z.looseObject({}), "Account decision"),
      },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403], 409: ERR[409] },
    }),
    async (c) => {
      if (!ownerAuthorized(c)) return c.json({ error: "unauthorized" }, 401);
      const user = c.req.valid("param").userId;
      const body = c.req.valid("json") as { action?: string; note?: string | null };
      if (body.action !== "review" && body.action !== "accept" && body.action !== "reject") {
        return c.json({ error: "'action' must be review, accept, or reject" }, 400);
      }
      const decision =
        body.action === "review"
          ? ({ action: "review" } as AccountDecision)
          : ({ action: body.action, note: body.note } as AccountDecision);
      const result = await decideAccount(getDb(), user, decision);
      // A refused decision (not ready, or not awaiting review) is a 409 conflict.
      if (result.error) return c.json({ user, ...result }, 409);
      return c.json({ user, ...result });
    },
  );

const gProfile = mk()
  // ── Profile / version surface (ARC-32) ──────────────────────────────────────
  // Round out the thin read / draft / submit / cycle surface over the profile
  // spine the onboarding + ingest flows already write to. approve/reject/edit
  // stays on the existing apply-executor route (/onboarding/proposals/:id/decide)
  // — reused, not duplicated. Same fail-closed auth; tables are RLS own-rows-only.
  .openapi(
    createRoute({
      method: "get",
      path: "/profile",
      security: SERVICE_SECURITY,
      request: { query: z.object({ user: Uuid.optional() }) },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403] },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const resolved = scopedUser(principal, c.req.valid("query").user);
      if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
      const user = resolved.user;
      const profile = await getProfile(getDb(), user);
      return c.json({ user, profile: profile ?? null });
    },
  )
  // Capture the typed work preferences a résumé can't supply (ARC-133): the work
  // mode + remote willingness, salary expectations, and notice period. Onboarding
  // asks for these in the hunt-setup/preferences stage and posts the set here,
  // straight onto the typed `profiles` columns via `upsertProfile` — these fields
  // are deliberately left untouched by the profile-version approval executor, so
  // this is their write surface. Every field is optional (the candidate may skip
  // any), but a payload with no recognised field is rejected so the client only
  // calls when there's something to save.
  .openapi(
    createRoute({
      method: "post",
      path: "/profile/preferences",
      security: SERVICE_SECURITY,
      request: {
        body: jsonBody(
          z.looseObject({
            userId: Uuid.optional(),
            workPref: z.string().optional(),
            willingRemote: z.boolean().optional(),
            currentSalary: z.string().optional(),
            preferredSalary: z.string().optional(),
            noticePeriod: z.string().optional(),
          }),
          "Work preferences",
        ),
      },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403] },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const body = c.req.valid("json") as {
        userId?: string;
        workPref?: string;
        willingRemote?: boolean;
        currentSalary?: string;
        preferredSalary?: string;
        noticePeriod?: string;
      };
      const resolved = scopedUser(principal, body.userId ?? c.req.query("user"));
      if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
      const user = resolved.user;

      const patch: ProfilePatch = {};
      if ("workPref" in body) {
        if (!WORK_MODES.includes(body.workPref as WorkMode)) {
          return c.json({ error: `workPref must be one of ${WORK_MODES.join(", ")}` }, 400);
        }
        patch.work_pref = body.workPref as WorkMode;
      }
      if ("willingRemote" in body) {
        if (typeof body.willingRemote !== "boolean") {
          return c.json({ error: "willingRemote must be a boolean" }, 400);
        }
        patch.willing_remote = body.willingRemote;
      }
      // Salary + notice are free text (`text` columns); trim and cap, and treat a
      // blank string as an explicit clear (null) so a candidate can wipe a field.
      const textFields = [
        ["currentSalary", "current_salary"],
        ["preferredSalary", "preferred_salary"],
        ["noticePeriod", "notice_period"],
      ] as const;
      for (const [key, col] of textFields) {
        if (!(key in body)) continue;
        const raw = body[key];
        if (typeof raw !== "string") return c.json({ error: `${key} must be a string` }, 400);
        const trimmed = raw.trim();
        if (trimmed.length > 128) return c.json({ error: `${key} is too long (≤128 chars)` }, 400);
        patch[col] = trimmed.length > 0 ? trimmed : null;
      }

      if (Object.keys(patch).length === 0) {
        return c.json({ error: "at least one preference field is required" }, 400);
      }
      const profile = await upsertProfile(getDb(), user, patch);
      return c.json({ user, profile });
    },
  )
  // The whole version history (timeline) + which one is live.
  .openapi(
    createRoute({
      method: "get",
      path: "/profile/versions",
      security: SERVICE_SECURITY,
      request: { query: z.object({ user: Uuid.optional() }) },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403] },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const resolved = scopedUser(principal, c.req.valid("query").user);
      if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
      const user = resolved.user;
      const versions = await listProfileVersions(getDb(), user);
      const live = versions.find((v) => v.status === "approved");
      return c.json({ user, versions, liveVersionId: live?.id ?? null });
    },
  )
  // Draft a new version directly (the non-conversational path; onboarding/run is
  // the conversational one). Left 'draft' until explicitly submitted + approved.
  .openapi(
    createRoute({
      method: "post",
      path: "/profile/versions",
      security: SERVICE_SECURITY,
      request: {
        body: jsonBody(
          z.looseObject({
            userId: Uuid.optional(),
            attributes: z.any().optional(),
            label: z.string().nullish(),
          }),
          "New profile version",
        ),
      },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403] },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const body = c.req.valid("json") as {
        userId?: string;
        attributes?: Json;
        label?: string | null;
      };
      const resolved = scopedUser(principal, body.userId ?? c.req.query("user"));
      if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
      const user = resolved.user;
      const version = await createProfileVersion(getDb(), {
        userId: user,
        attributes: body.attributes,
        label: body.label,
      });
      return c.json({ user, versionId: version.id, status: version.status, version });
    },
  )
  // Read a single version with its structured spine (scoped to the user so it
  // can't read another's). The spine — work_experiences, education, skills,
  // certifications, courses, projects, all version-scoped — is what the mobile
  // profile-review screen renders alongside `attributes` (ARC-76); reads any
  // version (the proposed draft, not just the live one).
  .openapi(
    createRoute({
      method: "get",
      path: "/profile/versions/{id}",
      security: SERVICE_SECURITY,
      request: { params: z.object({ id: Uuid }), query: z.object({ user: Uuid.optional() }) },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403], 404: ERR[404] },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const { id } = c.req.valid("param");
      const resolved = scopedUser(principal, c.req.valid("query").user);
      if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
      const user = resolved.user;
      const version = await getProfileVersion(getDb(), user, id);
      if (!version) return c.json({ error: "unknown version" }, 404);
      const spine = await readProfileSpine(getDb(), user, id);
      return c.json({ user, version, spine });
    },
  )
  // Submit a draft version for approval (opens a profile_version proposal). The
  // caller then decides it via /onboarding/proposals/:id/decide.
  .openapi(
    createRoute({
      method: "post",
      path: "/profile/versions/{id}/submit",
      security: SERVICE_SECURITY,
      request: {
        params: z.object({ id: Uuid }),
        body: jsonBody(
          z.looseObject({ userId: Uuid.optional(), title: z.string().optional() }),
          "Submit version",
        ),
      },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403] },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json") as { userId?: string; title?: string };
      const resolved = scopedUser(principal, body.userId ?? c.req.query("user"));
      if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
      const user = resolved.user;
      const proposal = await submitVersionProposal(getDb(), {
        userId: user,
        versionId: id,
        title: body.title ?? "Approve your profile",
      });
      return c.json({ user, versionId: id, proposalId: proposal.id });
    },
  )
  // Cycle/rollback: re-make an earlier ('approved'|'superseded') version live.
  .openapi(
    createRoute({
      method: "post",
      path: "/profile/versions/{id}/rollback",
      security: SERVICE_SECURITY,
      request: {
        params: z.object({ id: Uuid }),
        body: jsonBody(z.looseObject({ userId: Uuid.optional() }), "Rollback"),
      },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403], 409: ERR[409] },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json") as { userId?: string };
      const resolved = scopedUser(principal, body.userId ?? c.req.query("user"));
      if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
      const user = resolved.user;
      const result = await rollbackToVersion(getDb(), user, id);
      if (result.error) return c.json({ user, ...result }, 409);
      return c.json({ user, ...result });
    },
  );

const gPrefs = mk()
  // ── Target titles (the collect search keys) ─────────────────────────────────
  .openapi(
    createRoute({
      method: "get",
      path: "/titles",
      security: SERVICE_SECURITY,
      request: { query: z.object({ user: Uuid.optional(), all: z.string().optional() }) },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403] },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const q = c.req.valid("query");
      const resolved = scopedUser(principal, q.user);
      if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
      const user = resolved.user;
      const titles = await listTargetTitles(getDb(), user, { activeOnly: q.all !== "1" });
      return c.json({ user, titles });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/titles",
      security: SERVICE_SECURITY,
      request: {
        body: jsonBody(
          z.looseObject({ userId: Uuid.optional(), title: z.string().optional() }),
          "New target title",
        ),
      },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403] },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const body = c.req.valid("json") as { userId?: string; title?: string };
      const resolved = scopedUser(principal, body.userId ?? c.req.query("user"));
      if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
      const user = resolved.user;
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!title || title.length > 256) {
        return c.json({ error: "title must be a non-empty string (≤256 chars)" }, 400);
      }
      const created = await addTargetTitle(getDb(), user, title);
      return c.json({ user, title: created });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/titles/{id}",
      security: SERVICE_SECURITY,
      request: { params: z.object({ id: Uuid }) },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403] },
    }),
    async (c) => {
      if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
      const { id } = c.req.valid("param");
      await removeTargetTitle(getDb(), id);
      return c.json({ removed: id });
    },
  )
  // ── Negative criteria (the deal-breakers) ───────────────────────────────────
  .openapi(
    createRoute({
      method: "get",
      path: "/criteria",
      security: SERVICE_SECURITY,
      request: { query: z.object({ user: Uuid.optional() }) },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403] },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const resolved = scopedUser(principal, c.req.valid("query").user);
      if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
      const user = resolved.user;
      const criteria = await listNegativeCriteria(getDb(), user);
      return c.json({ user, criteria });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/criteria",
      security: SERVICE_SECURITY,
      request: {
        body: jsonBody(
          z.looseObject({ userId: Uuid.optional(), text: z.string().optional() }),
          "New negative criterion",
        ),
      },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403] },
    }),
    async (c) => {
      const principal = await authenticate(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      const body = c.req.valid("json") as { userId?: string; text?: string };
      const resolved = scopedUser(principal, body.userId ?? c.req.query("user"));
      if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
      const user = resolved.user;
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text || text.length > 512) {
        return c.json({ error: "text must be a non-empty string (≤512 chars)" }, 400);
      }
      const created = await addNegativeCriterion(getDb(), user, text);
      return c.json({ user, criterion: created });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/criteria/{id}",
      security: SERVICE_SECURITY,
      request: { params: z.object({ id: Uuid }) },
      responses: { 200: ok(), 400: ERR[400], 401: ERR[401], 403: ERR[403] },
    }),
    async (c) => {
      if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
      const { id } = c.req.valid("param");
      await removeNegativeCriterion(getDb(), id);
      return c.json({ removed: id });
    },
  );

const gHooks = mk()
  // Webhook: a candidacy entered external_pending (the redirect case) — wake the
  // external-fill agent by invoking the CLI (the Archer MCP reads + the stubbed
  // browser fill stay in the CLI process). Same "API runs the CLI" model as
  // collect/match/enrich/apply. The trigger posts the candidacy id as record.id
  // (20260620180000_event_engine.sql). Defensive: a missing/invalid id is just
  // acknowledged (no-op), and a CLI failure still returns 202 — this is a fire-on-
  // state-change webhook, not a request the caller can retry, so it never 5xxs.
  .openapi(
    createRoute({
      method: "post",
      path: "/hooks/external-form",
      security: SERVICE_SECURITY,
      responses: { 202: ok("Accepted"), 401: ERR[401] },
    }),
    async (c) => {
      if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
      const body = (await c.req.json().catch(() => ({}))) as { record?: { id?: string } };
      const candidacyId = body.record?.id;
      if (!candidacyId || !UUID_RE.test(candidacyId)) {
        return c.json({ received: true, ref: candidacyId ?? null }, 202);
      }
      const res = await runCli(["external-fill", candidacyId, "--json"]);
      if (res.code !== 0) {
        return c.json(
          { received: true, ref: candidacyId, error: res.stderr.trim() || "external-fill failed" },
          202,
        );
      }
      return c.json({ received: true, ref: candidacyId, result: JSON.parse(res.stdout) }, 202);
    },
  )
  // Webhook: an Activity failed -> the self-heal Mechanic should investigate.
  .openapi(
    createRoute({
      method: "post",
      path: "/hooks/activity-failed",
      security: SERVICE_SECURITY,
      responses: { 202: ok("Accepted"), 401: ERR[401] },
    }),
    async (c) => {
      if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
      await c.req.json().catch(() => ({}));
      // TODO(M4): wake the Mechanic. For now, acknowledge.
      return c.json({ received: true }, 202);
    },
  );

// Mount every route group onto the root app. `.route()` merges each group's
// route schema into the parent type — so the single exported `AppType` carries
// all routes for the `hc` client — and merges their OpenAPI definitions into the
// root registry, so `/openapi.json` documents the whole surface.
const root = mk();

// Browser CORS for the web client (`apps/web`). Server-to-server callers (the
// mobile app's native fetch, the CLI) send no `Origin` header and so are never
// gated by this. Allowed origins default to `http://localhost:3000` so a local
// browser works the moment this deploys; additional origins (e.g. the deployed
// web app) come from a comma-separated `ARCHER_WEB_ORIGINS` env var, set in
// deploy config without a code change. We reflect the matching origin and never
// blanket `*`. Registered before the `.route()` mounts so it covers every route
// and answers the `OPTIONS` preflight.
const allowedWebOrigins = () => [
  "http://localhost:3000",
  ...(process.env.ARCHER_WEB_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
];
root.use(
  "*",
  cors({
    origin: (origin) => (allowedWebOrigins().includes(origin) ? origin : null),
    allowHeaders: [
      "Authorization",
      "Content-Type",
      "apikey",
      "x-archer-secret",
      "x-archer-admin-secret",
    ],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 86400,
  }),
);

root.openAPIRegistry.registerComponent("securitySchemes", "serviceSecret", {
  type: "apiKey",
  in: "header",
  name: "x-archer-secret",
});
root.openAPIRegistry.registerComponent("securitySchemes", "ownerSecret", {
  type: "apiKey",
  in: "header",
  name: "x-archer-admin-secret",
});

const routes = root
  .route("/", gCore)
  .route("/", gFeed)
  .route("/", gOnboard)
  .route("/", gCover)
  .route("/", gIngest)
  .route("/", gAccount)
  .route("/", gProfile)
  .route("/", gPrefs)
  .route("/", gHooks);

// The published OpenAPI document + a self-hosted, browsable Scalar reference.
routes.doc("/openapi.json", {
  openapi: "3.0.0",
  info: { title: "Archer API", version: "0.1.0" },
});
routes.get("/reference", Scalar({ url: "/openapi.json" }));

export type AppType = typeof routes;
export default routes;
