import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyConfirmMode, isApplyConfirmationRequired } from "./apply-confirm.js";
import { confirmApply, getCandidacy } from "./queries.js";

// ARC-165 — apply-safety. Two halves:
//   1. applyConfirmMode() — a pure parser of ARCHER_APPLY_CONFIRM_MODE (runs in the
//      no-DB CI vitest pass).
//   2. isApplyConfirmationRequired() + confirmApply() — DB-backed, against the same
//      migrated Postgres gen-types.sh builds. Point TEST_DATABASE_URL at it to run;
//      skipped otherwise so no-DB CI stays green.

describe("applyConfirmMode — ARCHER_APPLY_CONFIRM_MODE parser", () => {
  it("defaults to always when unset, blank, or 'always'", () => {
    expect(applyConfirmMode({})).toEqual({ kind: "always" });
    expect(applyConfirmMode({ ARCHER_APPLY_CONFIRM_MODE: "" })).toEqual({ kind: "always" });
    expect(applyConfirmMode({ ARCHER_APPLY_CONFIRM_MODE: "   " })).toEqual({ kind: "always" });
    expect(applyConfirmMode({ ARCHER_APPLY_CONFIRM_MODE: "always" })).toEqual({ kind: "always" });
    expect(applyConfirmMode({ ARCHER_APPLY_CONFIRM_MODE: " ALWAYS " })).toEqual({ kind: "always" });
  });

  it("parses a positive integer as first-N", () => {
    expect(applyConfirmMode({ ARCHER_APPLY_CONFIRM_MODE: "3" })).toEqual({ kind: "first-n", n: 3 });
    expect(applyConfirmMode({ ARCHER_APPLY_CONFIRM_MODE: " 1 " })).toEqual({
      kind: "first-n",
      n: 1,
    });
  });

  it("fails safe to always for non-positive or non-numeric values", () => {
    for (const v of ["0", "-2", "abc", "2.5"]) {
      expect(applyConfirmMode({ ARCHER_APPLY_CONFIRM_MODE: v })).toEqual({ kind: "always" });
    }
  });
});

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const userId = "cccccccc-0000-4000-8000-000000000165";
const boardSlug = "test-board-165";

describe.skipIf(!TEST_DB_URL)("apply-confirm DB surface (ARC-165)", () => {
  let sql: postgres.Sql;

  const cleanup = async (db: postgres.Sql) => {
    await db`delete from public.users where id = ${userId}`;
    await db`delete from auth.users where id = ${userId}`;
    await db`delete from public.postings where board_slug = ${boardSlug}`;
    await db`delete from public.boards where slug = ${boardSlug}`;
  };

  // Seed one candidacy in `status` (default approved) on its own posting, so each
  // call adds a distinct row (candidacies are unique per user+posting).
  let seq = 0;
  const seedCandidacy = async (
    db: postgres.Sql,
    status: "approved" | "applied" | "in_review" = "approved",
  ): Promise<string> => {
    seq += 1;
    const posting = await db<{ id: string }[]>`
      insert into public.postings (board_slug, url, title)
      values (${boardSlug}, ${`https://example.test/job/${seq}`}, 'Staff Engineer')
      returning id`;
    const candidacy = await db<{ id: string }[]>`
      insert into public.candidacies (user_id, posting_id, status)
      values (${userId}, ${posting[0].id}, ${status}::public.candidacy_status)
      returning id`;
    return candidacy[0].id;
  };

  beforeAll(async () => {
    sql = postgres(TEST_DB_URL as string, { prepare: false, max: 1 });
  });

  beforeEach(async () => {
    await cleanup(sql);
    seq = 0;
    await sql`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${userId}, 'arc165@example.com', ${sql.json({ full_name: "Connie" })})`;
    await sql`
      insert into public.boards (slug, name, base_url, cred_env_prefix)
      values (${boardSlug}, 'Test Board', 'https://example.test', 'TEST_BOARD_165')`;
  });

  afterAll(async () => {
    await cleanup(sql);
    await sql.end();
  });

  it("always mode requires confirmation regardless of history", async () => {
    expect(await isApplyConfirmationRequired(sql, userId, { kind: "always" })).toBe(true);
    await seedCandidacy(sql, "applied");
    expect(await isApplyConfirmationRequired(sql, userId, { kind: "always" })).toBe(true);
  });

  it("first-N mode requires confirmation only until N applications have fired", async () => {
    const mode = { kind: "first-n", n: 2 } as const;
    expect(await isApplyConfirmationRequired(sql, userId, mode)).toBe(true); // 0 < 2
    await seedCandidacy(sql, "applied");
    expect(await isApplyConfirmationRequired(sql, userId, mode)).toBe(true); // 1 < 2
    await seedCandidacy(sql, "applied");
    expect(await isApplyConfirmationRequired(sql, userId, mode)).toBe(false); // 2 ≥ 2
  });

  it("confirmApply stamps an approved candidacy, idempotently, and only when approved", async () => {
    const approved = await seedCandidacy(sql, "approved");
    const first = await confirmApply(sql, approved);
    expect(first?.apply_confirmed_at).not.toBeNull();
    // Idempotent — re-confirming keeps the original timestamp.
    const second = await confirmApply(sql, approved);
    expect(second?.apply_confirmed_at).toBe(first?.apply_confirmed_at);

    // A non-approved candidacy cannot be confirmed — left untouched, undefined returned.
    const inReview = await seedCandidacy(sql, "in_review");
    expect(await confirmApply(sql, inReview)).toBeUndefined();
    expect((await getCandidacy(sql, inReview))?.apply_confirmed_at).toBeNull();
  });
});
