import { timingSafeEqual } from "node:crypto";
import {
  type AccountDecision,
  addNegativeCriterion,
  addTargetTitle,
  appendEvents,
  applyVersionProposal,
  Constants,
  checkReadiness,
  createInterruptProposal,
  createProfileVersion,
  createRun,
  decideAccount,
  decideInterruptProposal,
  finishRun,
  getAccount,
  getLiveProfileVersion,
  getProfile,
  getProfileVersion,
  getThreadOwner,
  ingestProposedVersion,
  ingestVoicenote,
  isAccepted,
  type Json,
  listCandidacies,
  listNegativeCriteria,
  listProfileVersions,
  listTargetTitles,
  loadThreadEvents,
  loadThreadInterrupts,
  removeNegativeCriterion,
  removeTargetTitle,
  rollbackToVersion,
  setCandidacyStatus,
  submitAccountForReview,
  submitVersionProposal,
  type VersionDecision,
} from "@archer/db";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  classifyRun,
  draftAttributes,
  interruptsFromEvents,
  onboardingRun,
  outcomeFromEvents,
  type ResolvedInterrupt,
  type RunAgentInput,
  restoreThread,
  runError,
  runStub,
  statusFromEvents,
} from "./agui.js";
import { runCli } from "./cli.js";
import { getDb } from "./db.js";
import { stubResumeExtractor } from "./ingest.js";
import { stubTranscriber } from "./stt.js";

const CANDIDACY_STATUSES = Constants.public.Enums.candidacy_status as readonly string[];
// Validate path/query values before they reach the CLI argv or the DB.
const BOARD_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Fail closed: require the shared secret (constant-time compare). With no secret
// set, deny unless an explicit dev opt-in (ARCHER_API_DEV_OPEN=1, non-prod) is on.
function authorized(c: Context): boolean {
  const secret = process.env.ARCHER_API_SECRET;
  if (secret) return safeEqual(c.req.header("x-archer-secret") ?? "", secret);
  return process.env.NODE_ENV !== "production" && process.env.ARCHER_API_DEV_OPEN === "1";
}

const app = new Hono()
  .get("/", (c) => c.json({ name: "archer-api", status: "ok" }))
  .get("/health", (c) => c.json({ status: "ok" }))
  // Trigger a collect run by invoking the CLI (browser work stays in the CLI).
  .post("/commands/collect/:board", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
    const board = c.req.param("board");
    if (!BOARD_RE.test(board)) return c.json({ error: "invalid board" }, 400);
    const user = c.req.query("user") ?? process.env.ARCHER_USER_ID;
    if (user && !UUID_RE.test(user)) return c.json({ error: "invalid user" }, 400);
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
  })
  // Trigger a Matchmaker pass by invoking the CLI. This is the per-minute matcher
  // cron's target (20260620180000_event_engine.sql): the cron only POSTs here when
  // `new` candidacies exist, and `match` is itself a no-op when there are none.
  .post("/commands/match", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
    const user = c.req.query("user") ?? process.env.ARCHER_USER_ID;
    if (user && !UUID_RE.test(user)) return c.json({ error: "invalid user" }, 400);
    // Acceptance gate (ARC-31): collect/match run only for an accepted account.
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
  })
  // Jobs feed (ARC-11): a user's candidacies joined to their posting/company —
  // title, board, company, status, triage decision, match score — optionally
  // filtered by status. RLS own-rows-only (scoped on user_id); the thin clients
  // poll this for the kanban and write via the transition command below. Live
  // fan-out itself rides the Substrate's Realtime transport on the events table.
  .get("/jobs", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
    const user = c.req.query("user") ?? process.env.ARCHER_USER_ID;
    if (!user || !UUID_RE.test(user)) return c.json({ error: "invalid user" }, 400);
    const status = c.req.query("status");
    if (status && !CANDIDACY_STATUSES.includes(status)) {
      return c.json({ error: `'status' must be one of ${CANDIDACY_STATUSES.join(", ")}` }, 400);
    }
    const jobs = await listCandidacies(getDb(), user, { status: status as never });
    return c.json({ user, jobs });
  })
  // DB-only command: move a candidacy through the kanban (in-process, no CLI).
  .post("/commands/candidacies/:id/transition", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid candidacy id" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const to = typeof body.to === "string" ? body.to : undefined;
    if (!to || !CANDIDACY_STATUSES.includes(to)) {
      return c.json({ error: `'to' must be one of ${CANDIDACY_STATUSES.join(", ")}` }, 400);
    }
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    const updated = await setCandidacyStatus(getDb(), id, to as never, { reason });
    if (!updated) return c.json({ error: "unknown candidacy" }, 404);
    return c.json({ id: updated.id, status: updated.status });
  })
  // AG-UI run lifecycle: open a run, drive the stubbed agent, persist its ordered
  // event log, then close the run with its terminal status/outcome. The agent is a
  // deterministic stub (see ./agui.ts) — the run loop is real, the brain is stubbed.
  //
  // The interrupt/resume contract is enforced here from the thread's open vs
  // decided interrupts (classifyRun): a fresh request while interrupts are open is
  // a RunError; a resume opens a CHILD run (parent_run_id set), records the human's
  // decision on the proposal substrate, and continues; a replayed resume is a no-op.
  .post("/agui/run", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
    const input = (await c.req.json().catch(() => ({}))) as RunAgentInput;
    const threadId = input.threadId;
    if (!threadId || !UUID_RE.test(threadId)) return c.json({ error: "invalid threadId" }, 400);
    const db = getDb();
    const asJson = input as unknown as Json;

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
        { threadId, runId: run.id, status: "error", error: decision.reason, events },
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
      return c.json({ threadId, runId: run.id, status, parentRunId, events });
    }

    // Fresh run.
    const run = await createRun(db, { threadId, input: asJson });
    const events = runStub({ threadId, runId: run.id, input });
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
    return c.json({ threadId, runId: run.id, status, events });
  })
  // History restore: fold the thread's persisted event log into a StateSnapshot +
  // MessagesSnapshot (+ the replayable log) so a reconnecting or brand-new client
  // rebuilds the conversation identically to what a live subscriber accumulated.
  // Live fan-out itself rides Supabase Realtime on the events table (RLS-scoped
  // per user) — see 20260620130000_realtime_fanout.sql.
  .get("/agui/threads/:threadId/history", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
    const threadId = c.req.param("threadId");
    if (!UUID_RE.test(threadId)) return c.json({ error: "invalid threadId" }, 400);
    const events = await loadThreadEvents(getDb(), threadId);
    const { state, messages } = restoreThread(events);
    return c.json({ threadId, state, messages, events });
  })
  // ── Candidate onboarding (ARC-28) ──────────────────────────────────────────
  // Empty-state gate: a user with no live (approved) profile version is in
  // onboarding mode. The thin clients key their empty-state on this.
  .get("/onboarding/state", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
    const user = c.req.query("user") ?? process.env.ARCHER_USER_ID;
    if (!user || !UUID_RE.test(user)) return c.json({ error: "invalid user" }, 400);
    const live = await getLiveProfileVersion(getDb(), user);
    return c.json({ user, onboarding: !live, liveVersionId: live?.id ?? null });
  })
  // Drive one onboarding run: the scripted Guide assembles a profile draft in
  // AG-UI shared state (StateSnapshot + JSON-Patch deltas), then the assembled
  // draft is submitted as a proposed profile VERSION through the apply executor.
  // The version owner is resolved from the thread, not trusted from the caller.
  .post("/onboarding/run", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as {
      threadId?: string;
      draft?: Record<string, Json>;
    };
    const threadId = body.threadId;
    if (!threadId || !UUID_RE.test(threadId)) return c.json({ error: "invalid threadId" }, 400);
    const db = getDb();
    const userId = await getThreadOwner(db, threadId);
    if (!userId) return c.json({ error: "unknown thread" }, 404);

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
    });
  })
  // Decide a submitted profile-version proposal: approve (optionally with edits)
  // materialises it as the live profile via the apply executor; reject leaves the
  // live profile untouched. Closes the onboarding round trip to an approved version.
  .post("/onboarding/proposals/:proposalId/decide", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
    const proposalId = c.req.param("proposalId");
    if (!UUID_RE.test(proposalId)) return c.json({ error: "invalid proposal id" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as {
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
  })
  // Resume / portfolio ingest (ARC-29): an uploaded file is extracted into a
  // PROPOSED profile version — never the live profile. The file→content extraction
  // is the stubbed CLI boundary (./ingest.ts); this records a proposal_exec activity
  // with the raw-file storage reference, then submits the extracted content through
  // the same proposals/apply-executor path onboarding uses. The caller then approves
  // it via /onboarding/proposals/:id/decide, exactly like a shared-state draft.
  .post("/onboarding/resume", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as {
      userId?: string;
      storageRef?: string;
      filename?: string;
      kind?: string;
    };
    const user = body.userId ?? c.req.query("user") ?? process.env.ARCHER_USER_ID;
    if (!user || !UUID_RE.test(user)) return c.json({ error: "invalid user" }, 400);
    const storageRef = body.storageRef;
    if (typeof storageRef !== "string" || storageRef.length === 0 || storageRef.length > 1024) {
      return c.json({ error: "storageRef must be a non-empty string (≤1024 chars)" }, 400);
    }
    // Inferred as the literal union "resume" | "portfolio" (not the named IngestKind
    // alias) so the response type stays portable across the hc<AppType> CLI client.
    const kind = body.kind === "portfolio" ? "portfolio" : "resume";
    const filename = typeof body.filename === "string" ? body.filename : undefined;
    // Stubbed CLI boundary: file → structured profile content (deterministic stub).
    const extraction = stubResumeExtractor({ kind, storageRef, filename });
    const result = await ingestProposedVersion(getDb(), {
      userId: user,
      source: kind,
      storageRef,
      filename,
      attributes: extraction.attributes as Json,
      details: extraction.details as Json,
    });
    return c.json({ user, kind, status: "proposed", ...result });
  })
  // Voicenote ingest (ARC-30): an uploaded audio reference is transcribed and the
  // transcript is persisted as a tier-2 message on the thread — the deep source the
  // Scribe later reads, never a profile mutation. The audio→text step is the stubbed
  // STT boundary (./stt.ts); this records a `transcribe` activity with the raw-audio
  // storage reference, then stores the transcript message. The thread owner (not the
  // caller) resolves the activity's user, mirroring the onboarding routes.
  .post("/onboarding/voicenote", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as {
      threadId?: string;
      storageRef?: string;
      filename?: string;
    };
    const threadId = body.threadId;
    if (!threadId || !UUID_RE.test(threadId)) return c.json({ error: "invalid threadId" }, 400);
    const storageRef = body.storageRef;
    if (typeof storageRef !== "string" || storageRef.length === 0 || storageRef.length > 1024) {
      return c.json({ error: "storageRef must be a non-empty string (≤1024 chars)" }, 400);
    }
    const filename = typeof body.filename === "string" ? body.filename : undefined;
    const db = getDb();
    const userId = await getThreadOwner(db, threadId);
    if (!userId) return c.json({ error: "unknown thread" }, 404);
    // Stubbed STT boundary: audio reference → transcript text (deterministic stub).
    const { transcript, provider } = stubTranscriber({ storageRef, filename });
    const result = await ingestVoicenote(db, {
      threadId,
      userId,
      storageRef,
      filename,
      transcript,
      provider,
    });
    return c.json({ threadId, status: "transcribed", transcript, ...result });
  })
  // ── Acceptance gate (ARC-31) ────────────────────────────────────────────────
  // The first human gate: an account lifecycle (onboarding → submitted →
  // under_review → accepted | rejected). Read a user's gate state + the mechanical
  // readiness check (1–5 target titles + negative criteria + an approved profile
  // version) the owner's acceptance requires.
  .get("/accounts/state", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
    const user = c.req.query("user") ?? process.env.ARCHER_USER_ID;
    if (!user || !UUID_RE.test(user)) return c.json({ error: "invalid user" }, 400);
    const db = getDb();
    const account = await getAccount(db, user);
    const readiness = await checkReadiness(db, user);
    return c.json({ user, status: account?.status ?? "onboarding", readiness });
  })
  // A user submits their account for review (just-in-time provisions the row).
  .post("/accounts/submit", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { userId?: string };
    const user = body.userId ?? c.req.query("user") ?? process.env.ARCHER_USER_ID;
    if (!user || !UUID_RE.test(user)) return c.json({ error: "invalid user" }, 400);
    const account = await submitAccountForReview(getDb(), user);
    return c.json({ user, status: account.status });
  })
  // The owner's ≤24h review decision: start review, accept (requires readiness),
  // or reject with a note. Owner-facing (the service-role path) like the
  // profile-version decide route; RLS has no client write policy on accounts.
  .post("/accounts/:userId/decide", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
    const user = c.req.param("userId");
    if (!UUID_RE.test(user)) return c.json({ error: "invalid user" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as {
      action?: string;
      note?: string | null;
    };
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
  })
  // ── Profile / version surface (ARC-32) ──────────────────────────────────────
  // Round out the thin read / draft / submit / cycle surface over the profile
  // spine the onboarding + ingest flows already write to. approve/reject/edit
  // stays on the existing apply-executor route (/onboarding/proposals/:id/decide)
  // — reused, not duplicated. Same fail-closed auth; tables are RLS own-rows-only.
  .get("/profile", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
    const user = c.req.query("user") ?? process.env.ARCHER_USER_ID;
    if (!user || !UUID_RE.test(user)) return c.json({ error: "invalid user" }, 400);
    const profile = await getProfile(getDb(), user);
    return c.json({ user, profile: profile ?? null });
  })
  // The whole version history (timeline) + which one is live.
  .get("/profile/versions", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
    const user = c.req.query("user") ?? process.env.ARCHER_USER_ID;
    if (!user || !UUID_RE.test(user)) return c.json({ error: "invalid user" }, 400);
    const versions = await listProfileVersions(getDb(), user);
    const live = versions.find((v) => v.status === "approved");
    return c.json({ user, versions, liveVersionId: live?.id ?? null });
  })
  // Draft a new version directly (the non-conversational path; onboarding/run is
  // the conversational one). Left 'draft' until explicitly submitted + approved.
  .post("/profile/versions", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as {
      userId?: string;
      attributes?: Json;
      label?: string | null;
    };
    const user = body.userId ?? c.req.query("user") ?? process.env.ARCHER_USER_ID;
    if (!user || !UUID_RE.test(user)) return c.json({ error: "invalid user" }, 400);
    const version = await createProfileVersion(getDb(), {
      userId: user,
      attributes: body.attributes,
      label: body.label,
    });
    return c.json({ user, versionId: version.id, status: version.status, version });
  })
  // Read a single version (scoped to the user so it can't read another's).
  .get("/profile/versions/:id", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid version id" }, 400);
    const user = c.req.query("user") ?? process.env.ARCHER_USER_ID;
    if (!user || !UUID_RE.test(user)) return c.json({ error: "invalid user" }, 400);
    const version = await getProfileVersion(getDb(), user, id);
    if (!version) return c.json({ error: "unknown version" }, 404);
    return c.json({ user, version });
  })
  // Submit a draft version for approval (opens a profile_version proposal). The
  // caller then decides it via /onboarding/proposals/:id/decide.
  .post("/profile/versions/:id/submit", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid version id" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { userId?: string; title?: string };
    const user = body.userId ?? c.req.query("user") ?? process.env.ARCHER_USER_ID;
    if (!user || !UUID_RE.test(user)) return c.json({ error: "invalid user" }, 400);
    const proposal = await submitVersionProposal(getDb(), {
      userId: user,
      versionId: id,
      title: body.title ?? "Approve your profile",
    });
    return c.json({ user, versionId: id, proposalId: proposal.id });
  })
  // Cycle/rollback: re-make an earlier ('approved'|'superseded') version live.
  .post("/profile/versions/:id/rollback", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid version id" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { userId?: string };
    const user = body.userId ?? c.req.query("user") ?? process.env.ARCHER_USER_ID;
    if (!user || !UUID_RE.test(user)) return c.json({ error: "invalid user" }, 400);
    const result = await rollbackToVersion(getDb(), user, id);
    if (result.error) return c.json({ user, ...result }, 409);
    return c.json({ user, ...result });
  })
  // ── Target titles (the collect search keys) ─────────────────────────────────
  .get("/titles", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
    const user = c.req.query("user") ?? process.env.ARCHER_USER_ID;
    if (!user || !UUID_RE.test(user)) return c.json({ error: "invalid user" }, 400);
    const titles = await listTargetTitles(getDb(), user, {
      activeOnly: c.req.query("all") !== "1",
    });
    return c.json({ user, titles });
  })
  .post("/titles", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { userId?: string; title?: string };
    const user = body.userId ?? c.req.query("user") ?? process.env.ARCHER_USER_ID;
    if (!user || !UUID_RE.test(user)) return c.json({ error: "invalid user" }, 400);
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title || title.length > 256) {
      return c.json({ error: "title must be a non-empty string (≤256 chars)" }, 400);
    }
    const created = await addTargetTitle(getDb(), user, title);
    return c.json({ user, title: created });
  })
  .delete("/titles/:id", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid title id" }, 400);
    await removeTargetTitle(getDb(), id);
    return c.json({ removed: id });
  })
  // ── Negative criteria (the deal-breakers) ───────────────────────────────────
  .get("/criteria", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
    const user = c.req.query("user") ?? process.env.ARCHER_USER_ID;
    if (!user || !UUID_RE.test(user)) return c.json({ error: "invalid user" }, 400);
    const criteria = await listNegativeCriteria(getDb(), user);
    return c.json({ user, criteria });
  })
  .post("/criteria", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { userId?: string; text?: string };
    const user = body.userId ?? c.req.query("user") ?? process.env.ARCHER_USER_ID;
    if (!user || !UUID_RE.test(user)) return c.json({ error: "invalid user" }, 400);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text || text.length > 512) {
      return c.json({ error: "text must be a non-empty string (≤512 chars)" }, 400);
    }
    const created = await addNegativeCriterion(getDb(), user, text);
    return c.json({ user, criterion: created });
  })
  .delete("/criteria/:id", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "invalid criterion id" }, 400);
    await removeNegativeCriterion(getDb(), id);
    return c.json({ removed: id });
  })
  // Webhook: a redirected (external) application form was inserted.
  .post("/hooks/external-form", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { record?: { id?: string } };
    // TODO(M3): wake the external-form-filling agent. For now, acknowledge.
    return c.json({ received: true, ref: body.record?.id ?? null }, 202);
  })
  // Webhook: an Activity failed -> the self-heal Mechanic should investigate.
  .post("/hooks/activity-failed", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
    await c.req.json().catch(() => ({}));
    // TODO(M4): wake the Mechanic. For now, acknowledge.
    return c.json({ received: true }, 202);
  });

export type AppType = typeof app;
export default app;
