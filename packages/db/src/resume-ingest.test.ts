import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyVersionProposal, getLiveProfileVersion, ingestProposedVersion } from "./queries.js";

// Integration test for resume/portfolio ingest (ARC-29): an upload becomes a
// PROPOSED profile version (never the live profile) that flows through the same
// proposals / apply-executor path onboarding uses. Asserts the proposed-not-live
// invariant, then drives one approval to prove it rides the existing executor.
//
// Targets the same migrated Postgres as packages/db/scripts/gen-types.sh builds.
// Point TEST_DATABASE_URL at it to run; skipped otherwise so no-DB CI stays green.
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// One synthetic signup. UUID is fixed + namespaced (…029) so reruns are idempotent.
const userId = "cccccccc-0000-4000-8000-000000000029";

describe.skipIf(!TEST_DB_URL)("resume / portfolio ingest", () => {
  let sql: postgres.Sql;

  const cleanup = async (db: postgres.Sql) => {
    await db`delete from public.proposals where plan->>'userId' = ${userId}`;
    await db`delete from public.activities where user_id = ${userId}`;
    // Spine rows + versions cascade from users, but proposals reference the version
    // by plan jsonb (no FK), so clear them first above; users delete cascades the rest.
    await db`delete from public.users where id = ${userId}`;
    await db`delete from auth.users where id = ${userId}`;
  };

  beforeAll(async () => {
    sql = postgres(TEST_DB_URL as string, { prepare: false, max: 1 });
  });

  beforeEach(async () => {
    await cleanup(sql);
    await sql`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${userId}, 'r@example.com', ${sql.json({ full_name: "Remi" })})`;
  });

  afterAll(async () => {
    await cleanup(sql);
    await sql.end();
  });

  it("creates a PROPOSED (not live) version, an activity, and a submitted proposal", async () => {
    const result = await ingestProposedVersion(sql, {
      userId,
      source: "resume",
      storageRef: "s3://uploads/cv.pdf",
      filename: "cv.pdf",
      attributes: { ideal_job: "staff eng" },
      details: { source: "resume", storageRef: "s3://uploads/cv.pdf", extractor: "stub" },
    });

    // The ingested version is proposed, NOT live — the whole point of the gate.
    expect(await getLiveProfileVersion(sql, userId)).toBeUndefined();
    const version = await sql<{ status: string; label: string }[]>`
      select status, label from profile_versions where id = ${result.versionId}`;
    expect(version[0].status).toBe("proposed");
    expect(version[0].label).toBe("resume import");

    // A succeeded proposal_exec activity records the raw-file storage reference.
    const activity = await sql<{ type: string; status: string; detail: { storageRef?: string } }[]>`
      select type, status, detail from activities where id = ${result.activityId}`;
    expect(activity[0]).toMatchObject({ type: "proposal_exec", status: "succeeded" });
    expect(activity[0].detail.storageRef).toBe("s3://uploads/cv.pdf");

    // The proposal is awaiting a human decision (submitted), on the version path.
    const proposal = await sql<{ kind: string; status: string }[]>`
      select kind, status from proposals where id = ${result.proposalId}`;
    expect(proposal[0]).toMatchObject({ kind: "profile_version", status: "submitted" });
  });

  it("populates version-scoped spine rows from the structured draft (ARC-64)", async () => {
    const result = await ingestProposedVersion(sql, {
      userId,
      source: "resume",
      storageRef: "s3://uploads/cv.pdf",
      attributes: { full_name: "Remi", summary: "Engineer." },
      spine: {
        workExperiences: [
          {
            title: "Staff Engineer",
            organization: "Acme",
            startDate: "2020-01-01",
            isCurrent: true,
          },
        ],
        education: [{ institution: "MIT", degree: "BSc" }],
        skills: [{ name: "TypeScript", yearsExperience: 8 }],
      },
    });

    // Spine rows are scoped to the PROPOSED version (not live), via version_id + user_id.
    const work = await sql<{ title: string; is_current: boolean; version_id: string }[]>`
      select title, is_current, version_id from work_experiences where user_id = ${userId}`;
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({ title: "Staff Engineer", is_current: true });
    expect(work[0].version_id).toBe(result.versionId);

    const education = await sql<{ institution: string }[]>`
      select institution from education where version_id = ${result.versionId}`;
    expect(education[0].institution).toBe("MIT");

    const skills = await sql<{ name: string; years_experience: number }[]>`
      select name, years_experience from skills where version_id = ${result.versionId}`;
    expect(skills[0]).toMatchObject({ name: "TypeScript", years_experience: 8 });

    // Still PROPOSED, not live — spine writes never touch the live profile.
    expect(await getLiveProfileVersion(sql, userId)).toBeUndefined();
  });

  it("flows through the apply executor: approving makes the proposed version live", async () => {
    const result = await ingestProposedVersion(sql, {
      userId,
      source: "resume",
      storageRef: "s3://uploads/cv.pdf",
      attributes: { ideal_job: "from resume" },
    });

    const applied = await applyVersionProposal(sql, result.proposalId, { action: "approve" });
    expect(applied.proposalStatus).toBe("completed");
    expect(applied.versionStatus).toBe("approved");

    const live = await getLiveProfileVersion(sql, userId);
    expect(live?.id).toBe(result.versionId);
    const profile = await sql<{ attributes: { ideal_job?: string } }[]>`
      select attributes from profiles where user_id = ${userId}`;
    expect(profile[0].attributes.ideal_job).toBe("from resume");
  });
});
