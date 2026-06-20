import { describe, expect, it } from "vitest";
import { stubResumeExtractor } from "./ingest";

// The stubbed extractor stands in for the CLI file→content boundary. It must be
// deterministic (same input → same payload) and carry provenance, so the ingest
// path is exercisable offline. The real extractor drops in behind ResumeExtractor.
describe("stubResumeExtractor", () => {
  it("is deterministic for the same input", () => {
    const input = {
      kind: "resume" as const,
      storageRef: "s3://uploads/cv.pdf",
      filename: "cv.pdf",
    };
    expect(stubResumeExtractor(input)).toEqual(stubResumeExtractor(input));
  });

  it("echoes provenance (source, storageRef, filename) onto details", () => {
    const e = stubResumeExtractor({
      kind: "resume",
      storageRef: "s3://uploads/cv.pdf",
      filename: "cv.pdf",
    });
    expect(e.details).toMatchObject({
      source: "resume",
      storageRef: "s3://uploads/cv.pdf",
      filename: "cv.pdf",
      extractor: "stub",
    });
    expect(Object.keys(e.attributes).length).toBeGreaterThan(0);
  });

  it("records a null filename when none is supplied", () => {
    const e = stubResumeExtractor({ kind: "resume", storageRef: "s3://uploads/cv.pdf" });
    expect(e.details.filename).toBeNull();
  });

  it("produces a portfolio-specific payload for kind 'portfolio'", () => {
    const e = stubResumeExtractor({ kind: "portfolio", storageRef: "s3://uploads/site.zip" });
    expect(e.details.source).toBe("portfolio");
    expect(e.attributes).toHaveProperty("your_story");
  });
});
