import {
  addNegativeCriterion,
  addTargetTitle,
  createDb,
  type Db,
  getBoard,
  listCandidacies,
  listNewCandidacies,
  setBoardStatus,
} from "@archer/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScrapedPosting } from "./adapters/types.js";
import { runCollect } from "./commands/collect.js";
import { runMatch } from "./commands/match.js";

// ARC-12 — locks the whole collection→match→feed slice end to end over the
// fixture/stubbed boundary: one test that chains a real collect → match → feed run
// (no live browser, no live LLM) and proves the contracts the live UI and the
// self-heal Mechanic depend on:
//   • fixture collect + idempotent re-run + per-user candidacy fan-out,
//   • a full Matchmaker pass (one of each verdict) + an idempotent no-op re-run,
//   • the RLS-scoped jobs feed (own-rows-only — one user never sees another's),
//   • the board broken→recover lifecycle driven by live-run outcomes,
//   • a failed Activity + the activity-failed webhook trigger that signals it.
//
// DB-backed like the per-issue tests: point TEST_DATABASE_URL at a migrated
// Postgres to run it; skipped otherwise so the default no-DB CI vitest stays green.
// The orchestration is still typechecked in CI, which proves there is no drift.
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// Fixed, namespaced UUIDs (…012 / …112) so reruns are idempotent; userB proves
// the feed is scoped per user.
const userA = "cccccccc-0000-4000-8000-000000000012";
const userB = "cccccccc-0000-4000-8000-000000000112";

// A deterministic three-posting fixture that drives one of each stub verdict for a
// user targeting "Platform Engineer" with "recruitment agency" as a deal-breaker:
//   a → shortlisted (title match), b → dismissed (negative keyword), c → alternative.
const FIXTURE: ScrapedPosting[] = [
  {
    url: "https://cj.test/arc12/a",
    title: "Senior Platform Engineer",
    companyName: "Acme Arc12",
    workMode: "remote",
    location: "Cape Town",
    description: "join the platform team",
  },
  {
    url: "https://cj.test/arc12/b",
    title: "Recruiter",
    companyName: "Agency Arc12",
    description: "join our recruitment agency placing engineers",
  },
  {
    url: "https://cj.test/arc12/c",
    title: "Data Scientist",
    companyName: "Beta Arc12",
    description: "ML role",
  },
];

describe.skipIf(!TEST_DB_URL)("ARC-12 — collect→match→feed slice (end-to-end)", () => {
  let sql: Db;

  const cleanup = async (db: Db) => {
    const users = [userA, userB];
    await db`delete from public.activities where user_id = any(${users})`;
    await db`delete from public.candidacies where user_id = any(${users})`;
    await db`delete from public.postings where url like 'https://cj.test/arc12/%'`;
    await db`delete from public.companies where name in ('Acme Arc12', 'Agency Arc12', 'Beta Arc12')`;
    await db`delete from public.negative_criteria where user_id = any(${users})`;
    await db`delete from public.target_titles where user_id = any(${users})`;
    await db`delete from public.profiles where user_id = any(${users})`;
    await db`delete from public.users where id = any(${users})`;
    await db`delete from auth.users where id = any(${users})`;
    // Restore the live board this test drives through its lifecycle (shared row).
    await db`update public.boards set collect_status = 'not_integrated' where slug = 'careerjet'`;
  };

  beforeAll(async () => {
    sql = createDb({ DATABASE_URL: TEST_DB_URL });
    await cleanup(sql);
    // Signup fires on_auth_user_created → public.users for each user.
    await sql`
      insert into auth.users (id, email, raw_user_meta_data) values
        (${userA}, 'e2e-a@example.com', ${sql.json({ full_name: "Ana" })}),
        (${userB}, 'e2e-b@example.com', ${sql.json({ full_name: "Ben" })})`;
    // userA's match key: a target title + a deal-breaker. userB stays empty so the
    // feed-isolation check has a user whose rows must never leak into userA's.
    await addTargetTitle(sql, userA, "Platform Engineer");
    await addNegativeCriterion(sql, userA, "recruitment agency");
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanup(sql);
    await sql.end();
  });

  it("collects (idempotently), triages every new candidacy, and surfaces them on the feed", async () => {
    // Collect: three postings + three `new` candidacies for userA, one Activity.
    const c1 = await runCollect(sql, {
      board: "careerjunction",
      userId: userA,
      titles: ["Platform Engineer"],
      fixture: true,
      gather: async () => FIXTURE,
    });
    expect(c1).toMatchObject({ scraped: 3, postingsNew: 3, candidaciesNew: 3 });
    const [collectAct] = await sql<{ status: string; detail: Record<string, unknown> }[]>`
      select status, detail from public.activities where id = ${c1.activityId}`;
    expect(collectAct.status).toBe("succeeded");
    expect(collectAct.detail.candidaciesNew).toBe(3);

    // Re-running the same fixture is idempotent: no duplicate postings/candidacies.
    const c2 = await runCollect(sql, {
      board: "careerjunction",
      userId: userA,
      titles: ["Platform Engineer"],
      fixture: true,
      gather: async () => FIXTURE,
    });
    expect(c2).toMatchObject({ postingsNew: 0, candidaciesNew: 0 });
    expect(await listNewCandidacies(sql, userA)).toHaveLength(3);

    // Fan-out: a second user collecting the same postings gets their OWN candidacies
    // with no new postings (board+url dedup is global, candidacies are per user).
    const cB = await runCollect(sql, {
      board: "careerjunction",
      userId: userB,
      titles: [],
      fixture: true,
      gather: async () => FIXTURE,
    });
    expect(cB).toMatchObject({ postingsNew: 0, candidaciesNew: 3 });

    // Match: a full Matchmaker pass over userA's three `new` candidacies — one of
    // each verdict — recorded as one succeeded `match` Activity.
    const m = await runMatch(sql, { userId: userA });
    expect(m).toMatchObject({
      processed: 3,
      shortlisted: 1,
      alternative_outreach: 1,
      dismissed: 1,
    });
    expect(m.activityId).not.toBeNull();
    const [matchAct] = await sql<{ type: string; status: string }[]>`
      select type, status from public.activities where id = ${m.activityId}`;
    expect(matchAct).toMatchObject({ type: "match", status: "succeeded" });

    // Feed: every candidacy now carries a decision + score and is off `new`.
    const feed = await listCandidacies(sql, userA);
    expect(feed).toHaveLength(3);
    expect(feed.every((j) => j.status !== "new")).toBe(true);
    expect(feed.every((j) => j.triage_decision === j.status)).toBe(true);
    expect(feed.every((j) => typeof j.match_score === "number")).toBe(true);
    // Filterable by status — the kanban's shortlisted column.
    const shortlisted = await listCandidacies(sql, userA, { status: "shortlisted" });
    expect(shortlisted).toHaveLength(1);
    expect(shortlisted[0]?.posting_title).toBe("Senior Platform Engineer");

    // Match is idempotent: a re-run triages nothing and opens no Activity.
    const m2 = await runMatch(sql, { userId: userA });
    expect(m2.processed).toBe(0);
    expect(m2.activityId).toBeNull();
  });

  it("scopes the jobs feed per user — one user never sees another's candidacies (RLS own-rows)", async () => {
    const feedA = await listCandidacies(sql, userA);
    const feedB = await listCandidacies(sql, userB);
    // Both users have three rows over the same postings, but disjoint candidacy ids.
    expect(feedA).toHaveLength(3);
    expect(feedB).toHaveLength(3);
    const idsA = new Set(feedA.map((j) => j.id));
    expect(feedB.some((j) => idsA.has(j.id))).toBe(false);
    // userB was never matched, so their rows are still `new` — userA's triaged
    // shortlist has not bled across the user boundary.
    expect(feedB.every((j) => j.status === "new")).toBe(true);
  });

  it("drives the board lifecycle from live-run outcomes: a failure breaks it, a clean run restores it", async () => {
    // A live (non-fixture) collect reconciles boards.collect_status to its outcome.
    await setBoardStatus(sql, "careerjet", { collect: "integrated" });

    // A genuine failed live run (login/scrape/proxy error) breaks an integrated
    // board. (A NotIntegratedError would NOT — that's a clean outcome now, ARC-140.)
    await expect(
      runCollect(sql, {
        board: "careerjet",
        userId: userA,
        titles: [],
        fixture: false,
        gather: async () => {
          throw new Error("careerjet scrape blew up");
        },
      }),
    ).rejects.toThrow("careerjet scrape blew up");
    expect((await getBoard(sql, "careerjet"))?.collect_status).toBe("broken");

    // A clean live run proves the adapter healthy again → restores integrated.
    await runCollect(sql, {
      board: "careerjet",
      userId: userA,
      titles: [],
      fixture: false,
      gather: async (): Promise<ScrapedPosting[]> => [
        { url: "https://cj.test/arc12/cj", title: "Backend Engineer", companyName: "Acme Arc12" },
      ],
    });
    expect((await getBoard(sql, "careerjet"))?.collect_status).toBe("integrated");
  });

  it("records a failed Activity and the activity-failed webhook that signals the Mechanic is wired", async () => {
    const [{ n: before }] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.activities where user_id = ${userA} and status = 'failed'`;

    await expect(
      runCollect(sql, {
        board: "careerjet",
        userId: userA,
        titles: [],
        fixture: false,
        gather: async () => {
          throw new Error("scrape blew up");
        },
      }),
    ).rejects.toThrow("scrape blew up");

    // The failed run left a `failed` Activity carrying the error — the row the
    // status-change trigger reacts to.
    const [failed] = await sql<{ status: string; error: string }[]>`
      select status, error from public.activities
      where user_id = ${userA} and status = 'failed'
      order by started_at desc limit 1`;
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("scrape blew up");
    const [{ n: after }] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.activities where user_id = ${userA} and status = 'failed'`;
    expect(after).toBe(before + 1);

    // The signal itself: the activity-failed webhook trigger (ARC-7 event engine)
    // is installed on public.activities, so a transition into `failed` POSTs the
    // Hono API's /hooks/activity-failed — what wakes the self-heal Mechanic.
    const [{ n: triggers }] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_trigger
      where tgname = 'activity_failed_webhook' and not tgisinternal`;
    expect(triggers).toBe(1);
  });
});
