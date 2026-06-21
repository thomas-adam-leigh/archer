// Spoken-note generation: the cover-letter text → audio (text-to-speech) boundary.
//
// The real synthesis is an assumed-working/stubbed provider boundary (ElevenLabs
// turns Archer's note about a cover letter into audio the client plays aloud).
// This module is the seam: `Synthesizer` is the interface the real provider drops
// in behind, and `stubSynthesizer` is a deterministic stand-in so the whole
// spoken-note path (route → activity → artifact on the version) is testable offline
// with no audio IO. Like stt.ts's stubTranscriber, the stub is a pure function:
// same input → same artifact.

/** The spoken-note artifact for one cover-letter version. `audioUrl` is the stored
 *  audio the client plays; `provider` is recorded for provenance; `durationMs` is
 *  the clip length. Persisted on the cover-letter version's `details` jsonb. */
export interface SpokenNote {
  /** A reference to the stored audio (a storage path/URL) the client plays aloud. */
  audioUrl: string;
  /** Which TTS provider produced it ("stub" until ElevenLabs lands). */
  provider: string;
  /** The clip length in milliseconds, derived from the spoken script. */
  durationMs: number;
}

/** The script to speak plus the version it belongs to. Bytes never reach this
 *  service: the stub does not synthesize audio, and the real provider streams the
 *  result into storage and returns its reference. */
export interface SynthesizerInput {
  /** The cover-letter version the spoken note is for (keys the artifact ref). */
  versionId: string;
  /** The text Archer speaks aloud (the note about the cover letter). */
  text: string;
}

/** The synthesis interface. The real ElevenLabs provider implements this; the stub
 *  below stands in until it lands. Keeping it a plain function type makes the swap
 *  a one-line change in the route with no contract churn. */
export type Synthesizer = (input: SynthesizerInput) => SpokenNote;

/** Average speaking rate used to derive a plausible, deterministic clip length
 *  from the script's word count (no audio is produced). */
const WORDS_PER_MINUTE = 150;

/**
 * A deterministic stub synthesizer. It does NOT produce audio — it returns a fixed,
 * version-keyed artifact reference and a script-derived duration so the spoken-note
 * orchestration (activity + artifact on the version) can be exercised end to end
 * without ElevenLabs or any audio IO. Swap in the real synthesizer behind
 * `Synthesizer` later; the rest of the path is unchanged.
 */
export const stubSynthesizer: Synthesizer = ({ versionId, text }) => {
  const words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
  return {
    audioUrl: `stub://spoken-notes/${versionId}.mp3`,
    provider: "stub",
    durationMs: Math.round((words / WORDS_PER_MINUTE) * 60_000),
  };
};
