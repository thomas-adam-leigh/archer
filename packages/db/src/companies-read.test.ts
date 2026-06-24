import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getCompanyDetail, listCompanies, userOwnsCompany } from "./queries.js";

// Integration test for the companies read surface (ARC-144):
//   listCompanies() + getCompanyDetail() + userOwnsCompany() over public.companies /
//   public.contacts / public.postings / public.candidacies (20260619* core). The
//   list is RLS own-rows-only: a company is the user's only if they hold a candidacy
//   at it. Seeds three companies the user has candidacies with (acme/beta/ceta) and
//   one another user owns (delta), then asserts the name ordering, the status filter,
//   the detail join, and that delta never leaks into our user's list / ownership.
//
// Targets the same migrated Postgres as packages/db/scripts/gen-types.sh builds.
// Point TEST_DATABASE_URL at it to run:
//   pnpm --filter @archer/db test (with TEST_DATABASE_URL set)
// Skipped otherwise, so the default no-DB CI vitest run stays green.
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// Fixed, namespaced UUIDs (…046) so reruns are idempotent.
const userId = "cccccccc-0000-4000-8000-000000000046";
const otherUser = "eeeeeeee-0000-4000-8000-000000000046";
const acme = "aaaaaaaa-0000-4000-8000-000000000046";
const beta = "bbbbbbbb-0000-4000-8000-000000000046";
const ceta = "11111111-0000-4000-8000-000000000046";
const delta = "22222222-0000-4000-8000-000000000046";
const contact = "dddddddd-0000-4000-8000-000000000046";
const boardSlug = "test-board-144";

describe.skipIf(!TEST_DB_URL)("companies read surface (ARC-144)", () => {
  let sql: postgres.Sql;

  const cleanup = async (db: postgres.Sql) => {
    // users cascade to candidacies; postings hang off the board (and reference the
    // companies), so drop candidacies' users, then postings, then board, then the
    // companies (contacts cascade from companies on delete).
    await db`delete from public.users where id in (${userId}, ${otherUser})`;
    await db`delete from auth.users where id in (${userId}, ${otherUser})`;
    await db`delete from public.postings where board_slug = ${boardSlug}`;
    await db`delete from public.boards where slug = ${boardSlug}`;
    await db`delete from public.companies where id in (${acme}, ${beta}, ${ceta}, ${delta})`;
  };

  // Create a posting at `companyId` and a candidacy on it for `forUser`.
  const candidacyAt = async (db: postgres.Sql, companyId: string, forUser: string, url: string) => {
    const posting = await db<{ id: string }[]>`
      insert into public.postings (board_slug, url, title, company_id)
      values (${boardSlug}, ${url}, 'Staff Engineer', ${companyId})
      returning id`;
    await db`
      insert into public.candidacies (user_id, posting_id, status)
      values (${forUser}, ${posting[0].id}, 'new')`;
  };

  beforeAll(async () => {
    sql = postgres(TEST_DB_URL as string, { prepare: false, max: 1 });
    await cleanup(sql);

    await sql`
      insert into auth.users (id, email, raw_user_meta_data)
      values
        (${userId}, 'companies144@example.com', ${sql.json({ full_name: "Cleo" })}),
        (${otherUser}, 'other144@example.com', ${sql.json({ full_name: "Otto" })})`;
    await sql`
      insert into public.boards (slug, name, base_url, cred_env_prefix)
      values (${boardSlug}, 'Test Board', 'https://example.test', 'TEST_BOARD_144')`;

    // Insert out of name order to prove the query orders by name, not insert order.
    await sql`
      insert into public.companies (id, name, status, domain, website_url, description, recruitment_email, enrichment)
      values
        (${ceta}, 'Ceta', 'new', null, null, null, null, null),
        (${acme}, 'Acme', 'enriched', 'acme.example', 'https://acme.example', 'An enriched company.', 'jobs@acme.example', ${sql.json({ headcount: 120 })}),
        (${beta}, 'Beta', 'researching', null, null, null, null, null),
        (${delta}, 'Delta', 'enriched', null, null, null, null, null)`;

    await sql`
      insert into public.contacts (id, company_id, full_name, email, role_title)
      values (${contact}, ${acme}, 'Dana Recruiter', 'dana@acme.example', 'Talent Lead')`;

    // Our user has candidacies at acme/beta/ceta; delta belongs to another user.
    await candidacyAt(sql, acme, userId, "https://example.test/job/acme");
    await candidacyAt(sql, beta, userId, "https://example.test/job/beta");
    await candidacyAt(sql, ceta, userId, "https://example.test/job/ceta");
    await candidacyAt(sql, delta, otherUser, "https://example.test/job/delta");
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanup(sql);
    await sql.end();
  });

  it("lists the user's companies ordered by name", async () => {
    const rows = await listCompanies(sql, userId);
    const ours = rows.filter((r) => [acme, beta, ceta, delta].includes(r.id));
    expect(ours.map((r) => r.name)).toEqual(["Acme", "Beta", "Ceta"]);
  });

  it("never surfaces a company the user has no candidacy with (own-rows-only)", async () => {
    const rows = await listCompanies(sql, userId);
    expect(rows.some((r) => r.id === delta)).toBe(false);
    // ...and it is the other user's, who does see it.
    const theirs = await listCompanies(sql, otherUser);
    expect(theirs.some((r) => r.id === delta)).toBe(true);
    expect(theirs.some((r) => r.id === acme)).toBe(false);
  });

  it("projects the summary columns (no enrichment blob / recruitment email)", async () => {
    const rows = await listCompanies(sql, userId);
    const a = rows.find((r) => r.id === acme);
    expect(a).toEqual({
      id: acme,
      name: "Acme",
      status: "enriched",
      domain: "acme.example",
      website_url: "https://acme.example",
      description: "An enriched company.",
      // postgres.js hydrates timestamptz to a Date at the DB layer; the API's
      // JSON encoder stringifies it on the wire (see the route test).
      created_at: expect.any(Date),
    });
  });

  it("filters the user's companies by enrichment status", async () => {
    const rows = await listCompanies(sql, userId, { status: "enriched" });
    expect(rows.filter((r) => [acme, beta, ceta, delta].includes(r.id)).map((r) => r.id)).toEqual([
      acme,
    ]);
  });

  it("userOwnsCompany is true for a company the user has a candidacy with, false otherwise", async () => {
    expect(await userOwnsCompany(sql, userId, acme)).toBe(true);
    expect(await userOwnsCompany(sql, userId, delta)).toBe(false);
    expect(await userOwnsCompany(sql, otherUser, acme)).toBe(false);
  });

  it("returns one company's full detail with its contacts", async () => {
    const got = await getCompanyDetail(sql, acme);
    expect(got).toMatchObject({
      id: acme,
      name: "Acme",
      status: "enriched",
      recruitment_email: "jobs@acme.example",
      enrichment: { headcount: 120 },
    });
    expect(got?.contacts).toEqual([
      {
        id: contact,
        full_name: "Dana Recruiter",
        email: "dana@acme.example",
        linkedin_url: null,
        role_title: "Talent Lead",
        notes: null,
      },
    ]);
  });

  it("returns an empty contacts array for a company with none", async () => {
    const got = await getCompanyDetail(sql, beta);
    expect(got?.contacts).toEqual([]);
  });

  it("returns undefined for an unknown company", async () => {
    expect(await getCompanyDetail(sql, "00000000-0000-4000-8000-000000000000")).toBeUndefined();
  });
});
