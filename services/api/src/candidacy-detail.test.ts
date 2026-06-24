import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// GET /candidacies/{id} (ARC-146) joins a candidacy to its posting/company/external
// form. Stub the pool + the one read so the test stays hermetic — the point under
// test is the route: it requires auth, gates the row to its owner (404 unknown,
// 403 someone else's), and returns the assembled detail unchanged.
vi.mock("./db.js", () => ({ getDb: () => ({}) }));
vi.mock("@archer/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archer/db")>();
  return { ...actual, getCandidacyDetail: vi.fn() };
});

import { type CandidacyDetail, getCandidacyDetail } from "@archer/db";

const app = (await import("./app")).default;
const mockDetail = vi.mocked(getCandidacyDetail);

const SECRET = "test-jwt-secret-value";
const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";
const CANDIDACY = "33333333-3333-3333-3333-333333333333";

const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
function signJwt(sub: string): string {
  const header = b64url({ alg: "HS256", typ: "JWT" });
  const body = b64url({ sub, aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 });
  const sig = createHmac("sha256", SECRET).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}
const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

const detail = (userId: string): CandidacyDetail => ({
  id: CANDIDACY,
  user_id: userId,
  status: "shortlisted",
  triage_decision: "shortlist",
  triage_reason: "Strong match on backend role + remote",
  match_score: 87,
  created_at: "2026-06-24T00:00:00Z",
  status_changed_at: "2026-06-24T01:00:00Z",
  posting: {
    title: "Senior Backend Engineer",
    board_slug: "pnet",
    url: "https://www.pnet.co.za/jobs/1",
    location: "Cape Town",
    work_mode: "remote",
    salary_raw: "R900k–R1.1m",
    posted_on: "2026-06-23",
    description: "Build things.",
  },
  company: {
    id: "44444444-4444-4444-4444-444444444444",
    name: "Acme",
    status: "enriched",
    description: "An enriched company.",
    website_url: "https://acme.example",
    recruitment_email: "jobs@acme.example",
  },
  external_form: { status: "queued", url: "https://www.pnet.co.za/apply/1" },
});

describe("GET /candidacies/{id} (ARC-146)", () => {
  beforeEach(() => {
    delete process.env.ARCHER_API_DEV_OPEN;
    delete process.env.ARCHER_API_SECRET;
    delete process.env.ARCHER_USER_ID;
    delete process.env.SUPABASE_URL;
    process.env.SUPABASE_JWT_SECRET = SECRET;
    mockDetail.mockReset();
  });
  afterEach(() => {
    delete process.env.SUPABASE_JWT_SECRET;
  });

  it("returns the full detail for the owner (200), scoped to the token's user", async () => {
    mockDetail.mockResolvedValue(detail(USER_A));
    const res = await app.request(`/candidacies/${CANDIDACY}`, bearer(signJwt(USER_A)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidacy: CandidacyDetail };
    expect(body.candidacy).toEqual(detail(USER_A));
    expect(mockDetail).toHaveBeenCalledWith(expect.anything(), CANDIDACY);
  });

  it("404s an unknown candidacy", async () => {
    mockDetail.mockResolvedValue(undefined);
    const res = await app.request(`/candidacies/${CANDIDACY}`, bearer(signJwt(USER_A)));
    expect(res.status).toBe(404);
  });

  it("403s another user's candidacy (no cross-user read)", async () => {
    mockDetail.mockResolvedValue(detail(USER_B));
    const res = await app.request(`/candidacies/${CANDIDACY}`, bearer(signJwt(USER_A)));
    expect(res.status).toBe(403);
  });

  it("fails closed: 401 with no token", async () => {
    const res = await app.request(`/candidacies/${CANDIDACY}`);
    expect(res.status).toBe(401);
    expect(mockDetail).not.toHaveBeenCalled();
  });
});
