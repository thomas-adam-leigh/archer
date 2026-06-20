import {
  createDb,
  type Db,
  getCandidacy,
  getCompany,
  insertCandidacy,
  setCandidacyStatus,
  upsertCompany,
  upsertPosting,
} from "@archer/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotIntegratedError } from "./adapters/types.js";
import { type Enricher, runEnrich, stubEnricher } from "./commands/enrich.js";

// Proves the enrich-as-Activity orchestration (ARC-13): one `archer enrich` run is
// wrapped in a single `enrich` Activity that ends succeeded/failed; the company walks
// new → researching → enriched | enrichment_failed; the (stubbed) LinkedIn/Firecrawl
// tools are a swappable seam; an already-enriched company is an idempotent no-op (no
// Activity); and a thrown tool leaves a failed Activity + enrichment_failed behind.
// ARC-33 adds the shortlist gate: enrichment is refused unless a shortlisted /
// alternative_outreach candidacy sits behind the company.
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
// A fixed user whose shortlisted candidacies satisfy the ARC-33 enrichment gate.
const USER = "dddddddd-0000-4000-8000-000000000033";

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

  // Tear down the seeded shortlist scaffolding (candidacies → postings → user).
  const purgeSeed = async (db: Db) => {
    await db`delete from public.candidacies where user_id = ${USER}`;
    await db`delete from public.postings where url like 'https://cj.test/arc33/%'`;
    await db`delete from public.users where id = ${USER}`;
    await db`delete from auth.users where id = ${USER}`;
  };

  // Put a company behind a shortlisted candidacy so the enrichment gate opens.
  // Idempotent: the posting url is keyed on the company id and re-runs upsert.
  const shortlist = async (db: Db, companyId: string): Promise<void> => {
    const { id: postingId } = await upsertPosting(db, {
      boardSlug: "careerjunction",
      url: `https://cj.test/arc33/${companyId}`,
      title: "Seed Posting Arc33",
      companyId,
    });
    const created = await insertCandidacy(db, USER, postingId);
    let candidacyId = created?.id;
    if (!candidacyId) {
      const [row] = await db<{ id: string }[]>`
        select id from public.candidacies where user_id = ${USER} and posting_id = ${postingId}`;
      candidacyId = row.id;
    }
    await setCandidacyStatus(db, candidacyId, "shortlisted");
  };

  beforeAll(async () => {
    sql = createDb({ DATABASE_URL: TEST_DB_URL });
    for (const n of [
      COMPANY,
      "Enrich Fail Co Arc13",
      "Enrich Seam Co Arc13",
      "Enrich Ungated Co Arc33",
      "Enrich Contacts Co Arc34",
    ])
      await purge(sql, n);
    await purgeSeed(sql);
    // Signup fires on_auth_user_created → public.users (the candidacy FK target).
    await sql`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${USER}, 'arc33@example.com', ${sql.json({ full_name: "Arc33" })})
      on conflict (id) do nothing`;
  });

  afterAll(async () => {
    if (!sql) return;
    for (const n of [
      COMPANY,
      "Enrich Fail Co Arc13",
      "Enrich Seam Co Arc13",
      "Enrich Ungated Co Arc33",
      "Enrich Contacts Co Arc34",
    ])
      await purge(sql, n);
    await purgeSeed(sql);
    await sql.end();
  });

  it("wraps enrich in a succeeded Activity and writes enrichment + status", async () => {
    const id = await upsertCompany(sql, COMPANY);
    await shortlist(sql, id);
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

    // ARC-34: the found people are promoted into the dedicated contacts table.
    const contacts = await sql<{ full_name: string; email: string; role_title: string }[]>`
      select full_name, email, role_title from public.contacts where company_id = ${id}`;
    expect(contacts).toHaveLength(1);
    expect(contacts[0].role_title).toBe("Talent Acquisition");
    expect(contacts[0].email).toContain("talent@");
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
    await shortlist(sql, id);
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
    await shortlist(sql, id);
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

  it("promotes found contacts into public.contacts, idempotently across re-runs (ARC-34)", async () => {
    const id = await upsertCompany(sql, "Enrich Contacts Co Arc34");
    await shortlist(sql, id);
    // Two people, one without an email — exercises both dedup keys
    // (company_id + lower(email) and, for the emailless row, + lower(full_name)).
    const mock: Enricher = () => ({
      websiteUrl: null,
      recruitmentEmail: null,
      description: null,
      linkedinUrl: null,
      domain: null,
      contacts: [
        { fullName: "Rita Recruiter", email: "rita@contacts.example", roleTitle: "Recruiter" },
        { fullName: "Nora NoEmail", linkedinUrl: "https://www.linkedin.com/in/nora" },
      ],
      source: { provider: "mock" },
    });

    await runEnrich(sql, { companyId: id, enrich: mock });
    const first = await sql<{ full_name: string; email: string | null }[]>`
      select full_name, email from public.contacts where company_id = ${id} order by full_name`;
    expect(first).toHaveLength(2);
    expect(first.map((c) => c.full_name)).toEqual(["Nora NoEmail", "Rita Recruiter"]);
    expect(first.find((c) => c.full_name === "Nora NoEmail")?.email).toBeNull();

    // Re-enriching (forced) the same company adds no duplicate contact rows.
    await runEnrich(sql, { companyId: id, force: true, enrich: mock });
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.contacts where company_id = ${id}`;
    expect(n).toBe(2);
  });

  it("refuses a company with no shortlisted candidacy and opens no Activity (gate)", async () => {
    const id = await upsertCompany(sql, "Enrich Ungated Co Arc33");
    await expect(runEnrich(sql, { companyId: id })).rejects.toThrow(
      /gated to shortlisted companies/,
    );

    // Fail-closed precondition: status untouched and no Activity opened.
    const company = await getCompany(sql, id);
    expect(company?.status).toBe("new");
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.activities where company_id = ${id} and type = 'enrich'`;
    expect(n).toBe(0);
  });

  it("throws for an unknown company", async () => {
    await expect(
      runEnrich(sql, { companyId: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toThrow(/unknown company/);
  });
});

// ARC-35: the candidacy gate. On successful enrichment the company's shortlisted /
// alternative_outreach candidacies advance to awaiting_cover_letter (the hand-off into
// Applications & Cover Letters), each owner is notified, the transition fires exactly
// once per candidacy (a forced re-enrich advances none), and a company whose
// enrichment FAILS advances nothing. DB-backed, so it runs only against a migrated
// TEST_DATABASE_URL (skipped otherwise); the wiring is still typechecked in CI.
const GATE_USER = "dddddddd-0000-4000-8000-000000000035";
const GATE_COMPANY = "Gate Co Arc35";
const GATE_FAIL_COMPANY = "Gate Fail Co Arc35";

describe.skipIf(!TEST_DB_URL)("ARC-35 — candidacy gate → awaiting_cover_letter on enriched", () => {
  let sql: Db;

  const purge = async (db: Db, names: string[]) => {
    for (const name of names) {
      await db`
        delete from public.activities
        where company_id in (select id from public.companies where name = ${name})`;
      await db`
        delete from public.contacts
        where company_id in (select id from public.companies where name = ${name})`;
    }
    await db`delete from public.notifications where user_id = ${GATE_USER}`;
    await db`delete from public.candidacies where user_id = ${GATE_USER}`;
    await db`delete from public.postings where url like 'https://cj.test/arc35/%'`;
    for (const name of names) await db`delete from public.companies where name = ${name}`;
  };

  // Put a candidacy at `status` behind a company; returns its id. Posting url is keyed
  // on the company id so re-runs upsert rather than duplicate.
  const shortlist = async (
    db: Db,
    companyId: string,
    status: "shortlisted" | "alternative_outreach" = "shortlisted",
  ): Promise<string> => {
    const { id: postingId } = await upsertPosting(db, {
      boardSlug: "careerjunction",
      url: `https://cj.test/arc35/${companyId}`,
      title: "Gate Posting Arc35",
      companyId,
    });
    const created = await insertCandidacy(db, GATE_USER, postingId);
    let candidacyId = created?.id;
    if (!candidacyId) {
      const [row] = await db<{ id: string }[]>`
        select id from public.candidacies where user_id = ${GATE_USER} and posting_id = ${postingId}`;
      candidacyId = row.id;
    }
    await setCandidacyStatus(db, candidacyId, status);
    return candidacyId;
  };

  beforeAll(async () => {
    sql = createDb({ DATABASE_URL: TEST_DB_URL });
    await purge(sql, [GATE_COMPANY, GATE_FAIL_COMPANY]);
    await sql`delete from public.users where id = ${GATE_USER}`;
    await sql`delete from auth.users where id = ${GATE_USER}`;
    await sql`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${GATE_USER}, 'arc35@example.com', ${sql.json({ full_name: "Arc35" })})
      on conflict (id) do nothing`;
  });

  afterAll(async () => {
    if (!sql) return;
    await purge(sql, [GATE_COMPANY, GATE_FAIL_COMPANY]);
    await sql`delete from public.users where id = ${GATE_USER}`;
    await sql`delete from auth.users where id = ${GATE_USER}`;
    await sql.end();
  });

  it("advances a shortlisted candidacy to awaiting_cover_letter and notifies the owner", async () => {
    const id = await upsertCompany(sql, GATE_COMPANY);
    const candidacyId = await shortlist(sql, id);

    const summary = await runEnrich(sql, { companyId: id });
    expect(summary.status).toBe("enriched");
    expect(summary.candidaciesAdvanced).toBe(1);

    const candidacy = await getCandidacy(sql, candidacyId);
    expect(candidacy?.status).toBe("awaiting_cover_letter");

    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.notifications
      where user_id = ${GATE_USER} and ref->>'candidacyId' = ${candidacyId}`;
    expect(n).toBe(1);
  });

  it("fires exactly once per candidacy — a forced re-enrich advances none", async () => {
    const id = await upsertCompany(sql, GATE_COMPANY);
    const summary = await runEnrich(sql, { companyId: id, force: true });
    expect(summary.status).toBe("enriched");
    expect(summary.candidaciesAdvanced).toBe(0);

    // No second notification: the candidacy is already awaiting_cover_letter.
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.notifications where user_id = ${GATE_USER}`;
    expect(n).toBe(1);
  });

  it("does not advance candidacies when enrichment fails (un-enriched company)", async () => {
    const id = await upsertCompany(sql, GATE_FAIL_COMPANY);
    const candidacyId = await shortlist(sql, id);
    const boom: Enricher = () => {
      throw new NotIntegratedError("firecrawl not integrated");
    };
    await expect(runEnrich(sql, { companyId: id, enrich: boom })).rejects.toBeInstanceOf(
      NotIntegratedError,
    );

    const company = await getCompany(sql, id);
    expect(company?.status).toBe("enrichment_failed");
    const candidacy = await getCandidacy(sql, candidacyId);
    expect(candidacy?.status).toBe("shortlisted");
  });
});
