// Résumé text extraction (ARC-63) — the file → plain-text half of résumé ingest.
//
// The onboarding résumé path uploads a PDF/DOCX to the private `resumes` Storage
// bucket (ARC-62), then hands the object path to the ingest run as `storageRef`.
// This module downloads those bytes server-side via the service role and pulls out
// plain text. The TEXT it returns is the input to the LLM structuring step
// (ARC-64) that reconstructs the profile; this module owns ONLY extraction.
//
// Conventions mirror the STT core (functions/transcribe/transcribe.ts): the network
// call is injectable so the suite runs with the download MOCKED (CI never reaches
// Supabase Storage), and failures surface as one typed error rather than crashing
// the run. The PDF/DOCX parse uses pure-JS libs (unpdf wraps pdf.js; mammoth reads
// the .docx zip) — no native binaries in the API container.
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";

/** The private bucket résumés live in (provisioned in ARC-62). */
export const RESUMES_BUCKET = "resumes";
/** Byte cap — matches the bucket's `file_size_limit` (10 MiB). A larger object
 *  means the bucket policy was bypassed; refuse rather than parse it. */
export const MAX_RESUME_BYTES = 10 * 1024 * 1024;
/** Page cap for PDFs — résumés are short; a huge page count is a wrong/abuse file. */
export const MAX_RESUME_PAGES = 30;
/** Below this many non-whitespace chars the extraction is empty/garbled, not a CV. */
const MIN_TEXT_CHARS = 30;

/** The file kinds we extract. PDF is the must-have; DOCX is supported when clean. */
export type ResumeFormat = "pdf" | "docx";

export type ResumeExtractErrorCode =
  | "not_found" // download 404 / empty object
  | "download_failed" // any other non-2xx download / network failure
  | "unsupported_type" // not a PDF or DOCX (by extension, content-type, or magic bytes)
  | "too_large" // over MAX_RESUME_BYTES
  | "too_many_pages" // over MAX_RESUME_PAGES
  | "parse_failed" // the PDF/DOCX library threw
  | "empty_text"; // parsed, but no usable text came out

/** A typed failure extracting a résumé. Carries a machine-readable `code` so the
 *  caller (the ingest run, ARC-65) can branch — retry, surface, fail the run. */
export class ResumeExtractError extends Error {
  readonly code: ResumeExtractErrorCode;
  /** HTTP status, when the failure originated from the Storage download. */
  readonly status?: number;
  constructor(code: ResumeExtractErrorCode, message: string, status?: number) {
    super(message);
    this.name = "ResumeExtractError";
    this.code = code;
    this.status = status;
  }
}

/** Raw bytes pulled from storage, plus whatever content-type the store reported. */
export interface DownloadedFile {
  bytes: Uint8Array;
  contentType?: string | null;
}

/** Downloads the raw file for a `storageRef`. Injectable so tests feed fixture
 *  bytes without touching the network; the default hits Supabase Storage. */
export type ResumeDownloader = (storageRef: string) => Promise<DownloadedFile>;

export interface ExtractResumeOptions {
  /** Override the downloader (tests inject fixture bytes). */
  download?: ResumeDownloader;
  /** Original filename, used (with content-type / magic bytes) to pick the parser. */
  filename?: string | null;
  /** Byte cap (default {@link MAX_RESUME_BYTES}). */
  maxBytes?: number;
  /** PDF page cap (default {@link MAX_RESUME_PAGES}). */
  maxPages?: number;
  /** Fired once the file bytes are downloaded and size-validated, before text is
   *  parsed out — the seam the ingest run uses to stream the `extracting` phase. */
  onDownloaded?: () => void | Promise<void>;
  // --- default-downloader config (ignored when `download` is supplied) ---
  /** Supabase project URL (default `process.env.SUPABASE_URL`). */
  supabaseUrl?: string;
  /** Service-role key for the private-bucket read (default `process.env.SUPABASE_SERVICE_ROLE_KEY`,
   *  falling back to `process.env.SUPABASE_SECRET_KEY` — the name the deployed container provides). */
  serviceRoleKey?: string;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface ExtractResumeResult {
  /** The extracted plain text — the input to LLM structuring (ARC-64). */
  text: string;
  meta: {
    format: ResumeFormat;
    /** Size of the downloaded file in bytes. */
    bytes: number;
    /** Page count for PDFs (DOCX has no page model). */
    pages?: number;
    /** The filename used for format detection, when known. */
    filename?: string | null;
  };
}

/** Strip a leading `resumes/` (or `/`) so a `storageRef` becomes the object path
 *  the Storage API expects under the bucket. Accepts either form defensively. */
function toObjectPath(storageRef: string): string {
  let path = storageRef.replace(/^\/+/, "");
  if (path.startsWith(`${RESUMES_BUCKET}/`)) path = path.slice(RESUMES_BUCKET.length + 1);
  return path;
}

/** The default downloader: a service-role GET against the private bucket via the
 *  Storage REST API (the repo talks to Supabase over `fetch`, not supabase-js). */
function defaultDownloader(opts: ExtractResumeOptions): ResumeDownloader {
  return async (storageRef) => {
    const supabaseUrl = opts.supabaseUrl ?? process.env.SUPABASE_URL;
    // Accept both the legacy env name and the current one the deployed `archer-api`
    // container actually provides (`SUPABASE_SECRET_KEY`) — otherwise the private-bucket
    // read 500s in prod even though the file uploaded fine (ARC-121, mirrors auth.ts).
    const serviceRoleKey =
      opts.serviceRoleKey ??
      process.env.SUPABASE_SERVICE_ROLE_KEY ??
      process.env.SUPABASE_SECRET_KEY;
    if (!supabaseUrl || !serviceRoleKey) {
      throw new ResumeExtractError(
        "download_failed",
        "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) are not configured",
      );
    }
    const doFetch = opts.fetchImpl ?? fetch;
    const objectPath = toObjectPath(storageRef);
    const url = `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/${RESUMES_BUCKET}/${objectPath}`;
    let res: Response;
    try {
      res = await doFetch(url, {
        headers: { authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey },
      });
    } catch (err) {
      throw new ResumeExtractError(
        "download_failed",
        `could not reach Storage: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.status === 404) {
      throw new ResumeExtractError("not_found", `résumé not found at ${objectPath}`, 404);
    }
    if (!res.ok) {
      throw new ResumeExtractError(
        "download_failed",
        `Storage download failed (${res.status})`,
        res.status,
      );
    }
    const contentType = res.headers.get("content-type");
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType };
  };
}

const PDF_EXT = /\.pdf$/i;
const DOCX_EXT = /\.docx$/i;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Pick the parser from (in order) the filename extension, the content-type, then
 *  the leading magic bytes — `%PDF` for PDF, the `PK\x03\x04` zip header for DOCX. */
function detectFormat(
  bytes: Uint8Array,
  filename?: string | null,
  contentType?: string | null,
): ResumeFormat | null {
  if (filename) {
    if (PDF_EXT.test(filename)) return "pdf";
    if (DOCX_EXT.test(filename)) return "docx";
  }
  if (contentType) {
    if (contentType.includes("application/pdf")) return "pdf";
    if (contentType.includes(DOCX_MIME) || contentType.includes("officedocument")) return "docx";
  }
  if (bytes.length >= 4) {
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
      return "pdf"; // "%PDF"
    }
    if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
      return "docx"; // "PK\x03\x04" — OOXML (.docx) is a zip
    }
  }
  return null;
}

/** Collapse runs of whitespace and trim — résumé parsers emit ragged spacing. */
function normalize(text: string): string {
  return text
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

async function extractPdf(
  bytes: Uint8Array,
  maxPages: number,
): Promise<{ text: string; pages: number }> {
  let pages: number;
  let text: string;
  try {
    // pdf.js transfers (detaches) the ArrayBuffer it is given; hand it a copy so
    // the caller's bytes stay usable afterwards.
    const pdf = await getDocumentProxy(bytes.slice());
    pages = pdf.numPages;
    if (pages > maxPages) {
      throw new ResumeExtractError("too_many_pages", `PDF has ${pages} pages (max ${maxPages})`);
    }
    const extracted = await extractText(pdf, { mergePages: true });
    text = Array.isArray(extracted.text) ? extracted.text.join("\n") : extracted.text;
  } catch (err) {
    if (err instanceof ResumeExtractError) throw err;
    throw new ResumeExtractError(
      "parse_failed",
      `could not parse PDF: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { text, pages };
}

async function extractDocx(bytes: Uint8Array): Promise<string> {
  try {
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return value;
  } catch (err) {
    throw new ResumeExtractError(
      "parse_failed",
      `could not parse DOCX: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Download a résumé from the private `resumes` bucket and extract its plain text.
 *
 * Throws a {@link ResumeExtractError} (never a raw crash) for a missing file,
 * an unsupported type, an over-cap file/page-count, a parser failure, or text
 * too short to be a real résumé. The returned text feeds LLM structuring (ARC-64).
 */
export async function extractResumeText(
  storageRef: string,
  opts: ExtractResumeOptions = {},
): Promise<ExtractResumeResult> {
  const download = opts.download ?? defaultDownloader(opts);
  const maxBytes = opts.maxBytes ?? MAX_RESUME_BYTES;
  const maxPages = opts.maxPages ?? MAX_RESUME_PAGES;

  const { bytes, contentType } = await download(storageRef);
  if (bytes.length === 0) {
    throw new ResumeExtractError("not_found", "downloaded résumé is empty");
  }
  if (bytes.length > maxBytes) {
    throw new ResumeExtractError("too_large", `résumé is ${bytes.length} bytes (max ${maxBytes})`);
  }
  // The file is in hand and valid — reading is done, text extraction begins next.
  await opts.onDownloaded?.();

  const format = detectFormat(bytes, opts.filename, contentType);
  if (!format) {
    throw new ResumeExtractError(
      "unsupported_type",
      "file is not a PDF or DOCX (by extension, content-type, or signature)",
    );
  }

  let rawText: string;
  let pages: number | undefined;
  if (format === "pdf") {
    const out = await extractPdf(bytes, maxPages);
    rawText = out.text;
    pages = out.pages;
  } else {
    rawText = await extractDocx(bytes);
  }

  const text = normalize(rawText);
  if (text.replace(/\s/g, "").length < MIN_TEXT_CHARS) {
    throw new ResumeExtractError(
      "empty_text",
      "no usable text extracted (the file may be empty, scanned, or image-only)",
    );
  }

  return {
    text,
    meta: { format, bytes: bytes.length, pages, filename: opts.filename ?? null },
  };
}
