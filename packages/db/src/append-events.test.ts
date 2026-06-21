import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendEvents, createRun, listThreads, loadThreadEvents } from "./queries.js";

// Integration test for appendEvents seq continuation (ARC-49): a second batch on
// the same run must continue the per-run seq instead of restarting at 0 (which
// would collide on the unique(run_id, seq) index in 20260620090000_archer_interaction.sql).
//
// Targets the same migrated Postgres as packages/db/scripts/gen-types.sh builds.
// Point TEST_DATABASE_URL at it to run:
//   pnpm --filter @archer/db test (with TEST_DATABASE_URL set)
// Skipped otherwise, so the default no-DB CI vitest run stays green.
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// One synthetic signup. UUID is fixed + namespaced (…049) so reruns are idempotent.
const userId = "cccccccc-0000-4000-8000-000000000049";

describe.skipIf(!TEST_DB_URL)("appendEvents seq continuation", () => {
  let sql: postgres.Sql;

  const cleanup = async (db: postgres.Sql) => {
    // public.users → threads → runs → events all cascade on delete.
    await db`delete from public.users where id = ${userId}`;
    await db`delete from auth.users where id = ${userId}`;
  };

  beforeAll(async () => {
    sql = postgres(TEST_DB_URL as string, { prepare: false, max: 1 });
    await cleanup(sql);
    // Signup fires on_auth_user_created → public.users + a bootstrapped thread.
    await sql`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${userId}, 'c49@example.com', ${sql.json({ full_name: "Cleo" })})`;
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanup(sql);
    await sql.end();
  });

  it("continues seq across two sequential batches on the same run", async () => {
    const [thread] = await listThreads(sql, userId);
    const run = await createRun(sql, { threadId: thread.id });

    // First batch opens the run; second batch appends to the same run — the
    // exact case the old per-call 0-based index broke on.
    const first = await appendEvents(sql, thread.id, run.id, [
      { type: "run_started" },
      { type: "messages_snapshot", data: { messages: [] } },
      { type: "state_delta", data: { patch: 1 } },
    ]);
    expect(first).toHaveLength(3);

    const second = await appendEvents(sql, thread.id, run.id, [
      { type: "tool_call_result", data: { ok: true } },
      { type: "run_finished" },
    ]);
    expect(second).toHaveLength(2);

    // The full run log replays with contiguous, unique seq in emission order.
    const log = (await loadThreadEvents(sql, thread.id)).filter((e) => e.run_id === run.id);
    expect(log.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(log.map((e) => e.type)).toEqual([
      "run_started",
      "messages_snapshot",
      "state_delta",
      "tool_call_result",
      "run_finished",
    ]);
    // The jsonb payload survives the round-trip through the multi-row insert.
    expect(log[3].data).toEqual({ ok: true });
  });

  it("returns [] for an empty batch without touching the DB", async () => {
    const [thread] = await listThreads(sql, userId);
    const run = await createRun(sql, { threadId: thread.id });
    expect(await appendEvents(sql, thread.id, run.id, [])).toEqual([]);
  });
});
