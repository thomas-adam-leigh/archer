import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Applications read endpoint (ARC-166): the owner's candidacies in the apply
// lifecycle. Stub the pool + the read so the test stays hermetic — the point under
// test is the route: it requires auth and is scoped to the JWT user's own rows
// (a JWT caller can only read their own data; asking for another user's via `?user=`
// is 403). The list query itself is exercised in @archer/db's own tests.
vi.mock("./db.js", () => ({ getDb: () => ({}) }));
vi.mock("@archer/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archer/db")>();
  return {
    ...actual,
    listApplications: vi.fn(),
  };
});

import { type ApplicationListItem, listApplications } from "@archer/db";

const app = (await import("./app")).default;
const mockListApplications = vi.mocked(listApplications);

const SECRET = "test-jwt-secret-value";
const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";

const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
function signJwt(sub: string): string {
  const header = b64url({ alg: "HS256", typ: "JWT" });
  const body = b64url({ sub, aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 });
  const sig = createHmac("sha256", SECRET).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}
const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

const applications: ApplicationListItem[] = [
  {
    id: "33333333-3333-3333-3333-333333333333",
    status: "approved",
    posting_title: "Senior Backend Engineer",
    board_slug: "pnet",
    company_name: "Acme",
    created_at: "2026-06-24T09:00:00Z",
    status_changed_at: "2026-06-24T10:00:00Z",
    apply_confirmed_at: null,
    cover_letter_version_id: "55555555-5555-5555-5555-555555555555",
    cover_letter_version_no: 2,
    external_form_status: null,
    external_form_url: null,
  },
  {
    id: "44444444-4444-4444-4444-444444444444",
    status: "external_pending",
    posting_title: "Platform Engineer",
    board_slug: "careerjunction",
    company_name: "Globex",
    created_at: "2026-06-23T09:00:00Z",
    status_changed_at: "2026-06-23T11:00:00Z",
    apply_confirmed_at: "2026-06-23T10:30:00Z",
    cover_letter_version_id: "66666666-6666-6666-6666-666666666666",
    cover_letter_version_no: 1,
    external_form_status: "pending",
    external_form_url: "https://globex.example/apply",
  },
];

describe("GET /applications (ARC-166)", () => {
  beforeEach(() => {
    delete process.env.ARCHER_API_DEV_OPEN;
    delete process.env.ARCHER_API_SECRET;
    delete process.env.ARCHER_USER_ID;
    delete process.env.SUPABASE_URL;
    process.env.SUPABASE_JWT_SECRET = SECRET;
    mockListApplications.mockReset();
  });
  afterEach(() => {
    delete process.env.SUPABASE_JWT_SECRET;
  });

  it("returns the owner's apply-lifecycle candidacies (200), scoped to the JWT user", async () => {
    mockListApplications.mockResolvedValue(applications);
    const res = await app.request("/applications", bearer(signJwt(USER_A)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: string; applications: ApplicationListItem[] };
    expect(body.user).toBe(USER_A);
    expect(body.applications).toEqual(applications);
    expect(mockListApplications).toHaveBeenCalledWith(expect.anything(), USER_A);
  });

  it("allows the owner to pass their own ?user= (200)", async () => {
    mockListApplications.mockResolvedValue([]);
    const res = await app.request(`/applications?user=${USER_A}`, bearer(signJwt(USER_A)));
    expect(res.status).toBe(200);
    expect(mockListApplications).toHaveBeenCalledWith(expect.anything(), USER_A);
  });

  it("403s a JWT caller asking for another user's applications (no cross-user read)", async () => {
    const res = await app.request(`/applications?user=${USER_B}`, bearer(signJwt(USER_A)));
    expect(res.status).toBe(403);
    expect(mockListApplications).not.toHaveBeenCalled();
  });

  it("fails closed: 401 with no token", async () => {
    const res = await app.request("/applications");
    expect(res.status).toBe(401);
    expect(mockListApplications).not.toHaveBeenCalled();
  });
});
