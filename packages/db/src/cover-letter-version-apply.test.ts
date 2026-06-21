import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyCoverLetterVersionProposal,
  createCoverLetterVersion,
  getActiveCoverLetterVersion,
  getCandidacy,
  submitCoverLetterVersionProposal,
} from "./queries.js";

// Integration test for the cover-letter version apply executor (ARC-38): the
// proposal-driven approve / edit / reject loop over cover_letter_versions
// (20260620190000_cover_letter_versions.sql), the cover-letter analogue of the
// profile-version apply executor. Exercises the whole submit → decide round trip
// against a migrated Postgres: approve (supersede cycle), reject (back to
// drafting), approve-with-edits, the failure-rollback path, and idempotent replay,
// asserting the candidacy status machine drafting ⇄ in_review → approved.
//
// Targets the same migrated Postgres as packages/db/scripts/gen-types.sh builds.
// Point TEST_DATABASE_URL at it to run; skipped otherwise so no-DB CI stays green.
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// One synthetic signup + candidacy. UUIDs are fixed + namespaced (…038) so reruns
// are idempotent.
const userId = "cccccccc-0000-4000-8000-000000000038";
const boardSlug = "test-board-038";

describe.skipIf(!TEST_DB_URL)("cover-letter version apply executor", () => {
  let sql: postgres.Sql;
  let candidacyId: string;

  const cleanup = async (db: postgres.Sql) => {
    // proposals.candidacy_id is ON DELETE SET NULL, so drop our rows by plan owner.
    await db`delete from public.proposals where plan->>'userId' = ${userId}`;
    await db`delete from public.users where id = ${userId}`;
    await db`delete from auth.users where id = ${userId}`;
    await db`delete from public.postings where board_slug = ${boardSlug}`;
    await db`delete from public.boards where slug = ${boardSlug}`;
  };

  // A board → posting → candidacy chain (status 'drafting', the state a submit
  // gate requires) to hang cover-letter versions off.
  const seedCandidacy = async (db: postgres.Sql): Promise<string> => {
    await db`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${userId}, 'cl-apply@example.com', ${db.json({ full_name: "Cleo" })})`;
    await db`
      insert into public.boards (slug, name, base_url, cred_env_prefix)
      values (${boardSlug}, 'Test Board', 'https://example.test', 'TEST_BOARD_038')`;
    const posting = await db<{ id: string }[]>`
      insert into public.postings (board_slug, url, title)
      values (${boardSlug}, 'https://example.test/job/1', 'Staff Engineer')
      returning id`;
    const candidacy = await db<{ id: string }[]>`
      insert into public.candidacies (user_id, posting_id, status)
      values (${userId}, ${posting[0].id}, 'drafting')
      returning id`;
    return candidacy[0].id;
  };

  // Create a draft version + submit it for review (candidacy → in_review). Returns
  // the version id and proposal id, the precondition every decide test starts from.
  const submit = async (content = "Dear team,") => {
    const version = await createCoverLetterVersion(sql, { candidacyId, userId, content });
    const { id: proposalId } = await submitCoverLetterVersionProposal(sql, {
      candidacyId,
      userId,
      versionId: version.id,
      title: "Approve your cover letter",
    });
    return { versionId: version.id, proposalId };
  };

  const status = async (id: string) => (await getCandidacy(sql, candidacyId))?.status;

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

  it("submitting advances the candidacy drafting → in_review and proposes the version", async () => {
    const { versionId } = await submit();
    expect(await status(candidacyId)).toBe("in_review");
    const v = await sql<{ status: string }[]>`
      select status from cover_letter_versions where id = ${versionId}`;
    expect(v[0].status).toBe("proposed");
  });

  it("approve makes the version the active letter and advances to approved", async () => {
    const { versionId, proposalId } = await submit("Dear Acme,");
    const result = await applyCoverLetterVersionProposal(sql, proposalId, { action: "approve" });
    expect(result.proposalStatus).toBe("completed");
    expect(result.versionStatus).toBe("approved");
    expect(result.candidacyStatus).toBe("approved");

    const active = await getActiveCoverLetterVersion(sql, candidacyId);
    expect(active?.id).toBe(versionId);
  });

  it("approving a new version supersedes the prior active one (cycle)", async () => {
    const first = await submit("v1");
    await applyCoverLetterVersionProposal(sql, first.proposalId, { action: "approve" });

    // Re-open drafting (a re-draft) and submit a second version.
    await sql`update candidacies set status = 'drafting' where id = ${candidacyId}`;
    const second = await submit("v2");
    const result = await applyCoverLetterVersionProposal(sql, second.proposalId, {
      action: "approve",
    });
    expect(result.proposalStatus).toBe("completed");

    const active = await getActiveCoverLetterVersion(sql, candidacyId);
    expect(active?.id).toBe(second.versionId); // exactly one active version

    const prior = await sql<{ status: string }[]>`
      select status from cover_letter_versions where id = ${first.versionId}`;
    expect(prior[0].status).toBe("superseded");
  });

  it("reject returns the candidacy to drafting with feedback captured", async () => {
    const { versionId, proposalId } = await submit();
    const result = await applyCoverLetterVersionProposal(sql, proposalId, {
      action: "reject",
      note: "tone is off",
    });
    expect(result.proposalStatus).toBe("rejected");
    expect(result.versionStatus).toBe("rejected");
    expect(result.candidacyStatus).toBe("drafting");

    // No version was ever approved → no active letter.
    expect(await getActiveCoverLetterVersion(sql, candidacyId)).toBeUndefined();
    const note = await sql<{ decision_note: string }[]>`
      select decision_note from proposals where id = ${proposalId}`;
    expect(note[0].decision_note).toBe("tone is off");
  });

  it("approve-with-edits applies the edited payload before going live", async () => {
    const { proposalId } = await submit("original draft");
    const result = await applyCoverLetterVersionProposal(sql, proposalId, {
      action: "approve",
      edits: { content: "edited draft", label: "curated" },
    });
    expect(result.proposalStatus).toBe("completed");

    const active = await getActiveCoverLetterVersion(sql, candidacyId);
    expect(active?.content).toBe("edited draft");
    expect(active?.label).toBe("curated");
  });

  it("a failed apply rolls back: active letter untouched, proposal marked failed", async () => {
    // Establish an active v1 + an approved candidacy.
    const first = await submit("live v1");
    await applyCoverLetterVersionProposal(sql, first.proposalId, { action: "approve" });

    // A stale proposal pointing back at the already-approved v1: the "still-
    // proposable version" guard fails, forcing a rollback.
    const stale = await sql<{ id: string }[]>`
      insert into proposals (kind, title, plan, status, created_by, candidacy_id)
      values ('cover_letter_version', 'stale',
              ${sql.json({ kind: "cover_letter_version", userId, candidacyId, versionId: first.versionId })},
              'submitted', 'agent', ${candidacyId})
      returning id`;

    const result = await applyCoverLetterVersionProposal(sql, stale[0].id, { action: "approve" });
    expect(result.proposalStatus).toBe("failed");
    expect(result.error).toMatch(/not in a proposable state/);

    // v1 is still the active, approved version — the rollback left it untouched.
    const active = await getActiveCoverLetterVersion(sql, candidacyId);
    expect(active?.id).toBe(first.versionId);
  });

  it("replaying a decided proposal is a no-op returning its terminal state", async () => {
    const { proposalId } = await submit();
    await applyCoverLetterVersionProposal(sql, proposalId, { action: "approve" });

    // Second decide: the proposal is no longer 'submitted', so nothing changes.
    const replay = await applyCoverLetterVersionProposal(sql, proposalId, { action: "reject" });
    expect(replay.proposalStatus).toBe("completed");
    expect(replay.versionStatus).toBe("approved");
    expect(replay.candidacyStatus).toBe("approved");
  });
});
