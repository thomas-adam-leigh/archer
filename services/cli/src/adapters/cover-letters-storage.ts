import { type CoverLetterVersion, type Db, setCoverLetterDocxRef } from "@archer/db";
import { renderCoverLetterDocx } from "./cover-letter-docx.js";

/**
 * The rendered cover-letter .docx lives in the private `cover-letters` Storage bucket
 * (migration 20260630120000), owner-foldered by user id:
 *   cover-letters/{userId}/{candidacyId}/{versionId}.docx
 * The apply adapter downloads this approved artifact and uploads it to the board as a
 * supporting document. Service-role access over the Storage REST API (the repo talks
 * to Supabase over fetch, not supabase-js — mirrors services/api/src/ingest/extract.ts).
 */

export const COVER_LETTERS_BUCKET = "cover-letters";

/** The object path (under the bucket) for a candidacy's cover-letter version. */
export function coverLetterObjectPath(
  userId: string,
  candidacyId: string,
  versionId: string,
): string {
  return `${userId}/${candidacyId}/${versionId}.docx`;
}

/** A human-friendly download filename, e.g. "Thomas Adam Leigh - Cover Letter - Acme.docx". */
export function coverLetterFileName(
  signatory: string,
  company: string | null,
  role: string,
): string {
  return `${signatory} - Cover Letter - ${company ?? role}.docx`.replace(/[\\/]/g, "-");
}

function storageConfig(): { url: string; key: string } {
  const url = process.env.SUPABASE_URL;
  // The deployed container provides SUPABASE_SECRET_KEY; accept the legacy name too.
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error(
      "cover-letters storage: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured",
    );
  }
  return { url: url.replace(/\/+$/, ""), key };
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Upload (upsert) the .docx bytes to the bucket at `objectPath`. */
export async function uploadCoverLetterDocx(objectPath: string, bytes: Buffer): Promise<void> {
  const { url, key } = storageConfig();
  const res = await fetch(`${url}/storage/v1/object/${COVER_LETTERS_BUCKET}/${objectPath}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      apikey: key,
      "content-type": DOCX_MIME,
      "x-upsert": "true",
    },
    body: new Uint8Array(bytes),
  });
  if (!res.ok) {
    throw new Error(`cover-letters storage upload failed (${res.status}): ${await res.text()}`);
  }
}

/** Download the .docx bytes from the bucket at `objectPath`. */
export async function downloadCoverLetterDocx(objectPath: string): Promise<Buffer> {
  const { url, key } = storageConfig();
  const res = await fetch(`${url}/storage/v1/object/${COVER_LETTERS_BUCKET}/${objectPath}`, {
    headers: { authorization: `Bearer ${key}`, apikey: key },
  });
  if (!res.ok) {
    throw new Error(`cover-letters storage download failed (${res.status})`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** The resolved cover-letter artifact: its bucket path, download name, and bytes. */
export interface CoverLetterDocx {
  objectPath: string;
  fileName: string;
  bytes: Buffer;
}

/**
 * Ensure the version's .docx exists in the bucket and return it. Idempotent: if the
 * version already records a docx path (e.g. rendered at approval time), download and
 * return it; otherwise render the letter, upload it, persist the ref on the version,
 * and return the fresh bytes. This is the seam the approval handler can call to move
 * rendering to approve-time — same function, earlier trigger.
 */
export async function ensureCoverLetterDocx(
  db: Db,
  version: CoverLetterVersion,
  ctx: {
    userId: string;
    candidacyId: string;
    signatory: string;
    company: string | null;
    role: string;
  },
): Promise<CoverLetterDocx> {
  const fileName = coverLetterFileName(ctx.signatory, ctx.company, ctx.role);
  const existing = (version.details as { docx?: { path?: string } } | null)?.docx?.path;
  if (existing) {
    return { objectPath: existing, fileName, bytes: await downloadCoverLetterDocx(existing) };
  }
  const bytes = await renderCoverLetterDocx(version.content, ctx.signatory);
  const objectPath = coverLetterObjectPath(ctx.userId, ctx.candidacyId, version.id);
  await uploadCoverLetterDocx(objectPath, bytes);
  await setCoverLetterDocxRef(db, version.id, { path: objectPath, fileName });
  return { objectPath, fileName, bytes };
}
