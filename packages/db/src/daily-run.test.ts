import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  failActivity,
  getDailyRun,
  rollupDailyRun,
  startActivity,
  succeedActivity,
} from "./queries.js";

// ── pure rollup (runs in CI, no database) ──────────────────────────────────
// rollupDailyRun() is the heart of ARC-143: it folds a day's collect activities
// into the single coherent run story the Web App dashboard renders. Pure over its
// rows, so the grouping is proven without a DB.
describe("rollupDailyRun", () => {
  const D = "2026-06-24";
  // A terminal collect Activity as runCollect leaves it: succeeded with the summary
  // detail, or failed with an error + detail.outcome='failed'.
  const board = (
    id: string,
    slug: string,
    status: "succeeded" | "failed" | "in_progress",
    detail: Record<string, unknown> | null,
    error: string | null = null,
  ) => ({
    id,
    board_slug: slug,
    status,
    detail,
    error,
    started_at: `${D}T09:00:00.000Z`,
    finished_at: status === "in_progress" ? null : `${D}T09:01:00.000Z`,
  });

  it("returns a null status (no run) for a day with no collect activities", () => {
    const run = rollupDailyRun(D, []);
    expect(run.status).toBeNull();
    expect(run.boards).toEqual([]);
    expect(run.jobsNew).toBe(0);
    expect(run.counts).toEqual({
      found: 0,
      nothing_today: 0,
      not_integrated: 0,
      failed: 0,
      collecting: 0,
    });
  });

  it("rolls a finished mixed run up into per-board outcomes + totals", () => {
    const run = rollupDailyRun(D, [
      board("a", "careerjet", "succeeded", {
        board: "careerjet",
        outcome: "found",
        scraped: 3,
        postingsNew: 2,
        candidaciesNew: 2,
      }),
      board("b", "careerjunction", "succeeded", {
        board: "careerjunction",
        outcome: "not_integrated",
      }),
      board("c", "pnet", "succeeded", {
        board: "pnet",
        outcome: "found",
        scraped: 5,
        postingsNew: 4,
        candidaciesNew: 4,
      }),
    ]);

    // Every board reached a terminal Activity → the run reads "done".
    expect(run.status).toBe("done");
    expect(run.finishedAt).toBe(`${D}T09:01:00.000Z`);
    // 2 + 4 new jobs across the two boards that found postings.
    expect(run.jobsNew).toBe(6);
    expect(run.postingsNew).toBe(6);
    expect(run.counts.found).toBe(2);
    expect(run.counts.not_integrated).toBe(1);
    expect(run.boards.map((b) => b.outcome)).toEqual(["found", "not_integrated", "found"]);
  });

  it("reads in_progress while any board is still collecting, withholding finishedAt", () => {
    const run = rollupDailyRun(D, [
      board("a", "careerjet", "succeeded", { outcome: "found", candidaciesNew: 1, postingsNew: 1 }),
      board("b", "pnet", "in_progress", { titles: ["dev"], fixture: false }),
    ]);

    expect(run.status).toBe("in_progress");
    // The still-running board reads "collecting" and the run withholds its finish time.
    expect(run.boards[1].outcome).toBe("collecting");
    expect(run.counts.collecting).toBe(1);
    expect(run.finishedAt).toBeNull();
  });

  it("surfaces a failed board as a distinct outcome carrying its error", () => {
    const run = rollupDailyRun(D, [
      board("a", "pnet", "failed", { board: "pnet", outcome: "failed" }, "login timeout"),
    ]);

    expect(run.status).toBe("done");
    expect(run.counts.failed).toBe(1);
    expect(run.boards[0].outcome).toBe("failed");
    expect(run.boards[0].error).toBe("login timeout");
  });

  it("falls back to board_slug when an in-progress row has no detail.board yet", () => {
    const run = rollupDailyRun(D, [board("a", "careerjunction", "in_progress", null)]);
    expect(run.boards[0].board).toBe("careerjunction");
    expect(run.boards[0].outcome).toBe("collecting");
  });
});

// ── DB integration (skipped without TEST_DATABASE_URL) ──────────────────────
// Proves getDailyRun() buckets a real user's collect activities by UTC day and
// rolls them up. Targets the same migrated Postgres as gen-types.sh; point
// TEST_DATABASE_URL at it to run, skipped otherwise so the default CI run stays green.
const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const userA = "aaaaaaaa-0000-4000-8000-000000000143";
const userB = "bbbbbbbb-0000-4000-8000-000000000143";

describe.skipIf(!TEST_DB_URL)("getDailyRun", () => {
  let sql: postgres.Sql;

  const cleanup = async (db: postgres.Sql) => {
    await db`delete from public.users where id in (${userA}, ${userB})`;
    await db`delete from auth.users where id in (${userA}, ${userB})`;
  };

  beforeAll(async () => {
    sql = postgres(TEST_DB_URL as string, { prepare: false, max: 1 });
    await cleanup(sql);
    await sql`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${userA}, 'a143@example.com', ${sql.json({ full_name: "Ada" })}),
             (${userB}, 'b143@example.com', ${sql.json({ full_name: "Ben" })})`;

    // Ada's daily run: pnet found 4, careerjet found 2, careerjunction not integrated.
    const pnet = await startActivity(sql, { type: "collect", boardSlug: "pnet", userId: userA });
    await succeedActivity(sql, pnet.id, {
      board: "pnet",
      outcome: "found",
      scraped: 5,
      postingsNew: 4,
      candidaciesNew: 4,
    });
    const cj = await startActivity(sql, { type: "collect", boardSlug: "careerjet", userId: userA });
    await succeedActivity(sql, cj.id, {
      board: "careerjet",
      outcome: "found",
      scraped: 2,
      postingsNew: 2,
      candidaciesNew: 2,
    });
    const cjun = await startActivity(sql, {
      type: "collect",
      boardSlug: "careerjunction",
      userId: userA,
    });
    await succeedActivity(sql, cjun.id, { board: "careerjunction", outcome: "not_integrated" });

    // A non-collect activity (match) on the same day must never join the run.
    const match = await startActivity(sql, { type: "match", userId: userA });
    await succeedActivity(sql, match.id, {});

    // Ben has his own in-progress collect that must never surface for Ada.
    await startActivity(sql, { type: "collect", boardSlug: "pnet", userId: userB });
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanup(sql);
    await sql.end();
  });

  it("rolls today's collect activities into one coherent per-board run", async () => {
    const run = await getDailyRun(sql, userA);
    expect(run.status).toBe("done");
    expect(run.boards).toHaveLength(3);
    // Ordered by board slug (the order the cron enqueues them).
    expect(run.boards.map((b) => b.board)).toEqual(["careerjet", "careerjunction", "pnet"]);
    expect(run.jobsNew).toBe(6);
    expect(run.counts.found).toBe(2);
    expect(run.counts.not_integrated).toBe(1);
  });

  it("scopes own-rows-only (never another user's run)", async () => {
    const runB = await getDailyRun(sql, userB);
    expect(runB.status).toBe("in_progress");
    expect(runB.boards).toHaveLength(1);
    expect(runB.boards[0].outcome).toBe("collecting");
  });

  it("returns a null-status empty run for a day with no collect run", async () => {
    const run = await getDailyRun(sql, userA, { date: "2020-01-01" });
    expect(run.status).toBeNull();
    expect(run.boards).toEqual([]);
  });
});
