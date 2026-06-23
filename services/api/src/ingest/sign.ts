// Durable résumé URL (ARC-131) — the storageRef → resolvable-URL half of ingest.
//
// The résumé is uploaded to the PRIVATE `resumes` bucket (ARC-62) and only its
// object path (`storageRef`) is kept on the version's `details`. `profiles.resume_url`
// needs a URL a client can actually open, but the bucket is private so a bare object
// URL 403s. We mint a LONG-LIVED SIGNED URL here (service-role, server-side) and
// persist it; on approval it is materialised into `profiles.resume_url` (ARC-130 path).
//
// Why a long-lived signed URL (and not "store the ref, resolve on read"): the readers
// of `profiles.resume_url` (CLI / MCP) surface the column value verbatim with no
// resolve-on-read seam, so a persisted signed URL is the low-coupling choice. The
// trade-off is that the URL eventually expires; we set a 10-year TTL and the URL is
// re-minted on every subsequent ingest+approval, so the live profile stays fresh.
//
// Conventions mirror the extractor (./extract.ts): the network call is injectable so
// the suite never reaches Supabase Storage, the service-role key accepts both env
// names the deployed container may provide, and failures surface as one typed error.
import { RESUMES_BUCKET } from "./extract.js";

/** Signed-URL lifetime, in seconds. ~10 years — "durable" without being permanent;
 *  re-minted on each ingest+approval so the live profile never holds a dead link. */
export const RESUME_URL_TTL_SECONDS = 10 * 365 * 24 * 60 * 60;

export class ResumeSignError extends Error {
  /** HTTP status, when the failure originated from the Storage sign call. */
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ResumeSignError";
    this.status = status;
  }
}

/** Mints a durable, resolvable URL for a `storageRef`. Injectable so tests assert the
 *  request shape without touching the network; the default hits Supabase Storage. */
export type ResumeUrlSigner = (storageRef: string) => Promise<string>;

export interface SignResumeUrlOptions {
  /** Override the signer (tests inject a fake; default hits Storage). */
  sign?: ResumeUrlSigner;
  /** Signed-URL lifetime in seconds (default {@link RESUME_URL_TTL_SECONDS}). */
  expiresIn?: number;
  // --- default-signer config (ignored when `sign` is supplied) ---
  /** Supabase project URL (default `process.env.SUPABASE_URL`). */
  supabaseUrl?: string;
  /** Service-role key (default `process.env.SUPABASE_SERVICE_ROLE_KEY`, falling back to
   *  `process.env.SUPABASE_SECRET_KEY` — the name the deployed container provides). */
  serviceRoleKey?: string;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Strip a leading `resumes/` (or `/`) so a `storageRef` becomes the object path the
 *  Storage sign API expects under the bucket. Accepts either form defensively. */
function toObjectPath(storageRef: string): string {
  let path = storageRef.replace(/^\/+/, "");
  if (path.startsWith(`${RESUMES_BUCKET}/`)) path = path.slice(RESUMES_BUCKET.length + 1);
  return path;
}

/** The default signer: a service-role POST to the Storage sign endpoint (the repo
 *  talks to Supabase over `fetch`, not supabase-js). Returns an ABSOLUTE URL — the
 *  endpoint replies with a path relative to `/storage/v1`, which we prefix. */
function defaultSigner(opts: SignResumeUrlOptions): ResumeUrlSigner {
  const expiresIn = opts.expiresIn ?? RESUME_URL_TTL_SECONDS;
  return async (storageRef) => {
    const supabaseUrl = opts.supabaseUrl ?? process.env.SUPABASE_URL;
    const serviceRoleKey =
      opts.serviceRoleKey ??
      process.env.SUPABASE_SERVICE_ROLE_KEY ??
      process.env.SUPABASE_SECRET_KEY;
    if (!supabaseUrl || !serviceRoleKey) {
      throw new ResumeSignError(
        "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) are not configured",
      );
    }
    const doFetch = opts.fetchImpl ?? fetch;
    const base = supabaseUrl.replace(/\/+$/, "");
    const objectPath = toObjectPath(storageRef);
    const url = `${base}/storage/v1/object/sign/${RESUMES_BUCKET}/${objectPath}`;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${serviceRoleKey}`,
          apikey: serviceRoleKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({ expiresIn }),
      });
    } catch (err) {
      throw new ResumeSignError(
        `could not reach Storage: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      throw new ResumeSignError(`Storage sign failed (${res.status})`, res.status);
    }
    const json = (await res.json()) as { signedURL?: unknown };
    if (typeof json.signedURL !== "string" || json.signedURL.length === 0) {
      throw new ResumeSignError("Storage sign response had no signedURL");
    }
    // The endpoint returns a path relative to `/storage/v1` (e.g. "/object/sign/...").
    const signed = json.signedURL.startsWith("/") ? json.signedURL : `/${json.signedURL}`;
    return `${base}/storage/v1${signed}`;
  };
}

/**
 * Mint a durable, resolvable URL for a résumé living in the private `resumes` bucket.
 *
 * Privacy: the caller only ever signs the `storageRef` it ingested for the
 * authenticated owner, so a user can only obtain a URL to their own résumé. Throws a
 * {@link ResumeSignError} (never a raw crash) on a missing config / non-2xx / malformed
 * response, so the ingest run can treat signing as best-effort and not fail onboarding.
 */
export async function signResumeUrl(
  storageRef: string,
  opts: SignResumeUrlOptions = {},
): Promise<string> {
  const sign = opts.sign ?? defaultSigner(opts);
  return await sign(storageRef);
}
