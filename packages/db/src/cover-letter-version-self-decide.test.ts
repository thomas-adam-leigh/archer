import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyCoverLetterVersionProposal,
  applyCoverLetterVersionProposalAsUser,
  createCoverLetterVersion,
  getActiveCoverLetterVersion,
  getCandidacy,
  submitCoverLetterVersionProposal,
} from "./queries.js";

// Integration test for candidate self-approval of a cover letter (ARC-161): a user
// decides their OWN cover_letter_version proposal without the owner admin secret,
// scoped by the proposal's own plan.userId. The cover-letter analogue of the
// profile-version self-decide test (ARC-67). Asserts self-approve makes the version
// the active letter (candidacy → approved), self-reject returns it to drafting,
// cross-user denial leaves the proposal untouched, and the owner path stays intact.
//
// Targets the same migrated Postgres as packages/db/scripts/gen-types.sh builds.
// Point TEST_DATABASE_URL at it to run; skipped otherwise so no-DB CI stays green.
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// One owner signup (…048) + an unrelated attacker (…049), each namespaced so reruns
// are idempotent. Only the owner gets a candidacy to hang cover-letter versions off.
const owner = "cccccccc-0000-4000-8000-000000000048";
const other = "cccccccc-0000-4000-8000-000000000049";
const boardSlug = "test-board-048";

describe.skipIf(!TEST_DB_URL)("cover-letter version self-decide (ARC-161)", () => {
  let sql: postgres.Sql;
  let candidacyId: string;

  const cleanup = async (db: postgres.Sql) => {
    // proposals.candidacy_id is ON DELETE SET NULL, so drop our rows by plan owner.
    await db`delete from public.proposals where plan->>'userId' in (${owner}, ${other})`;
    await db`delete from public.users where id in (${owner}, ${other})`;
    await db`delete from auth.users where id in (${owner}, ${other})`;
    await db`delete from public.postings where board_slug = ${boardSlug}`;
    await db`delete from public.boards where slug = ${boardSlug}`;
  };

  // A board → posting → candidacy chain (status 'drafting') for the owner.
  const seedCandidacy = async (db: postgres.Sql): Promise<string> => {
    await db`
      insert into auth.users (id, email, raw_user_meta_data) values
        (${owner}, 'cl-owner@example.com', ${db.json({ full_name: "Olive" })}),
        (${other}, 'cl-other@example.com', ${db.json({ full_name: "Mallory" })})`;
    await db`
      insert into public.boards (slug, name, base_url, cred_env_prefix)
      values (${boardSlug}, 'Test Board', 'https://example.test', 'TEST_BOARD_048')`;
    const posting = await db<{ id: string }[]>`
      insert into public.postings (board_slug, url, title)
      values (${boardSlug}, 'https://example.test/job/1', 'Staff Engineer')
      returning id`;
    const candidacy = await db<{ id: string }[]>`
      insert into public.candidacies (user_id, posting_id, status)
      values (${owner}, ${posting[0].id}, 'drafting')
      returning id`;
    return candidacy[0].id;
  };

  // Draft a version + submit it for review (candidacy → in_review), the precondition
  // every decide test starts from. Returns the version id and proposal id.
  const submit = async (content = "Dear Acme,") => {
    const version = await createCoverLetterVersion(sql, { candidacyId, userId: owner, content });
    const { id: proposalId } = await submitCoverLetterVersionProposal(sql, {
      candidacyId,
      userId: owner,
      versionId: version.id,
      title: "Approve your cover letter",
    });
    return { versionId: version.id, proposalId };
  };

  const candidacyStatus = async () => (await getCandidacy(sql, candidacyId))?.status;

  beforeAll(async () => {
    sql = postgres(TEST_DB_URL as string, { prepare: false, max: 1 });
  });

  beforeEach(async () => {
    await cleanup(sql);
    candidacyId = await seedCandidacy(sql);
  });

  afterAll(async () => {
    await cleanup(sql);
    await sql.end();
  });

  it("a candidate approves their OWN cover-letter proposal (no admin secret)", async () => {
    const { versionId, proposalId } = await submit();

    const result = await applyCoverLetterVersionProposalAsUser(sql, proposalId, owner, {
      action: "approve",
    });
    expect(result).not.toHaveProperty("forbidden");
    expect(result).toMatchObject({
      proposalStatus: "completed",
      versionStatus: "approved",
      candidacyStatus: "approved",
    });

    const active = await getActiveCoverLetterVersion(sql, candidacyId);
    expect(active?.id).toBe(versionId);
  });

  it("a candidate rejects their OWN cover-letter proposal back to drafting", async () => {
    const { versionId, proposalId } = await submit();

    const result = await applyCoverLetterVersionProposalAsUser(sql, proposalId, owner, {
      action: "reject",
      note: "Lead with the fintech experience",
    });
    expect(result).toMatchObject({
      proposalStatus: "rejected",
      versionStatus: "rejected",
      candidacyStatus: "drafting",
    });
    expect(await candidacyStatus()).toBe("drafting");
    expect(await getActiveCoverLetterVersion(sql, candidacyId)).toBeUndefined();

    // The feedback note is captured on the decided proposal.
    const note = await sql<{ decision_note: string | null }[]>`
      select decision_note from proposals where id = ${proposalId}`;
    expect(note[0].decision_note).toBe("Lead with the fintech experience");

    void versionId;
  });

  it("denies a cross-user decision and leaves the proposal untouched", async () => {
    const { proposalId } = await submit();

    const result = await applyCoverLetterVersionProposalAsUser(sql, proposalId, other, {
      action: "approve",
    });
    expect(result).toEqual({ forbidden: true });

    // The proposal is still pending, the candidacy still in review, no active letter.
    const status = await sql<{ status: string }[]>`
      select status from proposals where id = ${proposalId}`;
    expect(status[0].status).toBe("submitted");
    expect(await candidacyStatus()).toBe("in_review");
    expect(await getActiveCoverLetterVersion(sql, candidacyId)).toBeUndefined();
  });

  it("denies a self-decision against an unknown proposal", async () => {
    const result = await applyCoverLetterVersionProposalAsUser(
      sql,
      "00000000-0000-4000-8000-000000000000",
      owner,
      { action: "approve" },
    );
    expect(result).toEqual({ forbidden: true });
  });

  it("the owner admin path still decides the same proposal (separate + intact)", async () => {
    const { versionId, proposalId } = await submit();

    // The owner executor acts on any proposal regardless of caller.
    const result = await applyCoverLetterVersionProposal(sql, proposalId, { action: "approve" });
    expect(result).toMatchObject({ proposalStatus: "completed", versionStatus: "approved" });
    const active = await getActiveCoverLetterVersion(sql, candidacyId);
    expect(active?.id).toBe(versionId);
  });
});
