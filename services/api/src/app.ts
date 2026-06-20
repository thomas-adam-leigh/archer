import { timingSafeEqual } from "node:crypto";
import {
  appendEvents,
  Constants,
  createInterruptProposal,
  createRun,
  decideInterruptProposal,
  finishRun,
  type Json,
  loadThreadEvents,
  loadThreadInterrupts,
  setCandidacyStatus,
} from "@archer/db";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  classifyRun,
  interruptsFromEvents,
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
    const args = ["collect", board, "--json"];
    if (user) args.push("--user", user);
    const res = await runCli(args);
    if (res.code !== 0) {
      return c.json({ error: res.stderr.trim() || "collect failed", code: res.code }, 502);
    }
    return c.json(JSON.parse(res.stdout));
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
