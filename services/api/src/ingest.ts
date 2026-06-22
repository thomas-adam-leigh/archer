// Résumé / portfolio ingest: the file → structured-profile-draft boundary.
//
// This composes the two real halves of ingestion, replacing the old deterministic
// stub:
//   1. ARC-63 — download the uploaded file from the private `resumes` bucket and
//      extract plain text (./ingest/extract.ts).
//   2. ARC-64 — structure that text into a profile DRAFT (profile-wide `attributes`
//      + the typed spine) with the real, swappable LLM (./ingest/structure.ts).
// The result is a PROPOSED profile_version's content; the route persists it through
// ingestProposedVersion → the existing proposal/apply path (never the live profile).
// Both halves are mockable at their own seams (an injected downloader / LLM
// provider), so CI never reaches Supabase Storage or a live model.
import type { Json, ProfileSpineDraft } from "@archer/db";
import type { LlmProvider } from "@archer/llm";
import { extractResumeText, type ResumeDownloader } from "./ingest/extract.js";
import { structureResume } from "./ingest/structure.js";

/** What kind of upload is being ingested. Both flow through the same path. */
export type IngestKind = "resume" | "portfolio";

/** The structured content extracted from an uploaded file. `attributes` becomes the
 *  proposed version's profile-wide snapshot, `spine` its version-scoped child rows,
 *  and `details` carries extraction provenance. */
export interface Extraction {
  /** Profile-wide attributes (full_name, email, links, summary, …) the version snapshots. */
  attributes: Record<string, Json>;
  /** The reconstructed structured spine (work_experiences, education, skills, …). */
  spine: ProfileSpineDraft;
  /** Extractor provenance + metadata, stored on the version's `details` jsonb. */
  details: Record<string, Json>;
}

/** A reference to the already-uploaded raw file (a storage path), not bytes — the
 *  bytes are pulled server-side from the private bucket by the extractor (ARC-63). */
export interface ExtractorInput {
  kind: IngestKind;
  storageRef: string;
  filename?: string | null;
}

export interface ResumeExtractOptions {
  /** Override the Storage downloader (tests feed fixture bytes; default hits Storage). */
  download?: ResumeDownloader;
  /** Override the LLM provider (tests inject a deterministic mock). */
  llm?: LlmProvider;
}

/**
 * Extract an uploaded résumé/portfolio into a structured profile draft: pull plain
 * text from the file (ARC-63), then structure it into attributes + spine via the
 * LLM (ARC-64). Both extraction failures (download/parse) and structuring failures
 * surface as their typed errors; the caller (the ingest run, ARC-65) handles them.
 */
export async function extractResume(
  input: ExtractorInput,
  opts: ResumeExtractOptions = {},
): Promise<Extraction> {
  const { text, meta } = await extractResumeText(input.storageRef, {
    download: opts.download,
    filename: input.filename,
  });
  const { attributes, spine, model } = await structureResume(text, { llm: opts.llm });
  return {
    attributes,
    spine,
    details: {
      source: input.kind,
      storageRef: input.storageRef,
      filename: input.filename ?? null,
      extractor: "llm",
      model,
      format: meta.format,
      pages: meta.pages ?? null,
      bytes: meta.bytes,
      // Keep the extracted text on the proposed version so a later feedback-driven
      // revision can re-use it instead of rebuilding from feedback alone (ARC-85).
      // It's the text already produced above — we never re-store the raw file.
      resumeText: text,
    },
  };
}
