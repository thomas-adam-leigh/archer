import {
  addNegativeCriterion,
  addTargetTitle,
  createDb,
  type Db,
  getCandidacy,
  insertCandidacy,
  listNewCandidacies,
  upsertCompany,
  upsertPosting,
} from "@archer/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Judge, type MatchProfile, runMatch, stubJudge } from "./commands/match.js";

// Proves the Matchmaker triage (ARC-9): a `match` Activity processes every `new`
// candidacy against the user's target titles + negative criteria, setting status +
// triage_decision + triage_reason + match_score; transitions are valid and idempotent
// (decided rows are never re-triaged); and the LLM judgment is a mockable seam.
//
// The deterministic `stubJudge` logic is pure, so its tests run in the default no-DB
// CI vitest pass. The end-to-end run is DB-backed: point TEST_DATABASE_URL at a
// migrated Postgres to exercise it (skipped otherwise, keeping CI green).

const PROFILE: MatchProfile = {
  titles: ["Platform Engineer"],
  negativeCriteria: ["recruitment agency"],
  about: null,
  willingRemote: true,
  workPref: "remote",
};

describe("stubJudge — deterministic Matchmaker stand-in", () => {
  it("shortlists a posting whose title matches a target title", () => {
    const v = stubJudge(
      {
        title: "Senior Platform Engineer",
        companyName: "Acme",
        location: null,
        workMode: "remote",
        description: null,
      },
      PROFILE,
    );
    expect(v.decision).toBe("shortlisted");
    expect(v.score).toBe(85);
    expect(v.reason).toContain("Platform Engineer");
  });

  it("dismisses on a negative-criterion keyword, naming the deal-breaker", () => {
    const v = stubJudge(
      {
        title: "Backend Engineer",
        companyName: "Hire Co",
        location: null,
        workMode: "remote",
        description: "via a recruitment agency",
      },
      PROFILE,
    );
    expect(v.decision).toBe("dismissed");
    expect(v.score).toBe(10);
    expect(v.reason).toContain("recruitment agency");
  });

  it("falls back to alternative_outreach when nothing matches", () => {
    const v = stubJudge(
      {
        title: "Data Scientist",
        companyName: "Beta",
        location: null,
        workMode: "office",
        description: "ML role",
      },
      PROFILE,
    );
    expect(v.decision).toBe("alternative_outreach");
    expect(v.score).toBe(50);
  });

  it("lets a negative criterion override a title match", () => {
    const v = stubJudge(
      {
        title: "Platform Engineer",
        companyName: "X",
        location: null,
        workMode: "remote",
        description: "placed through a recruitment agency",
      },
      PROFILE,
    );
    expect(v.decision).toBe("dismissed");
  });
});

const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// Fixed, namespaced UUIDs so reruns are idempotent (…009 triages, …109 stays empty).
const userId = "cccccccc-0000-4000-8000-000000000009";
const emptyUser = "cccccccc-0000-4000-8000-000000000109";

describe.skipIf(!TEST_DB_URL)("ARC-9 — Matchmaker triage to candidacies (mockable)", () => {
  let sql: Db;

  const cleanup = async (db: Db) => {
    const users = [userId, emptyUser];
    await db`delete from public.activities where user_id = any(${users})`;
    await db`delete from public.candidacies where user_id = any(${users})`;
    await db`delete from public.postings where url like 'https://cj.test/arc9/%'`;
    await db`delete from public.companies where name in ('Acme Arc9', 'Agency Arc9', 'Beta Arc9')`;
    await db`delete from public.negative_criteria where user_id = any(${users})`;
    await db`delete from public.target_titles where user_id = any(${users})`;
    await db`delete from public.profiles where user_id = any(${users})`;
    await db`delete from public.users where id = any(${users})`;
    await db`delete from auth.users where id = any(${users})`;
  };

  // Seed three `new` candidacies for `userId` that drive one of each stub verdict.
  const seedCandidacies = async (db: Db): Promise<void> => {
    const postings = [
      {
        url: "https://cj.test/arc9/a",
        title: "Senior Platform Engineer",
        company: "Acme Arc9",
        desc: "platform team",
      },
      {
        url: "https://cj.test/arc9/b",
        title: "Recruiter",
        company: "Agency Arc9",
        desc: "join our recruitment agency",
      },
      {
        url: "https://cj.test/arc9/c",
        title: "Data Scientist",
        company: "Beta Arc9",
        desc: "ML role",
      },
    ];
    for (const p of postings) {
      const companyId = await upsertCompany(db, p.company);
      const posting = await upsertPosting(db, {
        boardSlug: "careerjunction",
        url: p.url,
        title: p.title,
        companyId,
        description: p.desc,
      });
      await insertCandidacy(db, userId, posting.id);
    }
  };

  beforeAll(async () => {
    sql = createDb({ DATABASE_URL: TEST_DB_URL });
    await cleanup(sql);
    await sql`
      insert into auth.users (id, email, raw_user_meta_data) values
        (${userId}, 'match-a@example.com', ${sql.json({ full_name: "Mat" })}),
        (${emptyUser}, 'match-empty@example.com', ${sql.json({ full_name: "Emi" })})`;
    await addTargetTitle(sql, userId, "Platform Engineer");
    await addNegativeCriterion(sql, userId, "recruitment agency");
    await seedCandidacies(sql);
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanup(sql);
    await sql.end();
  });

  it("triages every new candidacy and records a succeeded match Activity", async () => {
    const ids = (await listNewCandidacies(sql, userId)).map((c) => c.id);
    expect(ids).toHaveLength(3);

    const summary = await runMatch(sql, { userId });
    expect(summary).toMatchObject({
      processed: 3,
      shortlisted: 1,
      alternative_outreach: 1,
      dismissed: 1,
    });
    expect(summary.activityId).not.toBeNull();

    const [act] = await sql<{ type: string; status: string; detail: Record<string, unknown> }[]>`
      select type, status, detail from public.activities where id = ${summary.activityId}`;
    expect(act.type).toBe("match");
    expect(act.status).toBe("succeeded");
    expect(act.detail.processed).toBe(3);

    // Every triaged candidacy carries status + decision + reason + score.
    for (const id of ids) {
      const c = await getCandidacy(sql, id);
      expect(c).toBeDefined();
      expect(c?.status).not.toBe("new");
      expect(c?.triage_decision).toBe(c?.status);
      expect(c?.triage_reason).toBeTruthy();
      expect(typeof c?.match_score).toBe("number");
    }
    // No `new` candidacies remain.
    expect(await listNewCandidacies(sql, userId)).toHaveLength(0);
  });

  it("is idempotent — a re-run triages nothing and opens no Activity", async () => {
    const [{ n: before }] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.activities where user_id = ${userId} and type = 'match'`;

    const summary = await runMatch(sql, { userId });
    expect(summary.processed).toBe(0);
    expect(summary.activityId).toBeNull();

    const [{ n: after }] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.activities where user_id = ${userId} and type = 'match'`;
    expect(after).toBe(before);
  });

  it("is a no-op for a user with no new candidacies (no Activity opened)", async () => {
    const summary = await runMatch(sql, { userId: emptyUser });
    expect(summary).toEqual({
      processed: 0,
      shortlisted: 0,
      alternative_outreach: 0,
      dismissed: 0,
      activityId: null,
    });
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.activities where user_id = ${emptyUser}`;
    expect(n).toBe(0);
  });

  it("uses an injected judge — the LLM call is a mockable seam", async () => {
    // Re-seed `userId` with one fresh candidacy, then triage it with a custom judge.
    const companyId = await upsertCompany(sql, "Acme Arc9");
    const posting = await upsertPosting(sql, {
      boardSlug: "careerjunction",
      url: "https://cj.test/arc9/mock",
      title: "Anything",
      companyId,
      description: "x",
    });
    await insertCandidacy(sql, userId, posting.id);

    const judge: Judge = () => ({ decision: "shortlisted", score: 99, reason: "mock said so" });
    const summary = await runMatch(sql, { userId, judge });
    expect(summary.shortlisted).toBe(1);

    const [c] = await sql<{ triage_reason: string; match_score: number }[]>`
      select triage_reason, match_score from public.candidacies
      where user_id = ${userId} and posting_id = ${posting.id}`;
    expect(c.triage_reason).toBe("mock said so");
    expect(c.match_score).toBe(99);
  });
});
