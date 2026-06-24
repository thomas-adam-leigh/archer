import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getCompanyDetail, listCompanies } from "./queries.js";

// Integration test for the companies read surface (read-endpoint sub-track):
//   listCompanies() + getCompanyDetail() over public.companies / public.contacts
//   (20260619101500_archer_core.sql). Seeds a few companies (and one's contacts)
//   and asserts the name ordering, the status filter, and the detail join.
//
// Targets the same migrated Postgres as packages/db/scripts/gen-types.sh builds.
// Point TEST_DATABASE_URL at it to run:
//   pnpm --filter @archer/db test (with TEST_DATABASE_URL set)
// Skipped otherwise, so the default no-DB CI vitest run stays green.
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// Fixed, namespaced UUIDs (…046) so reruns are idempotent.
const acme = "aaaaaaaa-0000-4000-8000-000000000046";
const beta = "bbbbbbbb-0000-4000-8000-000000000046";
const ceta = "cccccccc-0000-4000-8000-000000000046";
const contact = "dddddddd-0000-4000-8000-000000000046";

describe.skipIf(!TEST_DB_URL)("companies read surface", () => {
  let sql: postgres.Sql;

  const cleanup = async (db: postgres.Sql) => {
    // contacts cascade from companies (company_id references companies on delete cascade).
    await db`delete from public.companies where id in (${acme}, ${beta}, ${ceta})`;
  };

  beforeAll(async () => {
    sql = postgres(TEST_DB_URL as string, { prepare: false, max: 1 });
    await cleanup(sql);

    // Insert out of name order to prove the query orders by name, not insert order.
    await sql`
      insert into public.companies (id, name, status, domain, website_url, description, recruitment_email, enrichment)
      values
        (${ceta}, 'Ceta', 'new', null, null, null, null, null),
        (${acme}, 'Acme', 'enriched', 'acme.example', 'https://acme.example', 'An enriched company.', 'jobs@acme.example', ${sql.json({ headcount: 120 })}),
        (${beta}, 'Beta', 'researching', null, null, null, null, null)`;

    await sql`
      insert into public.contacts (id, company_id, full_name, email, role_title)
      values (${contact}, ${acme}, 'Dana Recruiter', 'dana@acme.example', 'Talent Lead')`;
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanup(sql);
    await sql.end();
  });

  it("lists companies ordered by name", async () => {
    const rows = await listCompanies(sql);
    const ours = rows.filter((r) => [acme, beta, ceta].includes(r.id));
    expect(ours.map((r) => r.name)).toEqual(["Acme", "Beta", "Ceta"]);
  });

  it("projects the summary columns (no enrichment blob / recruitment email)", async () => {
    const rows = await listCompanies(sql);
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

  it("filters by enrichment status", async () => {
    const rows = await listCompanies(sql, { status: "enriched" });
    expect(rows.filter((r) => [acme, beta, ceta].includes(r.id)).map((r) => r.id)).toEqual([acme]);
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
