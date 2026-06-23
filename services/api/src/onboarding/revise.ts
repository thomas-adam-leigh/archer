// Feedback-aware draft revision: current draft + feedback → amended draft (ARC-85).
//
// The review screen's feedback/redraft loop (ARC-77) needs a way to revise an
// EXISTING proposed profile draft from the candidate's feedback — without blanking
// what's already there. The single-shot structurers (résumé / conversation) rebuild
// from their source alone, so feeding them only the feedback would wipe the draft.
//
// This module reuses the shared structurer (`structureProfileText`) with a revise-
// tuned system prompt, but frames the user turn as: the CURRENT draft (to amend) +
// the original SOURCE material (résumé text or the conversation, re-used so still-true
// facts survive) + the candidate's FEEDBACK. It yields the same StructuredResume
// (attributes + spine) the other paths produce, so the caller persists it as a new
// PROPOSED version through the existing proposal/apply path. LLM mockable at its seam.
import type { Json, ProfileSpineDraft } from "@archer/db";
import type { LlmProvider } from "@archer/llm";
import { type StructuredResume, structureProfileText } from "../ingest/structure.js";

/** The reviser amends rather than rebuilds: it starts from the current draft and the
 *  source it came from, and applies the feedback as a diff — keeping anything the
 *  feedback doesn't touch. Same JSON contract as the résumé/conversation structurers. */
const SYSTEM_PROMPT = `You are revising a candidate's professional profile. You are given their CURRENT profile draft, the SOURCE material it was built from, and the candidate's FEEDBACK. Apply the feedback and return the full, updated profile as STRICT JSON.

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
- Return the WHOLE profile, not just the change: carry forward every field the feedback does not ask you to change. NEVER blank out existing experience, education, skills, or attributes the candidate didn't ask to remove.
- Apply the feedback faithfully — add, edit, re-order, or remove only what it asks for.
- Use ONLY the source, the current draft, and the feedback. NEVER invent employers, schools, dates, or skills not present in them.
- Dates: use YYYY-MM-DD; if only a month or year is given, use the first of that period. Mark a role with no end date as "isCurrent": true.
- Output JSON only.`;

export interface ReviseDraftInput {
  /** The current proposed draft to amend: its profile-wide attributes + typed spine. */
  current: { attributes: Record<string, Json>; spine: ProfileSpineDraft };
  /** The candidate's feedback (typed, or voice transcribed client-side). */
  feedback: string;
  /** The original source the draft was built from — résumé text or the conversation
   *  transcript — re-used so the revision keeps facts the feedback doesn't touch.
   *  Absent when there is no retained source (the model works from the draft alone). */
  source?: string;
}

export interface ReviseDraftOptions {
  /** Override the LLM provider (tests inject a deterministic mock). */
  llm?: LlmProvider;
}

const norm = (v: string | null | undefined): string => (v ?? "").trim().toLowerCase();
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does the candidate's feedback mention this item by one of its identifying names
 *  (title, organisation, institution, or name)? Matched on whole words so a short
 *  name like "Go" isn't found inside "good". If the feedback names an item, the
 *  candidate's instruction acted on it (an edit or a removal), so we trust the model's
 *  output for it; if it names it nowhere, a missing item can only be a silent model
 *  drop — and {@link reconcileSpine} re-attaches it. */
function feedbackMentions(feedback: string, names: (string | null | undefined)[]): boolean {
  return names.some((n) => {
    const t = (n ?? "").trim();
    if (t.length < 2) return false;
    return new RegExp(`\\b${escapeRegExp(t)}\\b`, "i").test(feedback);
  });
}

/** Re-attach any item present in `prior` but missing from `revised` that the feedback
 *  never named — those can only have been dropped silently by the model. `identity`
 *  matches a prior item to a surviving revised one (so edits in place don't duplicate);
 *  `names` yields the strings the feedback would use to refer to it. Dropped survivors
 *  are appended after the revised items (explicit ordering is ARC-134's concern). */
function reconcileList<T>(
  prior: T[] | undefined,
  revised: T[] | undefined,
  feedback: string,
  identity: (item: T) => string,
  names: (item: T) => (string | null | undefined)[],
): T[] | undefined {
  if (!prior?.length) return revised;
  const present = new Set((revised ?? []).map(identity));
  const dropped = prior.filter(
    (item) => !present.has(identity(item)) && !feedbackMentions(feedback, names(item)),
  );
  if (dropped.length === 0) return revised;
  return [...(revised ?? []), ...dropped];
}

function setList<K extends keyof ProfileSpineDraft>(
  out: ProfileSpineDraft,
  key: K,
  list: ProfileSpineDraft[K] | undefined,
): void {
  if (list && (list as unknown[]).length > 0) out[key] = list;
  else delete out[key];
}

/**
 * Reconcile a model-revised spine against the draft it was revising so a revision can
 * **never silently drop** items the candidate didn't ask to change (ARC-135). The LLM
 * is told to return the whole profile, but a shorter list (e.g. 2 of 4 certifications)
 * would otherwise persist as data loss. For every spine list, any prior item missing
 * from the revision that the feedback never named is re-attached; items the feedback
 * named (edited or removed) are left to the model. Attributes are profile-wide and
 * carried by the structurer's own "never blank" prompt, so only the spine is repaired.
 */
export function reconcileSpine(
  prior: ProfileSpineDraft,
  revised: ProfileSpineDraft,
  feedback: string,
): ProfileSpineDraft {
  const out: ProfileSpineDraft = { ...revised };
  setList(
    out,
    "workExperiences",
    reconcileList(
      prior.workExperiences,
      revised.workExperiences,
      feedback,
      (w) => `${norm(w.title)}|${norm(w.organization)}`,
      (w) => [w.title, w.organization],
    ),
  );
  setList(
    out,
    "education",
    reconcileList(
      prior.education,
      revised.education,
      feedback,
      (e) => `${norm(e.institution)}|${norm(e.degree)}`,
      (e) => [e.institution, e.degree],
    ),
  );
  setList(
    out,
    "skills",
    reconcileList(
      prior.skills,
      revised.skills,
      feedback,
      (s) => norm(s.name),
      (s) => [s.name],
    ),
  );
  setList(
    out,
    "certifications",
    reconcileList(
      prior.certifications,
      revised.certifications,
      feedback,
      (c) => norm(c.name),
      (c) => [c.name],
    ),
  );
  setList(
    out,
    "courses",
    reconcileList(
      prior.courses,
      revised.courses,
      feedback,
      (c) => norm(c.name),
      (c) => [c.name],
    ),
  );
  setList(
    out,
    "projects",
    reconcileList(
      prior.projects,
      revised.projects,
      feedback,
      (p) => norm(p.name),
      (p) => [p.name],
    ),
  );
  return out;
}

/** Frame the revise turn for the structurer: the current draft (as JSON), the source
 *  material it came from, and the feedback to apply — clearly labelled sections so the
 *  model amends rather than rebuilds. */
export function buildRevisionPrompt({ current, feedback, source }: ReviseDraftInput): string {
  return [
    "CURRENT PROFILE DRAFT (the profile to revise), as JSON:",
    JSON.stringify({ attributes: current.attributes, ...current.spine }),
    "",
    "SOURCE MATERIAL it was built from (re-use it; do not discard facts still true):",
    source?.trim() ? source.trim() : "(none retained)",
    "",
    "CANDIDATE FEEDBACK to apply:",
    feedback.trim(),
  ].join("\n");
}

/**
 * Revise a proposed profile draft from the candidate's feedback (ARC-85) — the
 * feedback-aware sibling of `structureResume` / `structureConversation`. Reuses the
 * shared structurer with a revise prompt that carries the current draft forward and
 * applies the feedback as a diff, so the result amends the draft rather than blanking
 * it. Throws {@link import("../ingest/structure.js").ResumeStructureError} when the
 * model returns no parseable JSON.
 *
 * The model's spine is reconciled against the draft being revised so the revision can
 * never silently lose items the feedback didn't touch ({@link reconcileSpine}, ARC-135).
 */
export async function reviseDraft(
  input: ReviseDraftInput,
  opts: ReviseDraftOptions = {},
): Promise<StructuredResume> {
  const result = await structureProfileText(buildRevisionPrompt(input), {
    llm: opts.llm,
    systemPrompt: SYSTEM_PROMPT,
  });
  return { ...result, spine: reconcileSpine(input.current.spine, result.spine, input.feedback) };
}
