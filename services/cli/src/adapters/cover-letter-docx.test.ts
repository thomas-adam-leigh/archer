import { describe, expect, it } from "vitest";
import { renderCoverLetterDocx, signCoverLetter } from "./cover-letter-docx.js";

describe("signCoverLetter", () => {
  const name = "Thomas Adam Leigh";

  it("appends the signatory after a 'Kind regards,' sign-off", () => {
    const out = signCoverLetter("Dear Team,\n\nI'm keen.\n\nKind regards,", name);
    expect(out.endsWith("Kind regards,\nThomas Adam Leigh")).toBe(true);
  });

  it("is idempotent when the name is already the last line (case-insensitive)", () => {
    const already = "Dear Team,\n\nKind regards,\nThomas Adam Leigh";
    expect(signCoverLetter(already, name)).toBe(already);
    expect(signCoverLetter("Kind regards,\nthomas adam leigh", name)).toBe(
      "Kind regards,\nthomas adam leigh",
    );
  });

  it("trims trailing whitespace before appending", () => {
    expect(signCoverLetter("Kind regards,\n\n  ", name)).toBe("Kind regards,\nThomas Adam Leigh");
  });
});

describe("renderCoverLetterDocx", () => {
  it("produces a non-empty OOXML (zip) buffer", async () => {
    const buf = await renderCoverLetterDocx(
      "Dear Team,\n\nI'm keen.\n\nKind regards,",
      "Thomas Adam Leigh",
    );
    expect(buf.length).toBeGreaterThan(1000);
    // .docx is a zip archive — must start with the PK local-file-header magic.
    expect(buf.subarray(0, 2).toString("latin1")).toBe("PK");
  });
});
