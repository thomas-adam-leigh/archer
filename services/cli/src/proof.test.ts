import app from "@archer/api";
import { createDb, type Db } from "@archer/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiClient } from "./api.js";

// End-to-end proof of the AG-UI interaction substrate, exercised over the SAME
// typed hc<AppType> client the CLI consumes (createApiClient) — here mounted on
// the Hono app in-process via `fetch`, so no network is involved. It walks the
// capstone flow: open thread → run the stub → hit an interrupt → approve-with-
// edits resume → read the completed thread back via history restore, and asserts
// the restored log matches what a live subscriber accumulated across both runs.
//
// Like the other DB-backed tests it targets a migrated Postgres (the shape
// packages/db/scripts/gen-types.sh builds). Point TEST_DATABASE_URL at it to run:
//   pnpm --filter @archer/cli test (with TEST_DATABASE_URL set)
// Skipped otherwise, so the default no-DB CI vitest run stays green. The typed
// client is still typechecked against AppType in CI, which is what proves there
// is no contract drift even when this runtime path is skipped.
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// A synthetic signup. UUID is fixed + namespaced (…023) so reruns are idempotent.
const userId = "cccccccc-0000-4000-8000-000000000023";

/** A persisted/streamed AG-UI event as the proof reads it back off the wire. */
type Ev = { type: string; data: Record<string, unknown> | null };
const typesOf = (events: Ev[]) => events.map((e) => e.type);

describe.skipIf(!TEST_DB_URL)("ARC-23 — substrate proof over the typed hc client", () => {
  let sql: Db;
  let threadId: string;

  const cleanup = async (db: Db) => {
    // public.users → threads → runs → events cascade; proposals bind by jsonb only.
    await db`delete from public.proposals where plan->>'threadId' = ${threadId ?? ""}`;
    await db`delete from public.users where id = ${userId}`;
    await db`delete from auth.users where id = ${userId}`;
  };

  beforeAll(async () => {
    // Point the app's getDb() at the same test DB, and open the substrate routes.
    process.env.DATABASE_URL = TEST_DB_URL;
    process.env.ARCHER_API_DEV_OPEN = "1";
    delete process.env.ARCHER_API_SECRET;

    sql = createDb({ DATABASE_URL: TEST_DB_URL });
    // A first-time cleanup needs a threadId; resolve lazily (empty match is a no-op).
    threadId = "";
    await cleanup(sql);

    // Signup fires on_auth_user_created → public.users + exactly one first thread.
    await sql`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${userId}, 'capstone@example.com', ${sql.json({ full_name: "Cas" })})`;
    const rows = await sql<{ id: string }[]>`
      select id from public.threads where user_id = ${userId} order by created_at limit 1`;
    threadId = rows[0].id;
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanup(sql);
    await sql.end();
  });

  it("opens a thread, interrupts, resumes with edits, and restores identically", async () => {
    // The typed client the CLI consumes, mounted on the app in-process.
    const client = createApiClient({
      baseUrl: "http://proof.test",
      fetch: (input, init) => app.request(input, init),
    });

    // ── 1. Fresh run: the stub proposes a tool call that needs approval, so the
    //       run finishes with an interrupt carrying an approve-with-edits schema.
    const runRes = await client.agui.run.$post({
      json: { threadId, forwardedProps: { outcome: "interrupt" } },
    });
    expect(runRes.status).toBe(200);
    const runBody = await runRes.json();
    if (!("events" in runBody) || !("runId" in runBody)) throw new Error("expected a run");
    expect(runBody.status).toBe("interrupted");
    const runOneEvents = runBody.events as Ev[];

    // RunStarted bounds the run; an interrupt run snapshots state + messages first.
    expect(typesOf(runOneEvents)[0]).toBe("run_started");
    expect(typesOf(runOneEvents)).toContain("state_snapshot");
    expect(typesOf(runOneEvents)).toContain("messages_snapshot");
    expect(typesOf(runOneEvents).at(-1)).toBe("run_finished");

    // The terminal interrupt carries the responseSchema (approve + editedArgs).
    const finished = runOneEvents.at(-1) as Ev;
    const outcome = finished.data?.outcome as {
      type: string;
      interrupts: Array<{ id: string; responseSchema: { properties: Record<string, unknown> } }>;
    };
    expect(outcome.type).toBe("interrupt");
    const interrupt = outcome.interrupts[0];
    expect(interrupt.responseSchema.properties).toHaveProperty("approved");
    expect(interrupt.responseSchema.properties).toHaveProperty("editedArgs");

    // It is durably backed by a 'submitted' proposal on the thread.
    const open = await sql<{ status: string }[]>`
      select status from public.proposals where plan->>'threadId' = ${threadId}`;
    expect(open).toHaveLength(1);
    expect(open[0].status).toBe("submitted");

    // ── 2. Resume: approve, but replace the tool args (approve-with-edits). This
    //       opens a CHILD run (parentRunId set) that consumes the decision.
    const editedArgs = { to: "candidate@example.com", subject: "Welcome aboard" };
    const resumeRes = await client.agui.run.$post({
      json: {
        threadId,
        resume: [
          {
            interruptId: interrupt.id,
            status: "resolved",
            payload: { approved: true, editedArgs },
          },
        ],
      },
    });
    expect(resumeRes.status).toBe(200);
    const resumeBody = await resumeRes.json();
    if (!("events" in resumeBody) || !("parentRunId" in resumeBody)) {
      throw new Error("expected a resume run");
    }
    expect(resumeBody.status).toBe("completed");
    expect(resumeBody.parentRunId).toBe(runBody.runId);
    const runTwoEvents = resumeBody.events as Ev[];

    // The continuation executes the approved tool call with the EDITED args.
    const toolResult = runTwoEvents.find((e) => e.type === "tool_call_result");
    expect(toolResult).toBeDefined();
    const result = toolResult?.data?.result as { status: string; args: typeof editedArgs };
    expect(result.status).toBe("executed");
    expect(result.args).toEqual(editedArgs);

    // The proposal is now decided (approved), not lingering open.
    const decided = await sql<{ status: string }[]>`
      select status from public.proposals where plan->>'threadId' = ${threadId}`;
    expect(decided).toHaveLength(1);
    expect(decided[0].status).toBe("approved");

    // ── 3. History restore: a reconnecting/brand-new client rebuilds the thread
    //       from the persisted log. The restored view must equal the live one a
    //       subscriber accumulated across BOTH runs.
    const histRes = await client.agui.threads[":threadId"].history.$get({ param: { threadId } });
    expect(histRes.status).toBe(200);
    const hist = await histRes.json();
    if (!("state" in hist)) throw new Error("expected history");

    const liveTypes = [...typesOf(runOneEvents), ...typesOf(runTwoEvents)];
    expect(typesOf(hist.events as Ev[])).toEqual(liveTypes);
    expect(hist.state).toEqual({ phase: "completed" });
    const contents = (hist.messages as Array<{ content: string }>).map((m) => m.content);
    expect(contents).toContain("Hi — I'm Archer. Let's get your job hunt set up.");
    expect(contents).toContain("Done — I've sent it.");

    // ── 4. Idempotent replay: resubmitting the same decision is a no-op, not a
    //       new run — the contract holds end-to-end.
    const replayRes = await client.agui.run.$post({
      json: {
        threadId,
        resume: [{ interruptId: interrupt.id, status: "resolved", payload: { approved: true } }],
      },
    });
    const replayBody = await replayRes.json();
    expect(replayBody.status).toBe("noop");
  });
});
