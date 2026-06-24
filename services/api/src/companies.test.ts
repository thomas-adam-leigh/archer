import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// GET /companies + GET /companies/{id} (read-endpoint sub-track) read the companies
// table. Stub the pool + the two reads so the test stays hermetic — the point under
// test is the routes: companies are objective shared data (no per-user scoping), the
// list passes its status filter through, the detail 404s an unknown id, and both
// require auth.
vi.mock("./db.js", () => ({ getDb: () => ({}) }));
vi.mock("@archer/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archer/db")>();
  return { ...actual, listCompanies: vi.fn(), getCompanyDetail: vi.fn() };
});

import {
  type CompanyDetail,
  type CompanySummary,
  getCompanyDetail,
  listCompanies,
} from "@archer/db";

const app = (await import("./app")).default;
const mockList = vi.mocked(listCompanies);
const mockDetail = vi.mocked(getCompanyDetail);

const COMPANY = "44444444-4444-4444-4444-444444444444";

const summary: CompanySummary = {
  id: COMPANY,
  name: "Acme",
  status: "enriched",
  domain: "acme.example",
  website_url: "https://acme.example",
  description: "An enriched company.",
  created_at: "2026-06-24T00:00:00Z",
};

const detail: CompanyDetail = {
  id: COMPANY,
  name: "Acme",
  status: "enriched",
  domain: "acme.example",
  website_url: "https://acme.example",
  linkedin_url: "https://linkedin.com/company/acme",
  description: "An enriched company.",
  recruitment_email: "jobs@acme.example",
  enrichment: { headcount: 120 },
  created_at: "2026-06-24T00:00:00Z",
  updated_at: "2026-06-24T01:00:00Z",
  contacts: [
    {
      id: "55555555-5555-5555-5555-555555555555",
      full_name: "Dana Recruiter",
      email: "dana@acme.example",
      linkedin_url: null,
      role_title: "Talent Lead",
      notes: null,
    },
  ],
};

describe("GET /companies + /companies/{id} (read-endpoint sub-track)", () => {
  beforeEach(() => {
    // Dev opt-in so the read is reachable without a shared secret.
    process.env.ARCHER_API_DEV_OPEN = "1";
    delete process.env.ARCHER_API_SECRET;
    mockList.mockReset();
    mockDetail.mockReset();
  });
  afterEach(() => {
    delete process.env.ARCHER_API_DEV_OPEN;
  });

  it("lists companies", async () => {
    mockList.mockResolvedValue([summary]);
    const res = await app.request("/companies");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { companies: CompanySummary[] };
    expect(body.companies).toEqual([summary]);
    expect(mockList).toHaveBeenCalledWith(expect.anything(), { status: undefined });
  });

  it("passes the status filter through to the query", async () => {
    mockList.mockResolvedValue([]);
    const res = await app.request("/companies?status=enriched");
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith(expect.anything(), { status: "enriched" });
  });

  it("rejects an unknown status value (400)", async () => {
    const res = await app.request("/companies?status=bogus");
    expect(res.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("returns one company's full detail with contacts", async () => {
    mockDetail.mockResolvedValue(detail);
    const res = await app.request(`/companies/${COMPANY}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { company: CompanyDetail };
    expect(body.company).toEqual(detail);
    expect(mockDetail).toHaveBeenCalledWith(expect.anything(), COMPANY);
  });

  it("404s an unknown company", async () => {
    mockDetail.mockResolvedValue(undefined);
    const res = await app.request(`/companies/${COMPANY}`);
    expect(res.status).toBe(404);
  });

  it("fails closed: denies the reads with no secret and no dev opt-in", async () => {
    delete process.env.ARCHER_API_DEV_OPEN;
    expect((await app.request("/companies")).status).toBe(401);
    expect((await app.request(`/companies/${COMPANY}`)).status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockDetail).not.toHaveBeenCalled();
  });
});
