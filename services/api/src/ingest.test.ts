import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMockProvider } from "@archer/llm";
import { describe, expect, it } from "vitest";
import type { ResumeDownloader } from "./ingest/extract.js";
import { extractResume } from "./ingest.js";

// Composition test for résumé ingest: file → text (ARC-63) → structured draft
// (ARC-64). The Storage download is MOCKED (a committed PDF fixture, no network)
// and the LLM is MOCKED (a fixed JSON reply), so the whole file→draft path is
// exercised deterministically with no Storage and no live model.

const fixture = (name: string): Uint8Array =>
  new Uint8Array(
    readFileSync(fileURLToPath(new URL(`./ingest/__fixtures__/resumes/${name}`, import.meta.url))),
  );

const PDF = fixture("sample-resume.pdf");

/** A downloader that always returns the given bytes (no network). */
const serve =
  (bytes: Uint8Array): ResumeDownloader =>
  async () => ({ bytes, contentType: "application/pdf" });

const STRUCTURED = JSON.stringify({
  attributes: { fullName: "Ada Lovelace", summary: "Engineer." },
  workExperiences: [{ title: "Lead Engineer", organization: "Engines Ltd", isCurrent: true }],
  skills: [{ name: "TypeScript" }],
});

describe("extractResume", () => {
  it("composes text extraction + LLM structuring into attributes, spine, and provenance", async () => {
    const extraction = await extractResume(
      { kind: "resume", storageRef: "uid/cv.pdf", filename: "cv.pdf" },
      { download: serve(PDF), llm: createMockProvider({ reply: () => STRUCTURED }) },
    );

    expect(extraction.attributes).toMatchObject({
      full_name: "Ada Lovelace",
      summary: "Engineer.",
    });
    expect(extraction.spine.workExperiences?.[0]).toMatchObject({ title: "Lead Engineer" });
    expect(extraction.spine.skills?.[0].name).toBe("TypeScript");

    // Provenance records the real extractor + the source/format/model, not "stub".
    expect(extraction.details).toMatchObject({
      source: "resume",
      storageRef: "uid/cv.pdf",
      filename: "cv.pdf",
      extractor: "llm",
      model: "mock-model",
      format: "pdf",
    });
    expect(extraction.details.bytes).toBeGreaterThan(0);
    // The extracted text is kept on the version so a later revision can re-use it (ARC-85).
    expect(typeof extraction.details.resumeText).toBe("string");
    expect((extraction.details.resumeText as string).length).toBeGreaterThan(0);
  });

  it("fires onPhase in order — reading (pre-download) → extracting (post-read) → building (pre-LLM)", async () => {
    const phases: string[] = [];
    await extractResume(
      { kind: "resume", storageRef: "uid/cv.pdf", filename: "cv.pdf" },
      {
        download: serve(PDF),
        llm: createMockProvider({ reply: () => STRUCTURED }),
        onPhase: (p) => {
          phases.push(p);
        },
      },
    );
    expect(phases).toEqual(["reading", "extracting", "building"]);
  });

  it("propagates a text-extraction failure (unsupported file) before the LLM runs", async () => {
    // No filename, no content-type, non-PDF/DOCX magic bytes → unsupported_type.
    const notADoc: ResumeDownloader = async () => ({
      bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      contentType: null,
    });
    await expect(
      extractResume(
        { kind: "resume", storageRef: "uid/x.bin" },
        { download: notADoc, llm: createMockProvider({ reply: () => STRUCTURED }) },
      ),
    ).rejects.toThrow(/PDF or DOCX/);
  });
});
