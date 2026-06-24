import { createDb, type Db, listCandidacies } from "@archer/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotIntegratedError, type ScrapedPosting } from "./adapters/types.js";
import { runCollect } from "./commands/collect.js";

// Proves the collection orchestration (ARC-8): one `archer collect` run is wrapped
// in a single `activities` row that ends succeeded/failed with a structured detail
// summary; companies/postings upsert idempotently (board+url dedup); candidacies
// fan out one-per-user-per-posting at `new`; and a thrown adapter (NotIntegratedError)
// is a clean `not_integrated` outcome — a succeeded Activity, not a failure (ARC-140).
// Exercised entirely over the `--fixture` boundary (gather thunks) — no live browser.
//
// Like the other DB-backed tests it targets a migrated Postgres. Point
// TEST_DATABASE_URL at it to run:
//   pnpm --filter @archer/cli test (with TEST_DATABASE_URL set)
// Skipped otherwise, so the default no-DB CI vitest run stays green. The orchestration
// is still typechecked in CI, which is what proves there is no contract drift.
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// Two synthetic signups. UUIDs are fixed + namespaced (…008 / …108) so reruns are
// idempotent; the second user proves per-user candidacy fan-out.
const userId = "cccccccc-0000-4000-8000-000000000008";
const userB = "cccccccc-0000-4000-8000-000000000108";

// A deterministic two-posting fixture. URLs share a prefix so cleanup is precise.
const FIXTURE: ScrapedPosting[] = [
  {
    url: "https://cj.test/arc8/a",
    title: "Platform Engineer",
    companyName: "Acme Test Co",
    workMode: "remote",
    location: "Cape Town",
  },
  {
    url: "https://cj.test/arc8/b",
    title: "Senior Backend Engineer",
    companyName: "Beta Test Co",
  },
];

describe.skipIf(!TEST_DB_URL)(
  "ARC-8 — collection orchestration as Activities (fixture-driven)",
  () => {
    let sql: Db;

    const cleanup = async (db: Db) => {
      const users = [userId, userB];
      await db`delete from public.activities where user_id = any(${users})`;
      await db`delete from public.candidacies where user_id = any(${users})`;
      await db`delete from public.postings where url like 'https://cj.test/arc8/%'`;
      await db`delete from public.companies where name in ('Acme Test Co', 'Beta Test Co')`;
      await db`delete from public.users where id = any(${users})`;
      await db`delete from auth.users where id = any(${users})`;
    };

    beforeAll(async () => {
      sql = createDb({ DATABASE_URL: TEST_DB_URL });
      await cleanup(sql);
      // Signup fires on_auth_user_created → public.users for each collecting user.
      await sql`
      insert into auth.users (id, email, raw_user_meta_data) values
        (${userId}, 'collect-a@example.com', ${sql.json({ full_name: "Cole" })}),
        (${userB}, 'collect-b@example.com', ${sql.json({ full_name: "Bea" })})`;
    });

    afterAll(async () => {
      if (!sql) return;
      await cleanup(sql);
      await sql.end();
    });

    it("wraps collect in a succeeded Activity, upserts postings, fans out candidacies", async () => {
      const r = await runCollect(sql, {
        board: "careerjunction",
        userId,
        titles: ["Platform Engineer"],
        fixture: true,
        gather: async () => FIXTURE,
      });
      expect(r.scraped).toBe(2);
      expect(r.postingsNew).toBe(2);
      expect(r.candidaciesNew).toBe(2);
      expect(r.outcome).toBe("found"); // the board surfaced postings today (ARC-141)

      // One activities row, succeeded, carrying the structured detail summary.
      const [act] = await sql<{ status: string; detail: Record<string, unknown> }[]>`
      select status, detail from public.activities where id = ${r.activityId}`;
      expect(act.status).toBe("succeeded");
      expect(act.detail.outcome).toBe("found");
      expect(act.detail.postingsNew).toBe(2);
      expect(act.detail.candidaciesNew).toBe(2);

      // Candidacies created one-per-posting, all at the `new` entry state.
      const cands = await listCandidacies(sql, userId);
      expect(cands).toHaveLength(2);
      expect(cands.every((c) => c.status === "new")).toBe(true);
    });

    it("re-running the same fixture is idempotent — no duplicate postings or candidacies", async () => {
      const r = await runCollect(sql, {
        board: "careerjunction",
        userId,
        titles: ["Platform Engineer"],
        fixture: true,
        gather: async () => FIXTURE,
      });
      expect(r.scraped).toBe(2);
      expect(r.postingsNew).toBe(0);
      expect(r.candidaciesNew).toBe(0);

      const [{ n: postings }] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.postings where url like 'https://cj.test/arc8/%'`;
      expect(postings).toBe(2);
      expect(await listCandidacies(sql, userId)).toHaveLength(2);
    });

    it("fans a candidacy out per user — a second user gets their own, with no new postings", async () => {
      const r = await runCollect(sql, {
        board: "careerjunction",
        userId: userB,
        titles: [],
        fixture: true,
        gather: async () => FIXTURE,
      });
      expect(r.postingsNew).toBe(0); // the postings already exist (board+url dedup)
      expect(r.candidaciesNew).toBe(2); // but candidacies are scoped per user
      expect(await listCandidacies(sql, userB)).toHaveLength(2);
    });

    it("records a clean not_integrated Activity (not a failure) when the adapter is not integrated", async () => {
      const [{ n: failedBefore }] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.activities where user_id = ${userId} and status = 'failed'`;

      // No throw: a not-integrated board is a calm, expected outcome (ARC-140).
      const summary = await runCollect(sql, {
        board: "careerjunction",
        userId,
        titles: [],
        fixture: false,
        gather: async () => {
          throw new NotIntegratedError("careerjunction collect is not integrated");
        },
      });
      expect(summary.outcome).toBe("not_integrated");

      const [activity] = await sql<{ status: string; detail: { outcome?: string } }[]>`
      select status, detail from public.activities
      where user_id = ${userId} and board_slug = 'careerjunction'
      order by started_at desc limit 1`;
      expect(activity.status).toBe("succeeded"); // recorded clean, never failed
      expect(activity.detail.outcome).toBe("not_integrated");

      // And it added no `failed` row — "not integrated" is not failure-noise.
      const [{ n: failedAfter }] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.activities where user_id = ${userId} and status = 'failed'`;
      expect(failedAfter).toBe(failedBefore);
    });

    it("records a clean nothing_today Activity when the board has no postings today (ARC-141)", async () => {
      // The board ran fine but returned zero postings dated today — a clean outcome,
      // never a failure, and distinct from `found`.
      const summary = await runCollect(sql, {
        board: "careerjunction",
        userId,
        titles: ["Platform Engineer"],
        fixture: true,
        gather: async () => [],
      });
      expect(summary.outcome).toBe("nothing_today");
      expect(summary.scraped).toBe(0);

      const [activity] = await sql<{ status: string; detail: { outcome?: string } }[]>`
      select status, detail from public.activities where id = ${summary.activityId}`;
      expect(activity.status).toBe("succeeded"); // a clean run, never failed
      expect(activity.detail.outcome).toBe("nothing_today");
    });

    it("records a failed Activity with an actionable error + detail.outcome (ARC-141)", async () => {
      // A genuine error (login/scrape/proxy) throws, leaving a `failed` Activity that
      // carries both the actionable reason and a queryable `detail.outcome='failed'`.
      await expect(
        runCollect(sql, {
          board: "careerjunction",
          userId,
          titles: ["Platform Engineer"],
          fixture: true,
          gather: async () => {
            throw new Error("login timed out");
          },
        }),
      ).rejects.toThrow("login timed out");

      const [activity] = await sql<
        { status: string; error: string | null; detail: { outcome?: string } }[]
      >`
      select status, error, detail from public.activities
      where user_id = ${userId} and board_slug = 'careerjunction'
      order by started_at desc limit 1`;
      expect(activity.status).toBe("failed");
      expect(activity.error).toBe("login timed out"); // actionable reason
      expect(activity.detail.outcome).toBe("failed"); // distinct, queryable terminal state
    });
  },
);
