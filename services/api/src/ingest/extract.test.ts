import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractResumeText,
  MAX_RESUME_BYTES,
  RESUMES_BUCKET,
  type ResumeDownloader,
} from "./extract.js";

// Unit tests for résumé text extraction (ARC-63). The download is MOCKED — the
// suite never reaches Supabase Storage — and the parsers run against committed
// fixture files (a real 1-page PDF and a real .docx). They assert reasonable
// plain text comes out, format is detected from filename / content-type / magic
// bytes, and every failure mode surfaces as a typed ResumeExtractError.

const fixture = (name: string): Uint8Array =>
  new Uint8Array(
    readFileSync(fileURLToPath(new URL(`./__fixtures__/resumes/${name}`, import.meta.url))),
  );

const PDF = fixture("sample-resume.pdf");
const DOCX = fixture("sample-resume.docx");
const BLANK_PDF = fixture("blank.pdf");

/** A downloader that always returns the given bytes (no network). */
const serve =
  (bytes: Uint8Array, contentType?: string | null): ResumeDownloader =>
  async () => ({ bytes, contentType });

describe("extractResumeText", () => {
  it("extracts plain text from a PDF résumé", async () => {
    const { text, meta } = await extractResumeText("uid/cv.pdf", {
      download: serve(PDF),
      filename: "cv.pdf",
    });
    expect(text).toContain("Ada Lovelace");
    expect(text).toContain("PROFESSIONAL SUMMARY");
    expect(text).toContain("TypeScript");
    expect(meta.format).toBe("pdf");
    expect(meta.pages).toBe(1);
    expect(meta.bytes).toBe(PDF.length);
    expect(meta.filename).toBe("cv.pdf");
  });

  it("extracts plain text from a DOCX résumé", async () => {
    const { text, meta } = await extractResumeText("uid/cv.docx", {
      download: serve(DOCX),
      filename: "cv.docx",
    });
    expect(text).toContain("Ada Lovelace");
    expect(text).toContain("WORK EXPERIENCE");
    expect(meta.format).toBe("docx");
    expect(meta.pages).toBeUndefined();
  });

  it("detects format from magic bytes when no filename or content-type is given", async () => {
    const pdf = await extractResumeText("ref", { download: serve(PDF) });
    expect(pdf.meta.format).toBe("pdf");
    const docx = await extractResumeText("ref", { download: serve(DOCX) });
    expect(docx.meta.format).toBe("docx");
  });

  it("detects format from content-type when the filename is unhelpful", async () => {
    const { meta } = await extractResumeText("ref", {
      download: serve(PDF, "application/pdf"),
      filename: "upload.bin",
    });
    expect(meta.format).toBe("pdf");
  });

  it("rejects an unsupported file type", async () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await expect(extractResumeText("ref", { download: serve(garbage) })).rejects.toMatchObject({
      code: "unsupported_type",
    });
  });

  it("rejects an empty download as not_found", async () => {
    await expect(
      extractResumeText("ref", { download: serve(new Uint8Array(0)) }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects a file over the byte cap", async () => {
    await expect(
      extractResumeText("ref", { download: serve(PDF), maxBytes: 10 }),
    ).rejects.toMatchObject({ code: "too_large" });
  });

  it("rejects a PDF over the page cap", async () => {
    await expect(
      extractResumeText("ref", { download: serve(PDF), maxPages: 0 }),
    ).rejects.toMatchObject({ code: "too_many_pages" });
  });

  it("rejects a valid-but-textless PDF as empty_text", async () => {
    // A real, parseable PDF whose only content is whitespace — parsing succeeds
    // but yields no usable text (the scanned/image-only case).
    await expect(
      extractResumeText("ref", { download: serve(BLANK_PDF), filename: "blank.pdf" }),
    ).rejects.toMatchObject({ code: "empty_text" });
  });

  it("surfaces a parser failure as parse_failed (corrupt PDF)", async () => {
    const corrupt = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x33, 0x0a, 0x00]); // "%PDF-1.3" + junk
    await expect(
      extractResumeText("ref", { download: serve(corrupt), filename: "broken.pdf" }),
    ).rejects.toMatchObject({ code: "parse_failed" });
  });
});

describe("default Storage downloader", () => {
  const env = { supabaseUrl: "https://proj.supabase.co", serviceRoleKey: "svc-key" };

  it("GETs the bucket object with the service-role key and strips the bucket prefix", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(PDF, { status: 200, headers: { "content-type": "application/pdf" } }),
    ) as unknown as typeof fetch;
    const { meta } = await extractResumeText(`${RESUMES_BUCKET}/uid/cv.pdf`, {
      ...env,
      fetchImpl,
      filename: "cv.pdf",
    });
    expect(meta.format).toBe("pdf");
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://proj.supabase.co/storage/v1/object/resumes/uid/cv.pdf");
    expect((init as RequestInit).headers).toMatchObject({
      authorization: "Bearer svc-key",
      apikey: "svc-key",
    });
  });

  it("maps a 404 to not_found", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("", { status: 404 }),
    ) as unknown as typeof fetch;
    await expect(extractResumeText("uid/missing.pdf", { ...env, fetchImpl })).rejects.toMatchObject(
      { code: "not_found", status: 404 },
    );
  });

  it("maps other non-2xx to download_failed", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("", { status: 500 }),
    ) as unknown as typeof fetch;
    await expect(extractResumeText("uid/cv.pdf", { ...env, fetchImpl })).rejects.toMatchObject({
      code: "download_failed",
      status: 500,
    });
  });

  it("fails closed when Supabase config is missing", async () => {
    await expect(
      extractResumeText("uid/cv.pdf", { supabaseUrl: "", serviceRoleKey: "" }),
    ).rejects.toMatchObject({ code: "download_failed" });
  });

  it("exposes the byte cap as a constant matching the bucket limit", () => {
    expect(MAX_RESUME_BYTES).toBe(10 * 1024 * 1024);
  });
});

// The default downloader resolves its config from env when no opts are supplied.
// `fetch` is mocked, so no live call — we assert the service-role key is resolved
// from the env-var names the deployed `archer-api` container provides (ARC-121).
describe("default Storage downloader — env-var key resolution (ARC-121)", () => {
  const KEY_ENVS = ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY"];

  beforeEach(() => {
    process.env.SUPABASE_URL = "https://proj.supabase.co";
    for (const k of KEY_ENVS) delete process.env[k];
  });
  afterEach(() => {
    delete process.env.SUPABASE_URL;
    for (const k of KEY_ENVS) delete process.env[k];
  });

  const servePdf = () =>
    vi.fn(
      async () =>
        new Response(PDF, { status: 200, headers: { "content-type": "application/pdf" } }),
    ) as unknown as typeof fetch;

  it("resolves the service-role key from SUPABASE_SECRET_KEY when SUPABASE_SERVICE_ROLE_KEY is unset", async () => {
    process.env.SUPABASE_SECRET_KEY = "secret-key-value";
    const fetchImpl = servePdf();
    const { meta } = await extractResumeText("uid/cv.pdf", { fetchImpl, filename: "cv.pdf" });
    expect(meta.format).toBe("pdf");
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({
      authorization: "Bearer secret-key-value",
      apikey: "secret-key-value",
    });
  });

  it("prefers SUPABASE_SERVICE_ROLE_KEY when both env names are set", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-value";
    process.env.SUPABASE_SECRET_KEY = "secret-key-value";
    const fetchImpl = servePdf();
    await extractResumeText("uid/cv.pdf", { fetchImpl, filename: "cv.pdf" });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ apikey: "service-role-value" });
  });

  it("fails closed when neither key env is set", async () => {
    await expect(extractResumeText("uid/cv.pdf", { filename: "cv.pdf" })).rejects.toMatchObject({
      code: "download_failed",
    });
  });
});
