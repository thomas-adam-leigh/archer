import { describe, expect, it } from "vitest";
import { stubSynthesizer } from "./tts";

// The TTS (text-to-speech) seam: Archer's spoken note for a cover letter. The real
// ElevenLabs synthesis drops in behind `Synthesizer`; `stubSynthesizer` is the
// deterministic, network-free stand-in (mirroring stt.ts's stubTranscriber) so the
// spoken-note path (route → activity → artifact on the version) is testable offline.
describe("stubSynthesizer", () => {
  const versionId = "11111111-1111-4111-8111-111111111111";

  it("produces a deterministic spoken-note artifact (same input → same output)", () => {
    const a = stubSynthesizer({ versionId, text: "Hello from Archer." });
    const b = stubSynthesizer({ versionId, text: "Hello from Archer." });
    expect(a).toEqual(b);
  });

  it("records a stub provider and an audio URL that references the version", () => {
    const note = stubSynthesizer({ versionId, text: "A short note." });
    expect(note.provider).toBe("stub");
    expect(note.audioUrl).toContain(versionId);
    expect(note.audioUrl).toMatch(/\.mp3$/);
  });

  it("derives a non-zero duration that scales with the script length", () => {
    const short = stubSynthesizer({ versionId, text: "one two three" });
    const long = stubSynthesizer({
      versionId,
      text: "one two three four five six seven eight nine ten eleven twelve",
    });
    expect(short.durationMs).toBeGreaterThan(0);
    expect(long.durationMs).toBeGreaterThan(short.durationMs);
  });
});
