// Conversational onboarding: the gathered conversation → structured profile draft.
//
// The "start from scratch" path (ARC-79): instead of a résumé file, the candidate
// answers Archer's questions over a multi-turn conversation (driven by the real
// brain via /agui/run). This module is the FINALIZE step — it folds that
// conversation transcript into the same structured draft the résumé path produces
// (profile-wide `attributes` + the typed spine), reusing the résumé structurer's
// schema, builders, and JSON extraction (`structureProfileText`) with an
// onboarding-tuned system prompt. The caller persists the result as a PROPOSED
// profile_version (incl. spine) so both paths converge on the shared review.
//
// Like the résumé structurer, the LLM is mockable at its seam, so CI never reaches
// a live model.
import type { ProfileSpineDraft } from "@archer/db";
import type { LlmProvider } from "@archer/llm";
import type { RestoredMessage } from "../agui.js";
import { type StructuredResume, structureProfileText } from "../ingest/structure.js";

/** The onboarding-conversation reader. Same JSON contract as the résumé parser, but
 *  framed for a Q&A transcript: read the CANDIDATE's answers, never the questions,
 *  and never invent anything they didn't say. */
const SYSTEM_PROMPT = `You are an onboarding assistant building a candidate's professional profile from a conversation transcript between Archer (the assistant) and the candidate. Reconstruct the profile as STRICT JSON.

Return ONLY a single JSON object (no markdown, no commentary) with this shape:
{
  "attributes": { "fullName": string|null, "email": string|null, "phone": string|null, "location": string|null, "summary": string|null, "links": { "linkedin": string|null, "github": string|null, "website": string|null } },
  "workExperiences": [ { "title": string, "organization": string|null, "employmentType": string|null, "location": string|null, "startDate": "YYYY-MM-DD"|null, "endDate": "YYYY-MM-DD"|null, "isCurrent": boolean, "description": string|null } ],
  "education": [ { "institution": string, "degree": string|null, "fieldOfStudy": string|null, "startDate": "YYYY-MM-DD"|null, "endDate": "YYYY-MM-DD"|null, "grade": string|null } ],
  "skills": [ { "name": string, "category": string|null, "proficiency": string|null, "yearsExperience": number|null } ],
  "certifications": [ { "name": string, "issuer": string|null, "issuedOn": "YYYY-MM-DD"|null, "expiresOn": "YYYY-MM-DD"|null, "credentialId": string|null, "url": string|null } ],
  "courses": [ { "name": string, "provider": string|null, "completedOn": "YYYY-MM-DD"|null, "url": string|null } ],
  "projects": [ { "name": string, "role": string|null, "url": string|null, "startDate": "YYYY-MM-DD"|null, "endDate": "YYYY-MM-DD"|null, "description": string|null } ]
}

Rules:
- Use ONLY what the candidate said. NEVER invent employers, schools, dates, or skills they did not mention.
- Leave anything not stated as null, and omit list items you cannot fill (empty arrays are fine).
- Dates: use YYYY-MM-DD; if only a month or year is given, use the first of that period. Mark a role with no end date as "isCurrent": true.
- Output JSON only.`;

/** Render restored thread messages as a labelled Q&A transcript for the structurer:
 *  assistant turns become `Archer:` lines, everything else `Candidate:`. Blank turns
 *  are skipped so an empty greeting never adds noise. */
export function buildTranscript(messages: RestoredMessage[]): string {
  return messages
    .map((m) => {
      const content = m.content?.trim();
      if (!content) return null;
      const speaker = m.role === "assistant" ? "Archer" : "Candidate";
      return `${speaker}: ${content}`;
    })
    .filter((line): line is string => line !== null)
    .join("\n");
}

/** Whether a structured spine has any rows worth persisting (all lists empty → no
 *  spine writer call needed). */
export function hasSpine(spine: ProfileSpineDraft): boolean {
  return Object.values(spine).some((rows) => Array.isArray(rows) && rows.length > 0);
}

export interface StructureConversationOptions {
  /** Override the LLM provider (tests inject a deterministic mock). */
  llm?: LlmProvider;
}

/**
 * Structure an onboarding conversation transcript into a profile draft (attributes +
 * spine) via the LLM — the conversational sibling of `structureResume`. Reuses the
 * shared structurer with the onboarding-conversation prompt; throws
 * {@link import("../ingest/structure.js").ResumeStructureError} when the model
 * returns no parseable JSON.
 */
export function structureConversation(
  transcript: string,
  opts: StructureConversationOptions = {},
): Promise<StructuredResume> {
  return structureProfileText(transcript, { llm: opts.llm, systemPrompt: SYSTEM_PROMPT });
}
