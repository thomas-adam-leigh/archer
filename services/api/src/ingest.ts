// Resume / portfolio ingest: the file → structured-profile extraction boundary.
//
// The real extraction is the assumed-working/stubbed CLI boundary (the `archer`
// CLI parses an uploaded file into structured profile content). This module is
// the seam: `ResumeExtractor` is the interface the real extractor drops in behind,
// and `stubResumeExtractor` is a deterministic stand-in so the whole ingest path
// (route → proposed version → approval) is testable offline with no CLI/file IO.
//
// Like agui.ts's runStub, the stub is a pure function: same input → same payload.
import type { Json } from "@archer/db";

/** What kind of upload is being ingested. Both flow through the same path. */
export type IngestKind = "resume" | "portfolio";

/** The structured content an extractor pulls out of a file. `attributes` becomes
 *  the proposed version's profile-wide snapshot; `details` carries provenance. */
export interface Extraction {
  /** Profile-wide attributes (ideal_job, your-story, …) the version snapshots. */
  attributes: Record<string, Json>;
  /** Extractor provenance + metadata, stored on the version's `details` jsonb. */
  details: Record<string, Json>;
}

/** A reference to the already-uploaded raw file (a storage path/URL), not bytes —
 *  bytes never reach this service; the CLI extractor reads them out of storage. */
export interface ExtractorInput {
  kind: IngestKind;
  storageRef: string;
  filename?: string | null;
}

/** The extraction interface. The real CLI extractor implements this; the stub
 *  below stands in until it lands. Keeping it a plain function type makes the
 *  swap a one-line change in the route with no contract churn. */
export type ResumeExtractor = (input: ExtractorInput) => Extraction;

/**
 * A deterministic stub extractor. It does NOT read the file — it produces a fixed,
 * input-echoing payload so the ingest orchestration (activity + proposed version +
 * proposal) can be exercised end to end without the CLI or any file IO. Swap in the
 * real CLI extractor behind `ResumeExtractor` later; the rest of the path is unchanged.
 */
export const stubResumeExtractor: ResumeExtractor = ({ kind, storageRef, filename }) => {
  const attributes: Record<string, Json> =
    kind === "portfolio"
      ? {
          your_story: "Portfolio of shipped work spanning product and engineering.",
          ideal_job: "A role where I own outcomes end to end.",
        }
      : {
          ideal_job: "A role where I ship product end to end.",
          why: "I do my best work close to users, owning outcomes.",
          ai_fluency: "Comfortable building with LLMs and agentic tools day to day.",
        };
  return {
    attributes,
    details: {
      source: kind,
      storageRef,
      filename: filename ?? null,
      extractor: "stub",
    },
  };
};
