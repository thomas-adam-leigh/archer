// Voicenote ingest: the audio → transcript (speech-to-text) boundary.
//
// The real transcription is an assumed-working/stubbed provider boundary (e.g.
// the `archer` CLI or an STT API turns an uploaded audio file into text). This
// module is the seam: `Transcriber` is the interface the real provider drops in
// behind, and `stubTranscriber` is a deterministic stand-in so the whole ingest
// path (route → activity → transcript message) is testable offline with no audio
// IO. Like ingest.ts's stubResumeExtractor, the stub is a pure function: same
// input → same payload.

/** The result of transcribing one voicenote. `transcript` becomes a tier-2
 *  message; `provider` is recorded for provenance on the activity. */
export interface Transcription {
  /** The transcribed text, persisted as the thread's transcript message. */
  transcript: string;
  /** Which STT provider produced it ("stub" until the real one lands). */
  provider: string;
}

/** A reference to the already-uploaded raw audio (a storage path/URL), not bytes —
 *  bytes never reach this service; the real transcriber reads them out of storage. */
export interface TranscriberInput {
  storageRef: string;
  filename?: string | null;
}

/** The transcription interface. The real STT provider implements this; the stub
 *  below stands in until it lands. Keeping it a plain function type makes the swap
 *  a one-line change in the route with no contract churn. */
export type Transcriber = (input: TranscriberInput) => Transcription;

/**
 * A deterministic stub transcriber. It does NOT read the audio — it produces a
 * fixed, input-echoing transcript so the ingest orchestration (activity +
 * transcript message) can be exercised end to end without any STT provider or
 * audio IO. Swap in the real transcriber behind `Transcriber` later; the rest of
 * the path is unchanged.
 */
export const stubTranscriber: Transcriber = ({ storageRef, filename }) => ({
  transcript: `[transcribed voicenote] ${filename ?? storageRef}`,
  provider: "stub",
});
