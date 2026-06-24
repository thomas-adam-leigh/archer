import { createDb, type Db, getBoard, setBoardStatus } from "@archer/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NotIntegratedError, type ScrapedPosting } from "./adapters/types.js";
import { runCollect } from "./commands/collect.js";

// Proves the board collect-status lifecycle (ARC-10): a LIVE collect run reconciles
// boards.collect_status to its outcome — a clean run (re)integrates the board, a
// failure breaks it ONLY if it was integrated, and a refusal from a never-integrated
// board leaves it untouched — all while never touching the independent apply_status.
// Fixture runs bypass the live adapter and so never move board status. Exercised over
// the gather() stub boundary on a dedicated throwaway board, no live browser.
//
// DB-backed like the other collect tests: point TEST_DATABASE_URL at a migrated
// Postgres to run (`pnpm --filter @archer/cli test`); skipped otherwise so the
// no-DB CI run stays green. The lifecycle decision itself is unit-tested DB-free in
// collect-board-status.test.ts, so CI proves the logic; this proves the wiring.
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// A dedicated board + user, fixed/namespaced UUIDs so reruns are idempotent and
// seed boards (careerjunction/pnet/careerjet) are never mutated by these tests.
const BOARD = "arc10-board";
const userId = "cccccccc-0000-4000-8000-000000000010";

const POSTING: ScrapedPosting[] = [
  { url: "https://arc10.test/job/a", title: "Platform Engineer", companyName: "Arc10 Test Co" },
];

describe.skipIf(!TEST_DB_URL)("ARC-10 — board collect-status lifecycle (live runs)", () => {
  let sql: Db;

  const cleanup = async (db: Db) => {
    await db`delete from public.activities where user_id = ${userId}`;
    await db`delete from public.candidacies where user_id = ${userId}`;
    await db`delete from public.postings where board_slug = ${BOARD}`;
    await db`delete from public.companies where name = 'Arc10 Test Co'`;
    await db`delete from public.users where id = ${userId}`;
    await db`delete from auth.users where id = ${userId}`;
    await db`delete from public.boards where slug = ${BOARD}`;
  };

  const collectStatus = async () => (await getBoard(sql, BOARD))?.collect_status;
  const applyStatus = async () => (await getBoard(sql, BOARD))?.apply_status;

  beforeAll(async () => {
    sql = createDb({ DATABASE_URL: TEST_DB_URL });
    await cleanup(sql);
    await sql`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${userId}, 'arc10@example.com', ${sql.json({ full_name: "Arc Ten" })})`;
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanup(sql);
    await sql.end();
  });

  // Each case starts from a known board status (the seed default is not_integrated).
  beforeEach(async () => {
    await sql`
      insert into public.boards (slug, name, base_url, cred_env_prefix)
      values (${BOARD}, 'ARC10 Test Board', 'https://arc10.test', 'ARC10')
      on conflict (slug) do update set collect_status = 'not_integrated', apply_status = 'not_integrated'`;
  });

  const liveCollect = (gather: () => Promise<ScrapedPosting[]>) =>
    runCollect(sql, { board: BOARD, userId, titles: [], fixture: false, gather });

  it("a clean live run integrates the board without touching apply_status", async () => {
    expect(await collectStatus()).toBe("not_integrated");
    await liveCollect(async () => POSTING);
    expect(await collectStatus()).toBe("integrated");
    expect(await applyStatus()).toBe("not_integrated"); // collect is independent of apply
  });

  it("a failed live run breaks a board that was integrated", async () => {
    await setBoardStatus(sql, BOARD, { collect: "integrated" });
    await expect(
      liveCollect(async () => Promise.reject(new Error("scrape blew up"))),
    ).rejects.toThrow("scrape blew up");
    expect(await collectStatus()).toBe("broken");
    expect(await applyStatus()).toBe("not_integrated");
  });

  it("a clean live run restores a broken board to integrated", async () => {
    await setBoardStatus(sql, BOARD, { collect: "broken" });
    await liveCollect(async () => POSTING);
    expect(await collectStatus()).toBe("integrated");
  });

  it("a not-integrated board is a clean succeeded outcome, not a failure (ARC-140)", async () => {
    expect(await collectStatus()).toBe("not_integrated");
    // The run no longer throws: a NotIntegratedError is a calm, expected state.
    const summary = await liveCollect(async () => {
      throw new NotIntegratedError("board not integrated");
    });
    expect(summary.outcome).toBe("not_integrated");
    expect(await collectStatus()).toBe("not_integrated"); // visible state ≠ breakage
    const [activity] = await sql<{ status: string; detail: { outcome?: string } }[]>`
      select status, detail from public.activities where user_id = ${userId} and board_slug = ${BOARD}
      order by started_at desc limit 1`;
    expect(activity.status).toBe("succeeded"); // recorded clean, never failed
    expect(activity.detail.outcome).toBe("not_integrated");
  });

  it("a fixture run never moves board status", async () => {
    await setBoardStatus(sql, BOARD, { collect: "broken" });
    await runCollect(sql, {
      board: BOARD,
      userId,
      titles: [],
      fixture: true,
      gather: async () => POSTING,
    });
    expect(await collectStatus()).toBe("broken"); // fixture bypasses the live adapter
  });
});
