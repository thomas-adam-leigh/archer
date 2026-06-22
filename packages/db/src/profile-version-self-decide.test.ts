import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyVersionProposal,
  applyVersionProposalAsUser,
  createProfileVersion,
  getLiveProfileVersion,
  submitVersionProposal,
} from "./queries.js";

// Integration test for candidate self-approval (ARC-67): a user decides their OWN
// profile_version proposal without the owner admin secret, scoped by the proposal's
// own plan.userId. Asserts self-approve materialises the version, cross-user denial
// leaves the proposal untouched, and the owner path stays intact + distinct.
//
// Targets the same migrated Postgres as packages/db/scripts/gen-types.sh builds.
// Point TEST_DATABASE_URL at it to run; skipped otherwise so the no-DB CI run stays green.
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// Two synthetic signups: the owner (…028) and an unrelated attacker (…029).
const owner = "cccccccc-0000-4000-8000-000000000028";
const other = "cccccccc-0000-4000-8000-000000000029";

describe.skipIf(!TEST_DB_URL)("profile-version self-decide (ARC-67)", () => {
  let sql: postgres.Sql;

  const cleanup = async (db: postgres.Sql) => {
    await db`delete from public.proposals where plan->>'userId' in (${owner}, ${other})`;
    await db`delete from public.users where id in (${owner}, ${other})`;
    await db`delete from auth.users where id in (${owner}, ${other})`;
  };

  beforeAll(async () => {
    sql = postgres(TEST_DB_URL as string, { prepare: false, max: 1 });
  });

  beforeEach(async () => {
    await cleanup(sql);
    await sql`
      insert into auth.users (id, email, raw_user_meta_data) values
        (${owner}, 'owner@example.com', ${sql.json({ full_name: "Olive" })}),
        (${other}, 'other@example.com', ${sql.json({ full_name: "Mallory" })})`;
  });

  afterAll(async () => {
    await cleanup(sql);
    await sql.end();
  });

  const submitOwnVersion = async () => {
    const v = await createProfileVersion(sql, {
      userId: owner,
      attributes: { ideal_job: "staff eng" },
    });
    const { id } = await submitVersionProposal(sql, {
      userId: owner,
      versionId: v.id,
      title: "Approve your profile",
    });
    return { versionId: v.id, proposalId: id };
  };

  it("a candidate approves their OWN profile-version proposal (no admin secret)", async () => {
    const { versionId, proposalId } = await submitOwnVersion();

    const result = await applyVersionProposalAsUser(sql, proposalId, owner, { action: "approve" });
    expect(result).not.toHaveProperty("forbidden");
    expect(result).toMatchObject({ proposalStatus: "completed", versionStatus: "approved" });

    const live = await getLiveProfileVersion(sql, owner);
    expect(live?.id).toBe(versionId);
  });

  it("denies a cross-user decision and leaves the proposal untouched", async () => {
    const { proposalId } = await submitOwnVersion();

    const result = await applyVersionProposalAsUser(sql, proposalId, other, { action: "approve" });
    expect(result).toEqual({ forbidden: true });

    // The proposal is still pending and no profile went live for either user.
    const status = await sql<{ status: string }[]>`
      select status from proposals where id = ${proposalId}`;
    expect(status[0].status).toBe("submitted");
    expect(await getLiveProfileVersion(sql, owner)).toBeUndefined();
    expect(await getLiveProfileVersion(sql, other)).toBeUndefined();
  });

  it("denies a self-decision against an unknown proposal", async () => {
    const result = await applyVersionProposalAsUser(
      sql,
      "00000000-0000-4000-8000-000000000000",
      owner,
      { action: "approve" },
    );
    expect(result).toEqual({ forbidden: true });
  });

  it("the owner admin path still decides the same proposal (separate + intact)", async () => {
    const { versionId, proposalId } = await submitOwnVersion();

    // The owner Acceptance-Gate executor acts on any proposal regardless of caller.
    const result = await applyVersionProposal(sql, proposalId, { action: "approve" });
    expect(result).toMatchObject({ proposalStatus: "completed", versionStatus: "approved" });
    const live = await getLiveProfileVersion(sql, owner);
    expect(live?.id).toBe(versionId);
  });
});
