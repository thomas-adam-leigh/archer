import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// POST /candidacies/{id}/apply-confirm (ARC-165) is the owner's explicit go-ahead on
// an approved candidacy: it gates the row to its owner, stamps the confirmation
// (confirmApply), and only then fires the apply via the CLI. Stub the pool, the two
// DB reads/writes, and the CLI runner so the test stays hermetic — the point under
// test is the route's auth + ownership + confirm-then-apply ordering.
vi.mock("./db.js", () => ({ getDb: () => ({}) }));
vi.mock("./cli.js", () => ({ runCli: vi.fn() }));
vi.mock("@archer/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archer/db")>();
  return { ...actual, getCandidacy: vi.fn(), confirmApply: vi.fn() };
});

import { type Candidacy, confirmApply, getCandidacy } from "@archer/db";
import { runCli } from "./cli.js";

const app = (await import("./app")).default;
const mockGet = vi.mocked(getCandidacy);
const mockConfirm = vi.mocked(confirmApply);
const mockCli = vi.mocked(runCli);

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
const bearer = (token: string) => ({
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
});

// A minimal candidacy row — the route only reads id/user_id/status off it.
const candidacy = (userId: string, status: Candidacy["status"]): Candidacy =>
  ({
    id: CANDIDACY,
    user_id: userId,
    posting_id: "44444444-4444-4444-4444-444444444444",
    status,
    triage_decision: null,
    triage_reason: null,
    match_score: null,
    apply_confirmed_at: null,
    status_changed_at: "2026-06-24T01:00:00Z",
    created_at: "2026-06-24T00:00:00Z",
    updated_at: "2026-06-24T01:00:00Z",
  }) as Candidacy;

describe("POST /candidacies/{id}/apply-confirm (ARC-165)", () => {
  beforeEach(() => {
    delete process.env.ARCHER_API_DEV_OPEN;
    delete process.env.ARCHER_API_SECRET;
    delete process.env.ARCHER_USER_ID;
    delete process.env.SUPABASE_URL;
    process.env.SUPABASE_JWT_SECRET = SECRET;
    mockGet.mockReset();
    mockConfirm.mockReset();
    mockCli.mockReset();
  });
  afterEach(() => {
    delete process.env.SUPABASE_JWT_SECRET;
  });

  it("confirms then fires the apply for the owner (200)", async () => {
    mockGet.mockResolvedValue(candidacy(USER_A, "approved"));
    mockConfirm.mockResolvedValue({
      ...candidacy(USER_A, "approved"),
      apply_confirmed_at: "2026-06-24T02:00:00Z",
    });
    mockCli.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ candidacyId: CANDIDACY, status: "applied", outcome: "submitted" }),
      stderr: "",
    });

    const res = await app.request(
      `/candidacies/${CANDIDACY}/apply-confirm`,
      bearer(signJwt(USER_A)),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("applied");
    // Confirmation was stamped BEFORE the apply fired.
    expect(mockConfirm).toHaveBeenCalledWith(expect.anything(), CANDIDACY);
    expect(mockCli).toHaveBeenCalledWith(["apply", CANDIDACY, "--json"]);
  });

  it("409s a candidacy that is not awaiting apply-confirm (e.g. still drafting) — no apply", async () => {
    mockGet.mockResolvedValue(candidacy(USER_A, "drafting"));
    mockConfirm.mockResolvedValue(undefined); // not approved → nothing to confirm
    const res = await app.request(
      `/candidacies/${CANDIDACY}/apply-confirm`,
      bearer(signJwt(USER_A)),
    );
    expect(res.status).toBe(409);
    expect(mockCli).not.toHaveBeenCalled();
  });

  it("404s an unknown candidacy", async () => {
    mockGet.mockResolvedValue(undefined);
    const res = await app.request(
      `/candidacies/${CANDIDACY}/apply-confirm`,
      bearer(signJwt(USER_A)),
    );
    expect(res.status).toBe(404);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("403s another user's candidacy (no cross-user confirm)", async () => {
    mockGet.mockResolvedValue(candidacy(USER_B, "approved"));
    const res = await app.request(
      `/candidacies/${CANDIDACY}/apply-confirm`,
      bearer(signJwt(USER_A)),
    );
    expect(res.status).toBe(403);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockCli).not.toHaveBeenCalled();
  });

  it("fails closed: 401 with no token", async () => {
    const res = await app.request(`/candidacies/${CANDIDACY}/apply-confirm`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("502s when the apply CLI fails (after confirmation)", async () => {
    mockGet.mockResolvedValue(candidacy(USER_A, "approved"));
    mockConfirm.mockResolvedValue({
      ...candidacy(USER_A, "approved"),
      apply_confirmed_at: "2026-06-24T02:00:00Z",
    });
    mockCli.mockResolvedValue({ code: 1, stdout: "", stderr: "boom" });
    const res = await app.request(
      `/candidacies/${CANDIDACY}/apply-confirm`,
      bearer(signJwt(USER_A)),
    );
    expect(res.status).toBe(502);
  });
});
