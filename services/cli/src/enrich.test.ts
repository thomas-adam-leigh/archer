import { createDb, type Db, getCompany, upsertCompany } from "@archer/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotIntegratedError } from "./adapters/types.js";
import { type Enricher, runEnrich, stubEnricher } from "./commands/enrich.js";

// Proves the enrich-as-Activity orchestration (ARC-13): one `archer enrich` run is
// wrapped in a single `enrich` Activity that ends succeeded/failed; the company walks
// new → researching → enriched | enrichment_failed; the (stubbed) LinkedIn/Firecrawl
// tools are a swappable seam; an already-enriched company is an idempotent no-op (no
// Activity); and a thrown tool leaves a failed Activity + enrichment_failed behind.
//
// The deterministic `stubEnricher` is pure, so its tests run in the default no-DB CI
// vitest pass. The end-to-end run is DB-backed: point TEST_DATABASE_URL at a migrated
// Postgres to exercise it (skipped otherwise, keeping CI green). The orchestration is
// still typechecked in CI, which is what proves there is no contract drift.

describe("stubEnricher — deterministic Researcher stand-in", () => {
  const ctx = (over: Partial<{ domain: string | null; websiteUrl: string | null }> = {}) => ({
    company: { id: "x", name: "Acme Corp", domain: null, websiteUrl: null, ...over },
    log: () => {},
  });

  it("derives a domain, website, and recruitment email from the company name", async () => {
    const r = await stubEnricher(ctx());
    expect(r.domain).toBe("acme-corp.example.com");
    expect(r.websiteUrl).toBe("https://acme-corp.example.com");
    expect(r.recruitmentEmail).toBe("careers@acme-corp.example.com");
    expect(r.contacts).toHaveLength(1);
    expect(r.contacts[0].roleTitle).toBe("Talent Acquisition");
  });

  it("prefers the company's existing domain + website when present", async () => {
    const r = await stubEnricher(ctx({ domain: "acme.io", websiteUrl: "https://acme.io" }));
    expect(r.domain).toBe("acme.io");
    expect(r.websiteUrl).toBe("https://acme.io");
    expect(r.recruitmentEmail).toBe("careers@acme.io");
  });
});

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const COMPANY = "Enrich Test Co Arc13";

describe.skipIf(!TEST_DB_URL)("ARC-13 — enrich-as-Activity orchestration (stubbed)", () => {
  let sql: Db;

  const purge = async (db: Db, name: string) => {
    await db`
      delete from public.activities
      where company_id in (select id from public.companies where name = ${name})`;
    await db`
      delete from public.contacts
      where company_id in (select id from public.companies where name = ${name})`;
    await db`delete from public.companies where name = ${name}`;
  };

  beforeAll(async () => {
    sql = createDb({ DATABASE_URL: TEST_DB_URL });
    for (const n of [COMPANY, "Enrich Fail Co Arc13", "Enrich Seam Co Arc13"]) await purge(sql, n);
  });

  afterAll(async () => {
    if (!sql) return;
    for (const n of [COMPANY, "Enrich Fail Co Arc13", "Enrich Seam Co Arc13"]) await purge(sql, n);
    await sql.end();
  });

  it("wraps enrich in a succeeded Activity and writes enrichment + status", async () => {
    const id = await upsertCompany(sql, COMPANY);
    const summary = await runEnrich(sql, { companyId: id });
    expect(summary.skipped).toBe(false);
    expect(summary.status).toBe("enriched");
    expect(summary.contactsFound).toBe(1);
    expect(summary.activityId).not.toBeNull();

    const company = await getCompany(sql, id);
    expect(company?.status).toBe("enriched");
    expect(company?.recruitment_email).toContain("careers@");
    expect(company?.website_url).toBeTruthy();
    expect(company?.enrichment).toBeTruthy();

    const [act] = await sql<{ type: string; status: string; company_id: string }[]>`
      select type, status, company_id from public.activities where id = ${summary.activityId}`;
    expect(act.type).toBe("enrich");
    expect(act.status).toBe("succeeded");
    expect(act.company_id).toBe(id);
  });

  it("is idempotent — re-running an enriched company is a no-op (no new Activity)", async () => {
    const id = await upsertCompany(sql, COMPANY);
    const [{ n: before }] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.activities where company_id = ${id} and type = 'enrich'`;

    const summary = await runEnrich(sql, { companyId: id });
    expect(summary.skipped).toBe(true);
    expect(summary.activityId).toBeNull();

    const [{ n: after }] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.activities where company_id = ${id} and type = 'enrich'`;
    expect(after).toBe(before);
  });

  it("re-enriches when forced, opening a fresh Activity", async () => {
    const id = await upsertCompany(sql, COMPANY);
    const summary = await runEnrich(sql, { companyId: id, force: true });
    expect(summary.skipped).toBe(false);
    expect(summary.status).toBe("enriched");
    expect(summary.activityId).not.toBeNull();
  });

  it("records a failed Activity + enrichment_failed and rethrows when the tools throw", async () => {
    const id = await upsertCompany(sql, "Enrich Fail Co Arc13");
    const boom: Enricher = () => {
      throw new NotIntegratedError("linkedin mcp not integrated");
    };
    await expect(runEnrich(sql, { companyId: id, enrich: boom })).rejects.toBeInstanceOf(
      NotIntegratedError,
    );

    const company = await getCompany(sql, id);
    expect(company?.status).toBe("enrichment_failed");
    expect((company?.enrichment as { error?: string })?.error).toContain("not integrated");

    const [failed] = await sql<{ status: string; error: string }[]>`
      select status, error from public.activities
      where company_id = ${id} and type = 'enrich' order by started_at desc limit 1`;
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("not integrated");
  });

  it("uses an injected enricher — the tool calls are a mockable seam", async () => {
    const id = await upsertCompany(sql, "Enrich Seam Co Arc13");
    const mock: Enricher = () => ({
      websiteUrl: "https://mock.example",
      recruitmentEmail: "jobs@mock.example",
      description: "mock",
      linkedinUrl: null,
      domain: "mock.example",
      contacts: [{ fullName: "Mock Person", email: "m@mock.example" }, { fullName: "Mock Two" }],
      source: { provider: "mock" },
    });
    const summary = await runEnrich(sql, { companyId: id, enrich: mock });
    expect(summary.contactsFound).toBe(2);

    const company = await getCompany(sql, id);
    expect(company?.recruitment_email).toBe("jobs@mock.example");
  });

  it("throws for an unknown company", async () => {
    await expect(
      runEnrich(sql, { companyId: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toThrow(/unknown company/);
  });
});
