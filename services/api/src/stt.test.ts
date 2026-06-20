import { describe, expect, it } from "vitest";
import { stubTranscriber } from "./stt";

// The stubbed transcriber stands in for the audio→text STT boundary. It must be
// deterministic (same input → same payload) and carry provenance (the provider),
// so the voicenote ingest path is exercisable offline. The real provider drops in
// behind Transcriber.
describe("stubTranscriber", () => {
  it("is deterministic for the same input", () => {
    const input = { storageRef: "s3://uploads/note.m4a", filename: "note.m4a" };
    expect(stubTranscriber(input)).toEqual(stubTranscriber(input));
  });

  it("produces a non-empty transcript and a provider tag", () => {
    const t = stubTranscriber({ storageRef: "s3://uploads/note.m4a", filename: "note.m4a" });
    expect(t.transcript.length).toBeGreaterThan(0);
    expect(t.transcript).toContain("note.m4a");
    expect(t.provider).toBe("stub");
  });

  it("falls back to the storage reference when no filename is supplied", () => {
    const t = stubTranscriber({ storageRef: "s3://uploads/note.m4a" });
    expect(t.transcript).toContain("s3://uploads/note.m4a");
  });
});
