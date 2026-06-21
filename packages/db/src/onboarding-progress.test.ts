import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addNegativeCriterion,
  addTargetTitle,
  applyVersionProposal,
  createProfileVersion,
  getOnboardingProgress,
  type OnboardingFlags,
  onboardingProgressFrom,
  submitAccountForReview,
  submitVersionProposal,
} from "./queries.js";

// The resumable onboarding step machine (ARC-66): the pure step derivation is
// covered for every stage without a DB; the integration walk drives the real
// substrate (profile_versions → target_titles/negative_criteria → accounts)
// through each step against a migrated Postgres.

const NONE: OnboardingFlags = {
  hasProfileData: false,
  draftGenerated: false,
  draftApproved: false,
  titlesGenerated: false,
  titlesApproved: false,
  negativeCriteriaCaptured: false,
  accountSubmitted: false,
};

describe("onboardingProgressFrom (pure step derivation)", () => {
  it("intro: nothing started", () => {
    const p = onboardingProgressFrom(NONE);
    expect(p.step).toBe("intro");
    expect(p.completed).toBe(false);
  });

  it("processing: profile data exists but no proposed draft yet", () => {
    const p = onboardingProgressFrom({ ...NONE, hasProfileData: true });
    expect(p.step).toBe("processing");
  });

  it("review: a draft has been generated (proposed) but not approved", () => {
    const p = onboardingProgressFrom({
      ...NONE,
      hasProfileData: true,
      draftGenerated: true,
    });
    expect(p.step).toBe("review");
  });

  it("titles: draft approved, titles not yet approved", () => {
    const p = onboardingProgressFrom({
      ...NONE,
      hasProfileData: true,
      draftGenerated: true,
      draftApproved: true,
    });
    expect(p.step).toBe("titles");
  });

  it("submitting: profile + titles approved + a negative criterion, not yet submitted", () => {
    const p = onboardingProgressFrom({
      ...NONE,
      hasProfileData: true,
      draftGenerated: true,
      draftApproved: true,
      titlesGenerated: true,
      titlesApproved: true,
      negativeCriteriaCaptured: true,
    });
    expect(p.step).toBe("submitting");
    expect(p.completed).toBe(false);
  });

  it("titles (not submitting) until a negative criterion is captured", () => {
    const p = onboardingProgressFrom({
      ...NONE,
      hasProfileData: true,
      draftGenerated: true,
      draftApproved: true,
      titlesGenerated: true,
      titlesApproved: true,
    });
    expect(p.step).toBe("titles");
  });

  it("done: the account has left onboarding (submitted) — completed, overrides earlier stages", () => {
    const p = onboardingProgressFrom({ ...NONE, accountSubmitted: true });
    expect(p.step).toBe("done");
    expect(p.completed).toBe(true);
  });

  it("echoes the substrate flags verbatim", () => {
    const flags: OnboardingFlags = {
      hasProfileData: true,
      draftGenerated: true,
      draftApproved: false,
      titlesGenerated: true,
      titlesApproved: false,
      negativeCriteriaCaptured: true,
      accountSubmitted: false,
    };
    const p = onboardingProgressFrom(flags);
    expect(p).toMatchObject({
      hasProfileData: true,
      draftGenerated: true,
      draftApproved: false,
      titlesGenerated: true,
      titlesApproved: false,
      negativeCriteriaCaptured: true,
    });
  });
});

// Integration: the same migrated Postgres as packages/db/scripts/gen-types.sh.
// Point TEST_DATABASE_URL at it to run; skipped otherwise so no-DB CI stays green.
const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const userId = "cccccccc-0000-4000-8000-000000000066";

describe.skipIf(!TEST_DB_URL)("getOnboardingProgress (substrate walk)", () => {
  let sql: postgres.Sql;

  const cleanup = async (db: postgres.Sql) => {
    await db`delete from public.proposals where plan->>'userId' = ${userId}`;
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
      values (${userId}, 'progress@example.com', ${sql.json({ full_name: "Priya" })})`;
  });

  afterAll(async () => {
    await cleanup(sql);
    await sql.end();
  });

  it("walks intro → processing → review → titles → submitting → done", async () => {
    // intro: a fresh signup with no profile data.
    expect((await getOnboardingProgress(sql, userId)).step).toBe("intro");

    // processing: a draft version exists, not yet proposed.
    const v = await createProfileVersion(sql, { userId, attributes: { ideal_job: "staff eng" } });
    let p = await getOnboardingProgress(sql, userId);
    expect(p.step).toBe("processing");
    expect(p.hasProfileData).toBe(true);
    expect(p.draftGenerated).toBe(false);

    // review: the draft is submitted as a proposed version.
    const proposal = await submitVersionProposal(sql, { userId, versionId: v.id, title: "v1" });
    p = await getOnboardingProgress(sql, userId);
    expect(p.step).toBe("review");
    expect(p.draftGenerated).toBe(true);
    expect(p.draftApproved).toBe(false);

    // titles: the proposed version is approved (now live).
    await applyVersionProposal(sql, proposal.id, { action: "approve" });
    p = await getOnboardingProgress(sql, userId);
    expect(p.step).toBe("titles");
    expect(p.draftApproved).toBe(true);

    // submitting: an active title + a negative criterion are captured.
    await addTargetTitle(sql, userId, "Senior Agentic AI Engineer");
    await addNegativeCriterion(sql, userId, "no on-call");
    p = await getOnboardingProgress(sql, userId);
    expect(p.step).toBe("submitting");
    expect(p.titlesGenerated).toBe(true);
    expect(p.titlesApproved).toBe(true);
    expect(p.negativeCriteriaCaptured).toBe(true);
    expect(p.completed).toBe(false);

    // done: the account is submitted for the Acceptance Gate.
    await submitAccountForReview(sql, userId);
    p = await getOnboardingProgress(sql, userId);
    expect(p.step).toBe("done");
    expect(p.completed).toBe(true);
  });
});
