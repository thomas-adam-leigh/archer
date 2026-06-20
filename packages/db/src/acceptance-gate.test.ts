import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyVersionProposal,
  checkReadiness,
  createProfileVersion,
  decideAccount,
  getAccount,
  isAccepted,
  submitAccountForReview,
  submitVersionProposal,
} from "./queries.js";

// Integration test for the acceptance gate (ARC-31):
//   accounts + account_status (20260620170000_acceptance_gate.sql), with the
//   readiness check reading target_titles/negative_criteria (archer_core) +
//   profile_versions (archer_profile_spine).
// Exercises the lifecycle end-to-end against a migrated Postgres: submit, the
// owner's accept (gated on readiness) and reject paths, resubmit, and the
// collect/match gate (isAccepted).
//
// Targets the same migrated Postgres as packages/db/scripts/gen-types.sh builds.
// Point TEST_DATABASE_URL at it to run:
//   pnpm --filter @archer/db test (with TEST_DATABASE_URL set)
// Skipped otherwise, so the default no-DB CI vitest run stays green.
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// One synthetic signup. UUID is fixed + namespaced (…031) so reruns are idempotent.
const userId = "cccccccc-0000-4000-8000-000000000031";

describe.skipIf(!TEST_DB_URL)("acceptance gate", () => {
  let sql: postgres.Sql;

  const cleanup = async (db: postgres.Sql) => {
    // public.users cascades to accounts, profiles, profile_versions, titles, etc.
    await db`delete from public.proposals where plan->>'userId' = ${userId}`;
    await db`delete from public.users where id = ${userId}`;
    await db`delete from auth.users where id = ${userId}`;
  };

  // Make the user pass the readiness check: 1–5 target titles + ≥1 negative
  // criterion + a complete-enough profile (an approved profile version).
  const makeReady = async (db: postgres.Sql) => {
    await db`insert into target_titles (user_id, title) values (${userId}, 'Backend Engineer')`;
    await db`insert into negative_criteria (user_id, text) values (${userId}, 'no on-call')`;
    const v = await createProfileVersion(db, { userId, attributes: { ideal_job: "staff eng" } });
    const p = await submitVersionProposal(db, { userId, versionId: v.id, title: "v1" });
    await applyVersionProposal(db, p.id, { action: "approve" });
  };

  beforeAll(async () => {
    sql = postgres(TEST_DB_URL as string, { prepare: false, max: 1 });
  });

  beforeEach(async () => {
    await cleanup(sql);
    // Signup fires on_auth_user_created → public.users (+ first thread).
    await sql`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${userId}, 'gate@example.com', ${sql.json({ full_name: "Gabi" })})`;
  });

  afterAll(async () => {
    await cleanup(sql);
    await sql.end();
  });

  it("defaults to onboarding with no account row, and reports unmet readiness", async () => {
    expect(await getAccount(sql, userId)).toBeUndefined();
    expect(await isAccepted(sql, userId)).toBe(false);
    const readiness = await checkReadiness(sql, userId);
    expect(readiness.ready).toBe(false);
    expect(readiness.reasons).toHaveLength(3); // no titles, no criteria, no profile
  });

  it("submit provisions the row just-in-time and moves it to submitted", async () => {
    const account = await submitAccountForReview(sql, userId);
    expect(account.status).toBe("submitted");
    expect(account.submitted_at).not.toBeNull();
  });

  it("accept requires the readiness check — refused while not ready", async () => {
    await submitAccountForReview(sql, userId);
    const result = await decideAccount(sql, userId, { action: "accept" });
    expect(result.error).toMatch(/readiness check failed/);
    expect(result.readiness?.ready).toBe(false);
    expect(result.status).toBe("submitted"); // unchanged
    expect(await isAccepted(sql, userId)).toBe(false);
  });

  it("accepted path: a ready, submitted account is accepted with a note", async () => {
    await makeReady(sql);
    await submitAccountForReview(sql, userId);
    const result = await decideAccount(sql, userId, { action: "accept", note: "sincere + deep" });
    expect(result.status).toBe("accepted");
    expect(result.readiness?.ready).toBe(true);
    expect(await isAccepted(sql, userId)).toBe(true);

    const account = await getAccount(sql, userId);
    expect(account?.review_note).toBe("sincere + deep");
    expect(account?.reviewed_at).not.toBeNull();
  });

  it("accepted path can route through an explicit under_review step", async () => {
    await makeReady(sql);
    await submitAccountForReview(sql, userId);
    const review = await decideAccount(sql, userId, { action: "review" });
    expect(review.status).toBe("under_review");
    const result = await decideAccount(sql, userId, { action: "accept" });
    expect(result.status).toBe("accepted");
  });

  it("rejected path: an account is rejected with a note, and may resubmit", async () => {
    await submitAccountForReview(sql, userId);
    const rejected = await decideAccount(sql, userId, {
      action: "reject",
      note: "not enough depth",
    });
    expect(rejected.status).toBe("rejected");
    expect((await getAccount(sql, userId))?.review_note).toBe("not enough depth");
    expect(await isAccepted(sql, userId)).toBe(false);

    // A rejected user may resubmit for another review.
    const resubmitted = await submitAccountForReview(sql, userId);
    expect(resubmitted.status).toBe("submitted");
  });

  it("deciding an account that is not awaiting review is refused", async () => {
    // Still onboarding (never submitted) → accept/reject have nothing to act on.
    const result = await decideAccount(sql, userId, { action: "reject" });
    expect(result.error).toMatch(/not awaiting review/);
    expect(result.status).toBeNull(); // no account row exists yet
  });
});
