import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyVersionProposal,
  createProfileVersion,
  getLiveProfileVersion,
  submitVersionProposal,
} from "./queries.js";

// Integration test for the profile-version apply executor (ARC-27):
//   profile_versions + profiles.attributes (20260620150000_archer_profile_spine.sql)
//   driven through the proposals substrate (20260619101500_archer_core.sql).
// Exercises the whole submit → decide round trip against a migrated Postgres:
// approve, reject, approve-with-edits, and the failure-rollback path.
//
// Targets the same migrated Postgres as packages/db/scripts/gen-types.sh builds.
// Point TEST_DATABASE_URL at it to run:
//   pnpm --filter @archer/db test (with TEST_DATABASE_URL set)
// Skipped otherwise, so the default no-DB CI vitest run stays green.
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// One synthetic signup. UUID is fixed + namespaced (…027) so reruns are idempotent.
const userId = "cccccccc-0000-4000-8000-000000000027";

describe.skipIf(!TEST_DB_URL)("profile-version apply executor", () => {
  let sql: postgres.Sql;

  const cleanup = async (db: postgres.Sql) => {
    // public.users cascades to profiles, profile_versions, and spine rows.
    await db`delete from public.proposals where plan->>'userId' = ${userId}`;
    await db`delete from public.users where id = ${userId}`;
    await db`delete from auth.users where id = ${userId}`;
  };

  beforeAll(async () => {
    sql = postgres(TEST_DB_URL as string, { prepare: false, max: 1 });
  });

  beforeEach(async () => {
    await cleanup(sql);
    // Signup fires on_auth_user_created → public.users (+ first thread).
    await sql`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${userId}, 'c@example.com', ${sql.json({ full_name: "Cara" })})`;
  });

  afterAll(async () => {
    await cleanup(sql);
    await sql.end();
  });

  it("approve atomically materialises the version as the live profile", async () => {
    const v = await createProfileVersion(sql, {
      userId,
      label: "v1",
      attributes: { ideal_job: "staff eng" },
    });
    // A spine row hangs off the version; it is the live profile once approved.
    await sql`
      insert into work_experiences (user_id, version_id, title, organization)
      values (${userId}, ${v.id}, 'Senior Engineer', 'Acme')`;

    const { id: proposalId } = await submitVersionProposal(sql, {
      userId,
      versionId: v.id,
      title: "Approve profile v1",
    });

    const result = await applyVersionProposal(sql, proposalId, { action: "approve" });
    expect(result.proposalStatus).toBe("completed");
    expect(result.versionStatus).toBe("approved");

    const live = await getLiveProfileVersion(sql, userId);
    expect(live?.id).toBe(v.id);
    // profiles.attributes is synced from the now-live version's snapshot.
    const profile = await sql<{ attributes: { ideal_job?: string } }[]>`
      select attributes from profiles where user_id = ${userId}`;
    expect(profile[0].attributes.ideal_job).toBe("staff eng");
  });

  it("approve materialises the version snapshot into the typed profile columns (ARC-130)", async () => {
    const v = await createProfileVersion(sql, {
      userId,
      attributes: {
        summary: "Pragmatic staff engineer.",
        location: "Cape Town, ZA",
        years_experience: 9,
        links: { linkedin: "https://linkedin.com/in/cara", website: "https://cara.dev" },
      },
      details: { resumeText: "Cara — full résumé text." },
    });
    const { id: proposalId } = await submitVersionProposal(sql, {
      userId,
      versionId: v.id,
      title: "Approve typed v1",
    });

    await applyVersionProposal(sql, proposalId, { action: "approve" });

    const profile = await sql<
      {
        about: string | null;
        location: string | null;
        linkedin_url: string | null;
        portfolio_url: string | null;
        resume_text: string | null;
        years_experience: number | null;
      }[]
    >`
      select about, location, linkedin_url, portfolio_url, resume_text, years_experience
      from profiles where user_id = ${userId}`;
    expect(profile[0]).toEqual({
      about: "Pragmatic staff engineer.",
      location: "Cape Town, ZA",
      linkedin_url: "https://linkedin.com/in/cara",
      portfolio_url: "https://cara.dev",
      resume_text: "Cara — full résumé text.",
      years_experience: 9,
    });
  });

  it("portfolio_url falls back to github when no website link is present", async () => {
    const v = await createProfileVersion(sql, {
      userId,
      attributes: { links: { github: "https://github.com/cara" } },
    });
    const { id: proposalId } = await submitVersionProposal(sql, {
      userId,
      versionId: v.id,
      title: "github fallback",
    });
    await applyVersionProposal(sql, proposalId, { action: "approve" });

    const profile = await sql<{ portfolio_url: string | null }[]>`
      select portfolio_url from profiles where user_id = ${userId}`;
    expect(profile[0].portfolio_url).toBe("https://github.com/cara");
  });

  it("re-materialises typed columns when a new version supersedes the prior one", async () => {
    const v1 = await createProfileVersion(sql, {
      userId,
      attributes: { summary: "first", location: "Joburg" },
    });
    const p1 = await submitVersionProposal(sql, { userId, versionId: v1.id, title: "v1" });
    await applyVersionProposal(sql, p1.id, { action: "approve" });

    const v2 = await createProfileVersion(sql, { userId, attributes: { summary: "second" } });
    const p2 = await submitVersionProposal(sql, { userId, versionId: v2.id, title: "v2" });
    await applyVersionProposal(sql, p2.id, { action: "approve" });

    // The typed columns track the now-live version — overwritten cleanly, with
    // fields absent from v2 nulled out rather than left stale from v1.
    const profile = await sql<{ about: string | null; location: string | null }[]>`
      select about, location from profiles where user_id = ${userId}`;
    expect(profile[0]).toEqual({ about: "second", location: null });
  });

  it("approving a new version supersedes the prior live one (cycle)", async () => {
    const v1 = await createProfileVersion(sql, { userId, attributes: { ideal_job: "first" } });
    const p1 = await submitVersionProposal(sql, { userId, versionId: v1.id, title: "v1" });
    await applyVersionProposal(sql, p1.id, { action: "approve" });

    const v2 = await createProfileVersion(sql, { userId, attributes: { ideal_job: "second" } });
    const p2 = await submitVersionProposal(sql, { userId, versionId: v2.id, title: "v2" });
    const result = await applyVersionProposal(sql, p2.id, { action: "approve" });
    expect(result.proposalStatus).toBe("completed");

    const live = await getLiveProfileVersion(sql, userId);
    expect(live?.id).toBe(v2.id); // exactly one live version per user

    const v1Status = await sql<{ status: string }[]>`
      select status from profile_versions where id = ${v1.id}`;
    expect(v1Status[0].status).toBe("superseded");
  });

  it("reject leaves the live profile untouched", async () => {
    const v = await createProfileVersion(sql, { userId, attributes: { ideal_job: "draft only" } });
    const { id: proposalId } = await submitVersionProposal(sql, {
      userId,
      versionId: v.id,
      title: "Reject me",
    });

    const result = await applyVersionProposal(sql, proposalId, {
      action: "reject",
      note: "not sincere enough",
    });
    expect(result.proposalStatus).toBe("rejected");
    expect(result.versionStatus).toBe("rejected");

    // No version was ever approved → no live profile.
    expect(await getLiveProfileVersion(sql, userId)).toBeUndefined();
  });

  it("approve-with-edits applies the edited payload before going live", async () => {
    const v = await createProfileVersion(sql, { userId, attributes: { ideal_job: "original" } });
    const { id: proposalId } = await submitVersionProposal(sql, {
      userId,
      versionId: v.id,
      title: "Edit then approve",
    });

    const result = await applyVersionProposal(sql, proposalId, {
      action: "approve",
      edits: { attributes: { ideal_job: "edited", ai_fluency: "high" }, label: "curated" },
    });
    expect(result.proposalStatus).toBe("completed");

    const live = await getLiveProfileVersion(sql, userId);
    expect(live?.label).toBe("curated");
    expect((live?.attributes as { ideal_job?: string }).ideal_job).toBe("edited");
    const profile = await sql<{ attributes: { ideal_job?: string; ai_fluency?: string } }[]>`
      select attributes from profiles where user_id = ${userId}`;
    expect(profile[0].attributes).toMatchObject({ ideal_job: "edited", ai_fluency: "high" });
  });

  it("a failed apply rolls back: live profile untouched, proposal marked failed", async () => {
    // Establish a live v1.
    const v1 = await createProfileVersion(sql, { userId, attributes: { ideal_job: "live v1" } });
    const p1 = await submitVersionProposal(sql, { userId, versionId: v1.id, title: "v1" });
    await applyVersionProposal(sql, p1.id, { action: "approve" });

    // Submit a SECOND proposal that points back at the already-approved v1: the
    // executor's "still-proposable version" guard fails, forcing a rollback.
    const stale = await sql<{ id: string }[]>`
      insert into proposals (kind, title, plan, status, created_by)
      values ('profile_version', 'stale', ${sql.json({ kind: "profile_version", userId, versionId: v1.id })},
              'submitted', 'agent')
      returning id`;

    const result = await applyVersionProposal(sql, stale[0].id, { action: "approve" });
    expect(result.proposalStatus).toBe("failed");
    expect(result.error).toMatch(/not in a proposable state/);

    // v1 is still the live, approved version — the rollback left it untouched.
    const live = await getLiveProfileVersion(sql, userId);
    expect(live?.id).toBe(v1.id);
    const profile = await sql<{ attributes: { ideal_job?: string } }[]>`
      select attributes from profiles where user_id = ${userId}`;
    expect(profile[0].attributes.ideal_job).toBe("live v1");
  });

  it("replaying a decided proposal is a no-op returning its terminal state", async () => {
    const v = await createProfileVersion(sql, { userId, attributes: {} });
    const { id: proposalId } = await submitVersionProposal(sql, {
      userId,
      versionId: v.id,
      title: "once",
    });
    await applyVersionProposal(sql, proposalId, { action: "approve" });

    // Second decide: the proposal is no longer 'submitted', so nothing changes.
    const replay = await applyVersionProposal(sql, proposalId, { action: "reject" });
    expect(replay.proposalStatus).toBe("completed");
    expect(replay.versionStatus).toBe("approved");
  });
});
