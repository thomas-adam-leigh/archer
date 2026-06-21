import {
  addNegativeCriterion,
  addTargetTitle,
  createDb,
  type Db,
  getCandidacy,
  getCompany,
  listCandidacies,
} from "@archer/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScrapedPosting } from "./adapters/types.js";
import { runCollect } from "./commands/collect.js";
import { runEnrich } from "./commands/enrich.js";
import { runMatch } from "./commands/match.js";

// ARC-36 — locks the whole Researcher slice end to end over the fixture/stubbed
// boundary: one test that chains a real collect → match → enrich run (no live
// browser, no live LLM, no live MCP) and proves the hand-off the Applications &
// Cover Letters project depends on:
//   • the shortlist that gates enrichment is the SAME shortlist the Matchmaker
//     produces (collect → match → a `shortlisted` candidacy behind a company),
//   • enriching that company walks it new → researching → enriched and advances
//     its shortlisted candidacy → awaiting_cover_letter, notifying the owner,
//   • the enrich run is idempotent (a re-run is a no-op that advances none),
//   • a company sitting behind only a `dismissed` candidacy is refused by the
//     gate — no wasted research on never-shortlisted companies.
//
// This is the enrich counterpart to collect-match-e2e (ARC-12): the unit-level
// pieces are covered by enrich.test.ts, here we drive the whole stage as one flow.
// DB-backed like the per-issue tests: point TEST_DATABASE_URL at a migrated
// Postgres to run it; skipped otherwise so the default no-DB CI vitest stays green.
// The orchestration is still typechecked in CI, which proves there is no drift.
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// Fixed, namespaced UUID so reruns are idempotent.
const user = "cccccccc-0000-4000-8000-000000000036";

// The same deterministic three-posting shape collect-match-e2e drives, namespaced
// to arc36, for a user targeting "Platform Engineer" with "recruitment agency" as a
// deal-breaker: a → shortlisted (title match), b → dismissed (negative keyword),
// c → alternative_outreach.
const FIXTURE: ScrapedPosting[] = [
  {
    url: "https://cj.test/arc36/a",
    title: "Senior Platform Engineer",
    companyName: "Acme Arc36",
    workMode: "remote",
    location: "Cape Town",
    description: "join the platform team",
  },
  {
    url: "https://cj.test/arc36/b",
    title: "Recruiter",
    companyName: "Agency Arc36",
    description: "join our recruitment agency placing engineers",
  },
  {
    url: "https://cj.test/arc36/c",
    title: "Data Scientist",
    companyName: "Beta Arc36",
    description: "ML role",
  },
];

const COMPANIES = ["Acme Arc36", "Agency Arc36", "Beta Arc36"];

describe.skipIf(!TEST_DB_URL)("ARC-36 — collect→match→enrich slice (end-to-end)", () => {
  let sql: Db;

  // Resolve a company's id by the name the fixture collected it under.
  const companyId = async (db: Db, name: string): Promise<string> => {
    const [row] = await db<{ id: string }[]>`select id from public.companies where name = ${name}`;
    return row.id;
  };

  const cleanup = async (db: Db) => {
    await db`delete from public.notifications where user_id = ${user}`;
    await db`delete from public.activities where user_id = ${user}`;
    await db`
      delete from public.activities
      where company_id in (select id from public.companies where name = any(${COMPANIES}))`;
    await db`
      delete from public.contacts
      where company_id in (select id from public.companies where name = any(${COMPANIES}))`;
    await db`delete from public.candidacies where user_id = ${user}`;
    await db`delete from public.postings where url like 'https://cj.test/arc36/%'`;
    await db`delete from public.companies where name = any(${COMPANIES})`;
    await db`delete from public.negative_criteria where user_id = ${user}`;
    await db`delete from public.target_titles where user_id = ${user}`;
    await db`delete from public.profiles where user_id = ${user}`;
    await db`delete from public.users where id = ${user}`;
    await db`delete from auth.users where id = ${user}`;
  };

  beforeAll(async () => {
    sql = createDb({ DATABASE_URL: TEST_DB_URL });
    await cleanup(sql);
    // Signup fires on_auth_user_created → public.users (the candidacy FK target).
    await sql`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${user}, 'arc36@example.com', ${sql.json({ full_name: "Arc36" })})`;
    // The match key: a target title + a deal-breaker (drives one of each verdict).
    await addTargetTitle(sql, user, "Platform Engineer");
    await addNegativeCriterion(sql, user, "recruitment agency");
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanup(sql);
    await sql.end();
  });

  it("collects → matches a shortlist → enriches that company → advances it to awaiting_cover_letter", async () => {
    // Collect: three postings + three `new` candidacies.
    const collected = await runCollect(sql, {
      board: "careerjunction",
      userId: user,
      titles: ["Platform Engineer"],
      fixture: true,
      gather: async () => FIXTURE,
    });
    expect(collected).toMatchObject({ scraped: 3, postingsNew: 3, candidaciesNew: 3 });

    // Match: one of each verdict — the shortlist that gates enrichment.
    const matched = await runMatch(sql, { userId: user });
    expect(matched).toMatchObject({ shortlisted: 1, alternative_outreach: 1, dismissed: 1 });

    // The shortlisted candidacy the Matchmaker produced sits behind "Acme Arc36".
    const shortlisted = await listCandidacies(sql, user, { status: "shortlisted" });
    expect(shortlisted).toHaveLength(1);
    const candidacyId = shortlisted[0].id;
    expect(shortlisted[0].company_name).toBe("Acme Arc36");

    // The company starts `new` (collect created it; nothing has enriched it yet).
    const acmeId = await companyId(sql, "Acme Arc36");
    expect((await getCompany(sql, acmeId))?.status).toBe("new");

    // Enrich the shortlisted company over the stub (no live MCP). It walks to
    // `enriched`, writes contacts, and advances its shortlisted candidacy.
    const summary = await runEnrich(sql, { companyId: acmeId });
    expect(summary).toMatchObject({
      status: "enriched",
      skipped: false,
      contactsFound: 1,
      candidaciesAdvanced: 1,
    });
    expect(summary.activityId).not.toBeNull();

    // The candidacy crossed the hand-off into Applications & Cover Letters.
    expect((await getCandidacy(sql, candidacyId))?.status).toBe("awaiting_cover_letter");
    const awaiting = await listCandidacies(sql, user, { status: "awaiting_cover_letter" });
    expect(awaiting.map((j) => j.posting_title)).toContain("Senior Platform Engineer");

    // The owner was notified exactly once for this candidacy.
    const [{ n: notes }] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.notifications
      where user_id = ${user} and ref->>'candidacyId' = ${candidacyId}`;
    expect(notes).toBe(1);

    // The run is recorded as one succeeded `enrich` Activity on the company.
    const [act] = await sql<{ type: string; status: string; company_id: string }[]>`
      select type, status, company_id from public.activities where id = ${summary.activityId}`;
    expect(act).toMatchObject({ type: "enrich", status: "succeeded", company_id: acmeId });

    // Idempotent: re-running an enriched company is a no-op (no Activity, advances none).
    const rerun = await runEnrich(sql, { companyId: acmeId });
    expect(rerun).toMatchObject({ skipped: true, candidaciesAdvanced: 0 });
    expect(rerun.activityId).toBeNull();
    const [{ n: stillOne }] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.notifications where user_id = ${user}`;
    expect(stillOne).toBe(1);
  });

  it("refuses to enrich a company behind only a dismissed candidacy (gate — no wasted research)", async () => {
    // "Agency Arc36" was dismissed by the Matchmaker (negative keyword), so the
    // shortlist gate must refuse it: fail-closed, no status change, no Activity.
    const agencyId = await companyId(sql, "Agency Arc36");
    await expect(runEnrich(sql, { companyId: agencyId })).rejects.toThrow(
      /gated to shortlisted companies/,
    );
    expect((await getCompany(sql, agencyId))?.status).toBe("new");
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.activities
      where company_id = ${agencyId} and type = 'enrich'`;
    expect(n).toBe(0);
  });
});
