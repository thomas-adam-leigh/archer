import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The live repro (ARC-83) reaches the route handler, which reads the DB. Stub the
// pool + the one read so the test stays hermetic — the point under test is the auth
// layer (JWT accepted, identity from the verified token), not the query. The JWT
// itself is verified for real (local HS256), never mocked.
vi.mock("./db.js", () => ({ getDb: () => ({}) }));
vi.mock("@archer/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archer/db")>();
  return {
    ...actual,
    getOnboardingProgress: vi.fn(async (_db: unknown, user: string) => ({
      step: "intro",
      completed: false,
      _scopedTo: user,
    })),
  };
});

const app = (await import("./app")).default;

const SECRET = "test-jwt-secret-value";
const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";

const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
function signJwt(sub: string, over: Record<string, unknown> = {}): string {
  const header = b64url({ alg: "HS256", typ: "JWT" });
  const body = b64url({
    sub,
    aud: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...over,
  });
  const sig = createHmac("sha256", SECRET).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}
const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

describe("Supabase JWT auth on user-facing routes (ARC-83)", () => {
  beforeEach(() => {
    // The two server-to-server bypasses off, so only a verified JWT can pass.
    delete process.env.ARCHER_API_DEV_OPEN;
    delete process.env.ARCHER_API_SECRET;
    delete process.env.ARCHER_USER_ID;
    delete process.env.SUPABASE_URL;
    process.env.SUPABASE_JWT_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.SUPABASE_JWT_SECRET;
  });

  it("the live repro: a valid JWT loads onboarding progress (200), scoped to the token's user", async () => {
    const res = await app.request("/onboarding/progress", bearer(signJwt(USER_A)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: string; _scopedTo: string };
    // Identity (auth.uid) comes from the verified `sub`, never from input.
    expect(body.user).toBe(USER_A);
    expect(body._scopedTo).toBe(USER_A);
  });

  it("ignores a caller-supplied ?user that matches and serves the token's user", async () => {
    const res = await app.request(`/onboarding/progress?user=${USER_A}`, bearer(signJwt(USER_A)));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: string }).user).toBe(USER_A);
  });

  it("refuses a cross-user ?user mismatch (impersonation) with 403", async () => {
    const res = await app.request(`/onboarding/progress?user=${USER_B}`, bearer(signJwt(USER_A)));
    expect(res.status).toBe(403);
  });

  it("rejects an expired token (401)", async () => {
    const res = await app.request(
      "/onboarding/progress",
      bearer(signJwt(USER_A, { exp: Math.floor(Date.now() / 1000) - 60 })),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a tampered token (401)", async () => {
    const [h, , s] = signJwt(USER_A).split(".");
    const forged = b64url({
      sub: USER_B,
      aud: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const res = await app.request("/onboarding/progress", bearer(`${h}.${forged}.${s}`));
    expect(res.status).toBe(401);
  });

  it("rejects a missing token (401)", async () => {
    const res = await app.request("/onboarding/progress");
    expect(res.status).toBe(401);
  });

  it("still admits the server-to-server secret, which may act for any user (200)", async () => {
    process.env.ARCHER_API_SECRET = "s3cret";
    const res = await app.request(`/onboarding/progress?user=${USER_B}`, {
      headers: { "x-archer-secret": "s3cret" },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: string }).user).toBe(USER_B);
  });

  it("does not accept a JWT on the server-to-server control plane (/commands/match)", async () => {
    const res = await app.request("/commands/match", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${signJwt(USER_A)}` },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });
});
