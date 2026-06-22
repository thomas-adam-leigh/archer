import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifySupabaseJwt } from "./auth";

// A local HS256 signer so the suite exercises real signature verification with no
// live Supabase call (the project's legacy symmetric secret path). Mirrors how the
// mobile client's Supabase session token is structured: `sub` = user id, `aud` =
// "authenticated".
const SECRET = "test-jwt-secret-value";
const USER = "11111111-1111-1111-1111-111111111111";

const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");

function sign(
  payload: Record<string, unknown>,
  { secret = SECRET, alg = "HS256" }: { secret?: string; alg?: string } = {},
): string {
  const header = b64url({ alg, typ: "JWT" });
  const body = b64url(payload);
  const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

const nowSec = () => Math.floor(Date.now() / 1000);
const validPayload = (over: Record<string, unknown> = {}) => ({
  sub: USER,
  aud: "authenticated",
  exp: nowSec() + 3600,
  ...over,
});

describe("verifySupabaseJwt (ARC-83)", () => {
  beforeEach(() => {
    process.env.SUPABASE_JWT_SECRET = SECRET;
    // No SUPABASE_URL → the /auth/v1/user fallback is inert, so the suite never
    // touches the network: an unverifiable token resolves to null locally.
    delete process.env.SUPABASE_URL;
  });
  afterEach(() => {
    delete process.env.SUPABASE_JWT_SECRET;
    delete process.env.SUPABASE_URL;
  });

  it("accepts a valid token and returns its subject (auth.uid)", async () => {
    expect(await verifySupabaseJwt(sign(validPayload()))).toBe(USER);
  });

  it("accepts an audience array containing 'authenticated'", async () => {
    expect(await verifySupabaseJwt(sign(validPayload({ aud: ["authenticated"] })))).toBe(USER);
  });

  it("rejects an expired token", async () => {
    expect(await verifySupabaseJwt(sign(validPayload({ exp: nowSec() - 60 })))).toBeNull();
  });

  it("rejects a not-yet-valid token (nbf in the future)", async () => {
    expect(await verifySupabaseJwt(sign(validPayload({ nbf: nowSec() + 600 })))).toBeNull();
  });

  it("rejects the wrong audience", async () => {
    expect(await verifySupabaseJwt(sign(validPayload({ aud: "anon" })))).toBeNull();
  });

  it("rejects a token with no subject (e.g. the anon key)", async () => {
    expect(await verifySupabaseJwt(sign(validPayload({ sub: undefined })))).toBeNull();
  });

  it("rejects a token signed with a different secret (bad signature)", async () => {
    expect(await verifySupabaseJwt(sign(validPayload(), { secret: "wrong" }))).toBeNull();
  });

  it("rejects a token whose payload was tampered after signing", async () => {
    const token = sign(validPayload());
    const [h, , s] = token.split(".");
    const forged = b64url(validPayload({ sub: "22222222-2222-2222-2222-222222222222" }));
    expect(await verifySupabaseJwt(`${h}.${forged}.${s}`)).toBeNull();
  });

  it("rejects malformed input", async () => {
    expect(await verifySupabaseJwt("not-a-jwt")).toBeNull();
    expect(await verifySupabaseJwt("")).toBeNull();
  });

  it("returns null when no verification method is configured", async () => {
    delete process.env.SUPABASE_JWT_SECRET;
    expect(await verifySupabaseJwt(sign(validPayload()))).toBeNull();
  });
});
