// Job-title suggestion (ARC-68).
//
// From the candidate's populated profile (the version `attributes` snapshot plus
// the structured spine), propose ~5 ranked TARGET job titles to search on, using
// the real, swappable LLM (@archer/llm; MiniMax by default, mock in tests). The
// candidate can re-rank/redirect by feedback, so this re-suggests as a pure read;
// only an explicit approve persists the chosen set to `target_titles` (the route).
import type { Json, ProfileSpineDraft } from "@archer/db";
import { type LlmProvider, resolveLlm } from "@archer/llm";
import { z } from "zod";

/** A suggestion failure (model returned no/invalid JSON, or zero usable titles). */
export class TitleSuggestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TitleSuggestionError";
  }
}

/** The populated profile the suggester reasons over: the version's profile-wide
 *  `attributes` snapshot plus its structured spine (read via readProfileSpine). */
export interface SuggestTitlesProfile {
  attributes: Json;
  spine: ProfileSpineDraft;
}

export interface SuggestTitlesOptions {
  /** The candidate's free-text feedback to fold in ("more senior", "drop QA"…). */
  feedback?: string;
  /** The titles currently shown the candidate, so feedback can re-rank/refine them. */
  current?: string[];
  /** Cap on how many titles to return (default 5). */
  max?: number;
  /** Override the LLM provider (tests inject a deterministic mock). */
  llm?: LlmProvider;
}

export interface SuggestedTitles {
  /** The ranked target titles (best first), 1..max, deduped + trimmed. */
  titles: string[];
  /** Model that produced the suggestion, for provenance. */
  model: string;
}

const DEFAULT_MAX = 5;
const MAX_TITLE_LEN = 256;

const SuggestionSchema = z.object({
  titles: z
    .array(z.union([z.string(), z.number(), z.boolean()]))
    .nullish()
    .transform((v) => v ?? []),
});

const SYSTEM_PROMPT = `You are a career strategist helping a candidate choose the job titles to search for.
From the candidate's profile, propose the TARGET job titles they should look for next — the roles that best fit their experience, skills, and trajectory.

Return ONLY a single JSON object (no markdown, no commentary) with this shape:
{ "titles": ["Most relevant title", "Next best", "..."] }

Rules:
- Return up to {{MAX}} titles, ranked best-first (the strongest fit first).
- Use real, canonical job titles a job board would list (e.g. "Senior Software Engineer", "Product Manager"), not sentences or descriptions.
- Ground them in the candidate's actual experience and skills — do not invent a seniority or field the profile does not support.
- No duplicates or near-duplicates. Keep each title concise.
- Output JSON only.`;

/** Render the profile into a compact text block for the prompt. Only includes the
 *  fields that inform title choice; unknown/empty sections are omitted. */
function renderProfile(profile: SuggestTitlesProfile): string {
  const a = (profile.attributes ?? {}) as Record<string, unknown>;
  const lines: string[] = [];

  const str = (v: unknown): string | null => {
    if (v == null) return null;
    const s = String(v).trim();
    return s.length > 0 ? s : null;
  };

  const name = str(a.full_name);
  if (name) lines.push(`Name: ${name}`);
  const summary = str(a.summary);
  if (summary) lines.push(`Summary: ${summary}`);
  const location = str(a.location);
  if (location) lines.push(`Location: ${location}`);

  const spine = profile.spine;
  const work = spine.workExperiences ?? [];
  if (work.length > 0) {
    lines.push("Work experience:");
    for (const w of work) {
      const role = str(w.title);
      if (!role) continue;
      const org = str(w.organization);
      const current = w.isCurrent ? " (current)" : "";
      lines.push(`- ${role}${org ? ` at ${org}` : ""}${current}`);
    }
  }

  const skills = (spine.skills ?? []).map((s) => str(s.name)).filter((s): s is string => !!s);
  if (skills.length > 0) lines.push(`Skills: ${skills.join(", ")}`);

  const education = spine.education ?? [];
  if (education.length > 0) {
    const ed = education
      .map((e) => [str(e.degree), str(e.fieldOfStudy)].filter(Boolean).join(" in "))
      .filter((s) => s.length > 0);
    if (ed.length > 0) lines.push(`Education: ${ed.join("; ")}`);
  }

  const projects = (spine.projects ?? []).map((p) => str(p.name)).filter((s): s is string => !!s);
  if (projects.length > 0) lines.push(`Projects: ${projects.join(", ")}`);

  const certs = (spine.certifications ?? [])
    .map((c) => str(c.name))
    .filter((s): s is string => !!s);
  if (certs.length > 0) lines.push(`Certifications: ${certs.join(", ")}`);

  return lines.join("\n");
}

/** Build the user turn: the rendered profile, plus the current set + feedback when
 *  the candidate is re-ranking/refining a prior suggestion. */
function buildUserPrompt(profile: SuggestTitlesProfile, opts: SuggestTitlesOptions): string {
  const parts = [`Candidate profile:\n${renderProfile(profile)}`];
  const current = (opts.current ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
  if (current.length > 0) {
    parts.push(`You previously suggested: ${current.join(", ")}`);
  }
  const feedback = opts.feedback?.trim();
  if (feedback) {
    parts.push(`The candidate's feedback: ${feedback}\nRevise the titles accordingly.`);
  }
  return parts.join("\n\n");
}

/** Pull a JSON object out of the model's reply: strip a ```json fence if present,
 *  else take the outermost { … }. Throws TitleSuggestionError when neither works. */
function parseModelJson(raw: string): unknown {
  let s = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new TitleSuggestionError("model did not return a JSON object");
  }
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch (err) {
    throw new TitleSuggestionError(
      `model JSON did not parse: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Trim, drop empties/over-long, and dedupe case-insensitively (keeping the first,
 *  highest-ranked occurrence), then cap to `max`. */
function cleanTitles(raw: unknown[], max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const title = String(r).trim();
    if (!title || title.length > MAX_TITLE_LEN) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(title);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Suggest ~5 ranked target job titles for a populated profile via the LLM.
 *
 * Sends the rendered profile (plus any current set + candidate feedback) to the
 * configured provider, then parses + validates the JSON reply and normalises the
 * titles (trim, dedupe, cap). Loopable: call again with `feedback`/`current` to
 * re-rank. Throws {@link TitleSuggestionError} when the model returns no parseable
 * JSON or no usable titles.
 */
export async function suggestTargetTitles(
  profile: SuggestTitlesProfile,
  opts: SuggestTitlesOptions = {},
): Promise<SuggestedTitles> {
  const max = opts.max ?? DEFAULT_MAX;
  const provider = opts.llm ?? resolveLlm();
  const { text, model } = await provider.complete(
    [
      { role: "system", content: SYSTEM_PROMPT.replace("{{MAX}}", String(max)) },
      { role: "user", content: buildUserPrompt(profile, opts) },
    ],
    { temperature: 0.3, maxTokens: 600 },
  );

  const parsed = SuggestionSchema.safeParse(parseModelJson(text));
  if (!parsed.success) {
    throw new TitleSuggestionError(`title suggestion failed validation: ${parsed.error.message}`);
  }
  const titles = cleanTitles(parsed.data.titles, max);
  if (titles.length === 0) {
    throw new TitleSuggestionError("model returned no usable titles");
  }
  return { titles, model };
}
