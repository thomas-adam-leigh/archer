import { createDb, type Db, listCandidacies } from "@archer/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScrapedPosting } from "./adapters/types.js";
import { runCollect } from "./commands/collect.js";

// Proves the deduplication the owner is relying on (ARC-142). Dedup is already
// enforced by schema constraints (`postings` unique `(board_slug,url)` +
// `(board_slug,external_id)`; `companies` unique `normalized_name`; `candidacies`
// unique `(user_id,posting_id)`; upserts `on conflict`), so this verifies — rather
// than re-implements — the three behaviours, each modelled over the `--fixture`
// boundary as the per-(board × title) fan-out (ARC-139) would drive them:
//
//   1. across titles    — the same job surfaced by two of the five title searches
//                          collapses to ONE posting + one candidacy, while distinct
//                          jobs each create their own.
//   2. company over time — the same company posting again (a new URL, later, even
//                          with different casing/whitespace) reuses its existing
//                          company row rather than spawning a duplicate.
//   3. idempotent re-run — re-collecting an identical fixture adds nothing.
//
// CROSS-BOARD DECISION (the open gap in ARC-142): cross-board `content_hash` dedup
// is **left DEFERRED**. The collect pipeline does not populate `content_hash` today
// (`runCollect` upserts without it), so the same job on two boards is intentionally
// kept as two postings — one per board — exactly as the schema's per-board uniqueness
// implies. The column stays present-but-unused as the future enabler. The last test
// pins this baseline so a future implementer knows what "before" looks like.
//
// Like the other DB-backed tests it targets a migrated Postgres; point
// TEST_DATABASE_URL at it to run, otherwise it skips so the no-DB CI vitest run
// stays green (the orchestration is still typechecked in CI).
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// One synthetic signup, fixed + namespaced (…142) so reruns are idempotent.
const userId = "cccccccc-0000-4000-8000-000000000142";

const URL_PREFIX = "https://dedup.test/arc142/";

describe.skipIf(!TEST_DB_URL)("ARC-142 — dedup verification (fixture-driven)", () => {
  let sql: Db;

  const cleanup = async (db: Db) => {
    await db`delete from public.activities where user_id = ${userId}`;
    await db`delete from public.candidacies where user_id = ${userId}`;
    await db`delete from public.postings where url like ${`${URL_PREFIX}%`}`;
    // Company names may have been rewritten to a differently-cased variant by the
    // upsert's `do update set name`, so clear by the normalized key, not the raw name.
    await db`delete from public.companies where normalized_name like '%arc142%'`;
    await db`delete from public.users where id = ${userId}`;
    await db`delete from auth.users where id = ${userId}`;
  };

  beforeAll(async () => {
    sql = createDb({ DATABASE_URL: TEST_DB_URL });
    await cleanup(sql);
    // Signup fires on_auth_user_created → public.users for the collecting user.
    await sql`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${userId}, 'dedup-142@example.com', ${sql.json({ full_name: "Dee" })})`;
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanup(sql);
    await sql.end();
  });

  it("collapses a job found by two title searches to one posting + one candidacy", async () => {
    const shared: ScrapedPosting = {
      url: `${URL_PREFIX}shared`,
      title: "Platform Engineer",
      companyName: "Globex Arc142",
    };
    const onlyA: ScrapedPosting = {
      url: `${URL_PREFIX}only-a`,
      title: "Platform Engineer",
      companyName: "Initech Arc142",
    };
    const onlyB: ScrapedPosting = {
      url: `${URL_PREFIX}only-b`,
      title: "Cloud Engineer",
      companyName: "Umbrella Arc142",
    };

    // Title search #1 surfaces the shared job + one of its own.
    const r1 = await runCollect(sql, {
      board: "careerjunction",
      userId,
      titles: ["Platform Engineer"],
      fixture: true,
      gather: async () => [shared, onlyA],
    });
    expect(r1.postingsNew).toBe(2);
    expect(r1.candidaciesNew).toBe(2);

    // Title search #2 surfaces the SAME shared job again + one of its own. The shared
    // job is deduped on (board_slug, url); only the genuinely new one is added.
    const r2 = await runCollect(sql, {
      board: "careerjunction",
      userId,
      titles: ["Cloud Engineer"],
      fixture: true,
      gather: async () => [shared, onlyB],
    });
    expect(r2.postingsNew).toBe(1); // only-b; the shared job collapsed
    expect(r2.candidaciesNew).toBe(1);

    // Three distinct jobs across the two searches → three postings, three candidacies.
    const [{ n: postings }] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.postings where url like ${`${URL_PREFIX}%`}`;
    expect(postings).toBe(3);
    expect(await listCandidacies(sql, userId)).toHaveLength(3);

    // The shared job is exactly one posting carrying exactly one candidacy.
    const [{ n: sharedCands }] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.candidacies c
      join public.postings p on p.id = c.posting_id
      where c.user_id = ${userId} and p.url = ${shared.url}`;
    expect(sharedCands).toBe(1);
  });

  it("reuses an existing company row when it posts again later (incl. casing/whitespace)", async () => {
    // First sighting creates the company.
    await runCollect(sql, {
      board: "careerjunction",
      userId,
      titles: ["Platform Engineer"],
      fixture: true,
      gather: async () => [
        { url: `${URL_PREFIX}hooli-1`, title: "Backend Engineer", companyName: "Hooli Arc142" },
      ],
    });

    // A later run from the same company — a new URL, with different casing/whitespace
    // — must attach to the SAME company (normalized_name), not spawn a duplicate.
    await runCollect(sql, {
      board: "careerjunction",
      userId,
      titles: ["Backend Engineer"],
      fixture: true,
      gather: async () => [
        { url: `${URL_PREFIX}hooli-2`, title: "Staff Engineer", companyName: "  hooli arc142  " },
      ],
    });

    const [{ n: companies }] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.companies where normalized_name = 'hooli arc142'`;
    expect(companies).toBe(1);

    // Both postings point at that single company row.
    const ids = await sql<{ company_id: string | null }[]>`
      select company_id from public.postings
      where url in (${`${URL_PREFIX}hooli-1`}, ${`${URL_PREFIX}hooli-2`})`;
    expect(ids).toHaveLength(2);
    expect(ids[0].company_id).not.toBeNull();
    expect(ids[0].company_id).toBe(ids[1].company_id);
  });

  it("is fully idempotent — re-collecting an identical fixture adds nothing", async () => {
    const gather = async (): Promise<ScrapedPosting[]> => [
      { url: `${URL_PREFIX}shared`, title: "Platform Engineer", companyName: "Globex Arc142" },
      { url: `${URL_PREFIX}only-a`, title: "Platform Engineer", companyName: "Initech Arc142" },
    ];
    const before = (await listCandidacies(sql, userId)).length;

    const r = await runCollect(sql, {
      board: "careerjunction",
      userId,
      titles: ["Platform Engineer"],
      fixture: true,
      gather,
    });
    expect(r.postingsNew).toBe(0);
    expect(r.candidaciesNew).toBe(0);
    expect(await listCandidacies(sql, userId)).toHaveLength(before);
  });

  it("keeps the same job on two boards as two postings — cross-board dedup deferred", async () => {
    // content_hash is present in the schema but unpopulated by the collect pipeline,
    // so cross-board merge is intentionally NOT done (ARC-142 decision: deferred).
    // The same role collected on two boards stays as one posting per board.
    await runCollect(sql, {
      board: "careerjunction",
      userId,
      titles: ["Platform Engineer"],
      fixture: true,
      gather: async () => [
        { url: `${URL_PREFIX}xboard-cj`, title: "Platform Engineer", companyName: "Globex Arc142" },
      ],
    });
    await runCollect(sql, {
      board: "careerjet",
      userId,
      titles: ["Platform Engineer"],
      fixture: true,
      gather: async () => [
        {
          url: `${URL_PREFIX}xboard-cjet`,
          title: "Platform Engineer",
          companyName: "Globex Arc142",
        },
      ],
    });

    const rows = await sql<{ board_slug: string; content_hash: string | null }[]>`
      select board_slug, content_hash from public.postings
      where url in (${`${URL_PREFIX}xboard-cj`}, ${`${URL_PREFIX}xboard-cjet`})
      order by board_slug`;
    expect(rows.map((r) => r.board_slug)).toEqual(["careerjet", "careerjunction"]);
    // The deferral is concrete: content_hash is never written, so nothing to merge on.
    expect(rows.every((r) => r.content_hash === null)).toBe(true);
  });
});
