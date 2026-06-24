import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getOpenCoverLetterVersionProposal,
  listActivities,
  listCandidacies,
  listCompanies,
} from "./queries.js";
import {
  clearDemo,
  DEMO_COMPANY_PREFIX,
  DEMO_URL_HOST,
  SEED_MARKER,
  seedDemo,
} from "./seed-demo.js";

// Integration test for the owner-only demo seed (ARC-162):
//   seedDemo / clearDemo populate (and fully remove) a small fixture pipeline so the
//   real dashboard renders populated home / jobs / companies / cover-letters states.
// Exercises the dashboard-facing reads it must produce, idempotency on re-run, and
// teardown — against a migrated Postgres. Point TEST_DATABASE_URL at it to run:
//   pnpm --filter @archer/db test (with TEST_DATABASE_URL set)
// Skipped otherwise, so the default no-DB CI vitest run stays green.
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// One synthetic signup. UUID is fixed + namespaced (…162) so reruns are idempotent.
const userId = "cccccccc-0000-4000-8000-000000000162";

describe.skipIf(!TEST_DB_URL)("demo seed (ARC-162)", () => {
  let sql: postgres.Sql;

  const cleanup = async (db: postgres.Sql) => {
    await clearDemo(db, userId);
    await db`delete from public.users where id = ${userId}`;
    await db`delete from auth.users where id = ${userId}`;
  };

  beforeAll(async () => {
    sql = postgres(TEST_DB_URL as string);
    await cleanup(sql);
    // Signup fires on_auth_user_created → public.users for the owner.
    await sql`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${userId}, 'demo-seed@example.com', ${sql.json({ full_name: "Demo Owner" })})`;
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanup(sql);
    await sql.end();
  });

  it("seeds the dashboard-facing state across jobs, companies, cover-letters, and the run trail", async () => {
    const summary = await seedDemo(sql, userId);
    expect(summary).toEqual({
      companies: 4,
      contacts: 2,
      postings: 4,
      candidacies: 4,
      coverLetterVersions: 1,
      activities: 6,
    });

    // Jobs feed: only shortlisted + alternative_outreach (never new/dismissed/in_review).
    const shortlisted = await listCandidacies(sql, userId, { status: "shortlisted" });
    const altOutreach = await listCandidacies(sql, userId, { status: "alternative_outreach" });
    expect(shortlisted).toHaveLength(2);
    expect(altOutreach).toHaveLength(1);
    expect(shortlisted.every((c) => typeof c.match_score === "number")).toBe(true);

    // Companies route: exactly one enriched + one researching (the "Archer in action"
    // indicator), each reachable via one of the user's candidacies.
    const enriched = await listCompanies(sql, userId, { status: "enriched" });
    const researching = await listCompanies(sql, userId, { status: "researching" });
    expect(enriched).toHaveLength(1);
    expect(researching).toHaveLength(1);
    expect(enriched[0].name).toBe(`${DEMO_COMPANY_PREFIX}Helios Robotics`);
    const contacts = await sql<{ n: number }[]>`
      select count(*)::int as n from contacts where company_id = ${enriched[0].id}`;
    expect(contacts[0].n).toBe(2);

    // Cover-letters route: the in_review candidacy has an open review proposal.
    const inReview = await listCandidacies(sql, userId, { status: "in_review" });
    expect(inReview).toHaveLength(1);
    const open = await getOpenCoverLetterVersionProposal(sql, inReview[0].id);
    expect(open).not.toBeNull();
    const version = await sql<{ status: string }[]>`
      select status from cover_letter_versions where id = ${open?.versionId}`;
    expect(version[0].status).toBe("proposed");

    // Home: a coherent daily-run activity trail, all marked as demo data.
    const activities = await listActivities(sql, userId);
    expect(activities).toHaveLength(6);
    expect(activities.every((a) => (a.detail as { seed?: string })?.seed === SEED_MARKER)).toBe(
      true,
    );
    const types = new Set(activities.map((a) => a.type));
    expect(types).toEqual(new Set(["collect", "match", "enrich", "cover_letter"]));
  });

  it("is idempotent: a re-run converges on the same state without duplicating rows", async () => {
    const summary = await seedDemo(sql, userId);
    expect(summary.companies).toBe(4);
    expect(summary.postings).toBe(4);

    // No duplicate demo postings or companies after a second run.
    const postings = await sql<{ n: number }[]>`
      select count(*)::int as n from postings where url like ${`https://${DEMO_URL_HOST}/%`}`;
    expect(postings[0].n).toBe(4);
    const companies = await sql<{ n: number }[]>`
      select count(*)::int as n from companies where name like ${`${DEMO_COMPANY_PREFIX}%`}`;
    expect(companies[0].n).toBe(4);
    const shortlisted = await listCandidacies(sql, userId, { status: "shortlisted" });
    expect(shortlisted).toHaveLength(2);
  });

  it("clears all demo data and leaves nothing behind", async () => {
    const cleared = await clearDemo(sql, userId);
    expect(cleared.postings).toBe(4);
    expect(cleared.companies).toBe(4);
    expect(cleared.proposals).toBe(1);
    expect(cleared.activities).toBe(6);

    expect(await listCandidacies(sql, userId)).toHaveLength(0);
    expect(await listCompanies(sql, userId)).toHaveLength(0);
    expect(await listActivities(sql, userId)).toHaveLength(0);
    const orphanVersions = await sql<{ n: number }[]>`
      select count(*)::int as n from cover_letter_versions where user_id = ${userId}`;
    expect(orphanVersions[0].n).toBe(0);
    const orphanProposals = await sql<{ n: number }[]>`
      select count(*)::int as n from proposals
      where kind = 'cover_letter_version' and plan->>'userId' = ${userId}`;
    expect(orphanProposals[0].n).toBe(0);

    // A clear with nothing to remove is a clean no-op.
    const again = await clearDemo(sql, userId);
    expect(again).toEqual({ proposals: 0, postings: 0, companies: 0, activities: 0 });
  });
});
