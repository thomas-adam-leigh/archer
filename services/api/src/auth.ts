import { createHmac, timingSafeEqual } from "node:crypto";

// ── Supabase user-JWT verification (ARC-83) ──────────────────────────────────
// The mobile (Lynx) client authenticates as the end user with their Supabase
// session token (`Authorization: Bearer <jwt>`), not the server-to-server shared
// secret. This module verifies that token and returns the user id (`auth.uid`)
// to scope the request by — or null on ANY invalid/expired/tampered/misconfigured
// token, so the caller fails closed. It NEVER trusts an unverified base64 decode:
// the signature and the standard claims (expiry, audience) are always checked.
//
// Two verification paths, no extra dependency:
//   • Local HS256 against the project's legacy `SUPABASE_JWT_SECRET` (symmetric
//     signing) — fully offline, the fast path, and how the tests sign tokens.
//   • A server-side check via `GET {SUPABASE_URL}/auth/v1/user` for tokens this
//     process can't verify locally (e.g. a project on asymmetric signing keys).
// In CI neither makes a live call: tests sign HS256 tokens with the same secret,
// and the `/auth/v1/user` fallback is reached only when `SUPABASE_URL` is set.

const AUTHENTICATED_AUD = "authenticated";

type JwtPayload = Record<string, unknown>;

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

// Verify an HS256 token's signature against `secret` and return its payload, or
// null if the token isn't a well-formed HS256 JWT or the signature doesn't match
// (constant-time compare). A non-HS256 token returns null so the caller can fall
// through to the server-side check.
function verifyHs256(token: string, secret: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;
  let header: { alg?: unknown };
  let payload: JwtPayload;
  let signature: Buffer;
  try {
    header = decodeSegment(headerB64) as { alg?: unknown };
    payload = decodeSegment(payloadB64) as JwtPayload;
    signature = Buffer.from(signatureB64, "base64url");
  } catch {
    return null;
  }
  if (header?.alg !== "HS256") return null;
  const expected = createHmac("sha256", secret).update(`${headerB64}.${payloadB64}`).digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
  return payload;
}

// Validate the standard claims on an already-signature-verified payload and return
// the subject (= `auth.uid`), or null if expired/not-yet-valid, not audience
// `authenticated`, or missing a subject (e.g. the anon key, which has no `sub`).
function subjectFromClaims(payload: JwtPayload): string | null {
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && payload.exp <= now) return null;
  if (typeof payload.nbf === "number" && payload.nbf > now) return null;
  const aud = payload.aud;
  const audOk =
    aud === AUTHENTICATED_AUD || (Array.isArray(aud) && aud.includes(AUTHENTICATED_AUD));
  if (!audOk) return null;
  return typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : null;
}

// Server-side validation fallback: present the token to Supabase, which checks the
// signature + claims and returns the user. Used for tokens this process can't
// verify locally (asymmetric signing keys, or no `SUPABASE_JWT_SECRET`). Never
// invoked in CI (tests don't set `SUPABASE_URL`); returns null on any failure.
async function verifyViaUserEndpoint(token: string): Promise<string | null> {
  const baseUrl = process.env.SUPABASE_URL;
  if (!baseUrl) return null;
  // `/auth/v1/user` requires an `apikey` header (any of the project's keys is
  // accepted by GoTrue). Accept both the legacy env names and the current ones the
  // deployed container actually provides (`SUPABASE_SECRET_KEY` /
  // `SUPABASE_PUBLISHABLE_KEY`) — otherwise apikey is undefined in prod and every
  // ES256 user token 401s (ARC-87).
  const apikey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_SECRET_KEY ??
    process.env.SUPABASE_ANON_KEY ??
    process.env.SUPABASE_PUBLISHABLE_KEY;
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...(apikey ? { apikey } : {}),
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { id?: unknown };
    return typeof body.id === "string" && body.id.length > 0 ? body.id : null;
  } catch {
    return null;
  }
}

/**
 * Verify a Supabase user JWT and return its subject (`auth.uid`), or null on any
 * invalid/expired/tampered/misconfigured token (fail closed). Verifies signature
 * + claims locally (HS256 via `SUPABASE_JWT_SECRET`) when possible, else defers to
 * Supabase's `/auth/v1/user`. A valid HS256 signature is authoritative: a verdict
 * of null (e.g. expired) is returned without a network round-trip.
 */
export async function verifySupabaseJwt(token: string): Promise<string | null> {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (secret) {
    const payload = verifyHs256(token, secret);
    // A valid HS256 signature settles it; only a non-HS256 / bad-signature token
    // (payload === null) falls through to the server-side check below.
    if (payload) return subjectFromClaims(payload);
  }
  return verifyViaUserEndpoint(token);
}
