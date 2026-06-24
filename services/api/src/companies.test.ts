import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// GET /companies + GET /companies/{id} (ARC-144) read the companies a user is
// relevant to. Stub the pool + the reads so the test stays hermetic — the point
// under test is the routes: they require auth, scope the list to the resolved user,
// pass the status filter through, gate the detail to a company the user holds a
// candidacy with (404 unknown, 403 not-theirs; service caller bypasses), and the
// list rejects a missing/invalid user.
vi.mock("./db.js", () => ({ getDb: () => ({}) }));
vi.mock("@archer/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archer/db")>();
  return {
    ...actual,
    listCompanies: vi.fn(),
    getCompanyDetail: vi.fn(),
    userOwnsCompany: vi.fn(),
  };
});

import {
  type CompanyDetail,
  type CompanySummary,
  getCompanyDetail,
  listCompanies,
  userOwnsCompany,
} from "@archer/db";

const app = (await import("./app")).default;
const mockList = vi.mocked(listCompanies);
const mockDetail = vi.mocked(getCompanyDetail);
const mockOwns = vi.mocked(userOwnsCompany);

const SECRET = "test-jwt-secret-value";
const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";
const COMPANY = "44444444-4444-4444-4444-444444444444";

const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
function signJwt(sub: string): string {
  const header = b64url({ alg: "HS256", typ: "JWT" });
  const body = b64url({ sub, aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 });
  const sig = createHmac("sha256", SECRET).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}
const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

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

describe("GET /companies + /companies/{id} (ARC-144)", () => {
  beforeEach(() => {
    // Default to JWT mode: a user is pinned to its own `sub`. The service-caller
    // tests opt into ARCHER_API_DEV_OPEN explicitly (dev-open short-circuits auth to
    // the trusted service principal before the bearer token is ever read).
    delete process.env.ARCHER_API_DEV_OPEN;
    delete process.env.ARCHER_API_SECRET;
    delete process.env.ARCHER_USER_ID;
    delete process.env.SUPABASE_URL;
    process.env.SUPABASE_JWT_SECRET = SECRET;
    mockList.mockReset();
    mockDetail.mockReset();
    mockOwns.mockReset();
  });
  afterEach(() => {
    delete process.env.ARCHER_API_DEV_OPEN;
    delete process.env.SUPABASE_JWT_SECRET;
  });

  it("scopes the list to the JWT user's own rows", async () => {
    mockList.mockResolvedValue([summary]);
    const res = await app.request("/companies", bearer(signJwt(USER_A)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: string; companies: CompanySummary[] };
    expect(body).toEqual({ user: USER_A, companies: [summary] });
    expect(mockList).toHaveBeenCalledWith(expect.anything(), USER_A, { status: undefined });
  });

  it("lets the service caller list a named user's companies (?user=)", async () => {
    process.env.ARCHER_API_DEV_OPEN = "1";
    mockList.mockResolvedValue([]);
    const res = await app.request(`/companies?user=${USER_A}`);
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith(expect.anything(), USER_A, { status: undefined });
  });

  it("403s a JWT user asking for someone else's rows", async () => {
    const res = await app.request(`/companies?user=${USER_B}`, bearer(signJwt(USER_A)));
    expect(res.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("400s a service caller with no resolvable user", async () => {
    process.env.ARCHER_API_DEV_OPEN = "1";
    const res = await app.request("/companies");
    expect(res.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("passes the status filter through to the query", async () => {
    mockList.mockResolvedValue([]);
    const res = await app.request("/companies?status=enriched", bearer(signJwt(USER_A)));
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith(expect.anything(), USER_A, { status: "enriched" });
  });

  it("rejects an unknown status value (400)", async () => {
    const res = await app.request("/companies?status=bogus", bearer(signJwt(USER_A)));
    expect(res.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("returns full detail (with contacts) for a company the user holds a candidacy with", async () => {
    mockDetail.mockResolvedValue(detail);
    mockOwns.mockResolvedValue(true);
    const res = await app.request(`/companies/${COMPANY}`, bearer(signJwt(USER_A)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { company: CompanyDetail };
    expect(body.company).toEqual(detail);
    expect(mockDetail).toHaveBeenCalledWith(expect.anything(), COMPANY);
    expect(mockOwns).toHaveBeenCalledWith(expect.anything(), USER_A, COMPANY);
  });

  it("403s a company the JWT user has no candidacy with", async () => {
    mockDetail.mockResolvedValue(detail);
    mockOwns.mockResolvedValue(false);
    const res = await app.request(`/companies/${COMPANY}`, bearer(signJwt(USER_A)));
    expect(res.status).toBe(403);
  });

  it("lets the service caller read any company's detail (ownership bypassed)", async () => {
    process.env.ARCHER_API_DEV_OPEN = "1";
    mockDetail.mockResolvedValue(detail);
    const res = await app.request(`/companies/${COMPANY}`);
    expect(res.status).toBe(200);
    expect(mockOwns).not.toHaveBeenCalled();
  });

  it("404s an unknown company", async () => {
    mockDetail.mockResolvedValue(undefined);
    const res = await app.request(`/companies/${COMPANY}`, bearer(signJwt(USER_A)));
    expect(res.status).toBe(404);
  });

  it("fails closed: denies the reads with no secret and no dev opt-in", async () => {
    expect((await app.request(`/companies?user=${USER_A}`)).status).toBe(401);
    expect((await app.request(`/companies/${COMPANY}`)).status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockDetail).not.toHaveBeenCalled();
  });
});
