// Résumé text → structured profile draft (ARC-64).
//
// ARC-63 turns an uploaded PDF/DOCX into plain text; this module turns that text
// into a structured profile DRAFT — the profile-wide `attributes` snapshot plus
// the typed spine (work_experiences, education, skills, certifications, courses,
// projects) — using the real, swappable LLM (@archer/llm; MiniMax by default,
// mock in tests). The draft is reconstructive, never inventive: the prompt forbids
// hallucinated employers/dates and leaves unknown fields empty. The caller (ARC-65
// ingest run) persists it as a PROPOSED profile_version via writeProfileSpine.
import type { Json, ProfileSpineDraft } from "@archer/db";
import { type LlmProvider, resolveLlm } from "@archer/llm";
import { z } from "zod";

/** A structuring failure (model returned no/invalid JSON). Carried as one typed
 *  error so the ingest run can branch — surface, retry, or fail the run. */
export class ResumeStructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeStructureError";
  }
}

export interface StructureResumeOptions {
  /** Override the LLM provider (tests inject a deterministic mock). */
  llm?: LlmProvider;
}

export interface StructureProfileOptions extends StructureResumeOptions {
  /** Override the system prompt. The conversational path (ARC-79) supplies its own
   *  while reusing the same schema, builders, and JSON-extraction below. */
  systemPrompt?: string;
}

export interface StructuredResume {
  /** Profile-wide snapshot (full_name, email, links, summary, …) for the version. */
  attributes: Record<string, Json>;
  /** The reconstructed structured spine (only non-empty lists are included). */
  spine: ProfileSpineDraft;
  /** Model that produced the structuring, for provenance on the version's details. */
  model: string;
}

// The structuring contract the model is asked to fill. Lenient on purpose: every
// field coerces to a trimmed string or null, so a stray number/empty string from
// the model never fails the parse — faithful-but-imperfect output still lands.
const optStr = z
  .union([z.string(), z.number(), z.boolean()])
  .nullish()
  .transform((v) => {
    if (v == null) return null;
    const s = String(v).trim();
    return s.length > 0 ? s : null;
  });

const optBool = z
  .boolean()
  .nullish()
  .transform((v) => v ?? null);
const optNum = z
  .union([z.number(), z.string()])
  .nullish()
  .transform((v) => {
    if (v == null || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  });

const WorkSchema = z.object({
  title: optStr,
  organization: optStr,
  employmentType: optStr,
  location: optStr,
  startDate: optStr,
  endDate: optStr,
  isCurrent: optBool,
  description: optStr,
});
const EducationSchema = z.object({
  institution: optStr,
  degree: optStr,
  fieldOfStudy: optStr,
  startDate: optStr,
  endDate: optStr,
  grade: optStr,
});
const SkillSchema = z.object({
  name: optStr,
  category: optStr,
  proficiency: optStr,
  yearsExperience: optNum,
});
const CertificationSchema = z.object({
  name: optStr,
  issuer: optStr,
  issuedOn: optStr,
  expiresOn: optStr,
  credentialId: optStr,
  url: optStr,
});
const CourseSchema = z.object({
  name: optStr,
  provider: optStr,
  completedOn: optStr,
  url: optStr,
});
const ProjectSchema = z.object({
  name: optStr,
  role: optStr,
  url: optStr,
  startDate: optStr,
  endDate: optStr,
  description: optStr,
});

const arr = <T extends z.ZodTypeAny>(item: T) =>
  z
    .array(item)
    .nullish()
    .transform((v) => v ?? []);

const StructuredSchema = z.object({
  attributes: z
    .object({
      fullName: optStr,
      email: optStr,
      phone: optStr,
      location: optStr,
      summary: optStr,
      links: z.object({ linkedin: optStr, github: optStr, website: optStr }).partial().nullish(),
    })
    .partial()
    .nullish(),
  workExperiences: arr(WorkSchema),
  education: arr(EducationSchema),
  skills: arr(SkillSchema),
  certifications: arr(CertificationSchema),
  courses: arr(CourseSchema),
  projects: arr(ProjectSchema),
});

type Structured = z.infer<typeof StructuredSchema>;

const SYSTEM_PROMPT = `You are a résumé parser. Read the résumé text and reconstruct the candidate's profile as STRICT JSON.

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
- Reconstruct faithfully. NEVER invent employers, schools, dates, or skills not present in the text.
- Leave anything you cannot find as null, and omit list items you cannot fill (empty arrays are fine).
- Dates: use YYYY-MM-DD; if only a month or year is given, use the first of that period. Mark a role with no end date as "isCurrent": true.
- Output JSON only.`;

/** Pull a JSON object out of the model's reply: strip a ```json fence if present,
 *  else take the outermost { … }. Throws ResumeStructureError when neither works. */
function parseModelJson(raw: string): unknown {
  let s = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new ResumeStructureError("model did not return a JSON object");
  }
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch (err) {
    throw new ResumeStructureError(
      `model JSON did not parse: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Coerce "YYYY", "YYYY-MM", or "YYYY-MM-DD" to a Postgres `date`; null otherwise
 *  (so free-text like "Present" never becomes a bogus date — `isCurrent` carries that). */
function normalizeDate(v: string | null): string | null {
  if (!v) return null;
  const m = /^(\d{4})(?:[-/](\d{1,2}))?(?:[-/](\d{1,2}))?$/.exec(v.trim());
  if (!m) return null;
  const month = (m[2] ?? "01").padStart(2, "0");
  const day = (m[3] ?? "01").padStart(2, "0");
  return `${m[1]}-${month}-${day}`;
}

function buildAttributes(a: Structured["attributes"]): Record<string, Json> {
  const out: Record<string, Json> = {};
  if (a?.fullName) out.full_name = a.fullName;
  if (a?.email) out.email = a.email;
  if (a?.phone) out.phone = a.phone;
  if (a?.location) out.location = a.location;
  if (a?.summary) out.summary = a.summary;
  const links: Record<string, Json> = {};
  if (a?.links?.linkedin) links.linkedin = a.links.linkedin;
  if (a?.links?.github) links.github = a.links.github;
  if (a?.links?.website) links.website = a.links.website;
  if (Object.keys(links).length > 0) out.links = links;
  return out;
}

/** Drop list items missing their required field, normalise dates, and only keep
 *  lists that ended up non-empty (so the version's spine stays tidy). */
function buildSpine(s: Structured): ProfileSpineDraft {
  const spine: ProfileSpineDraft = {};

  const work = s.workExperiences
    .filter((w) => w.title)
    .map((w) => ({
      title: w.title as string,
      organization: w.organization,
      employmentType: w.employmentType,
      location: w.location,
      startDate: normalizeDate(w.startDate),
      endDate: normalizeDate(w.endDate),
      isCurrent: w.isCurrent ?? false,
      description: w.description,
    }));
  if (work.length > 0) spine.workExperiences = work;

  const education = s.education
    .filter((e) => e.institution)
    .map((e) => ({
      institution: e.institution as string,
      degree: e.degree,
      fieldOfStudy: e.fieldOfStudy,
      startDate: normalizeDate(e.startDate),
      endDate: normalizeDate(e.endDate),
      grade: e.grade,
    }));
  if (education.length > 0) spine.education = education;

  const skills = s.skills
    .filter((sk) => sk.name)
    .map((sk) => ({
      name: sk.name as string,
      category: sk.category,
      proficiency: sk.proficiency,
      yearsExperience: sk.yearsExperience,
    }));
  if (skills.length > 0) spine.skills = skills;

  const certifications = s.certifications
    .filter((c) => c.name)
    .map((c) => ({
      name: c.name as string,
      issuer: c.issuer,
      issuedOn: normalizeDate(c.issuedOn),
      expiresOn: normalizeDate(c.expiresOn),
      credentialId: c.credentialId,
      url: c.url,
    }));
  if (certifications.length > 0) spine.certifications = certifications;

  const courses = s.courses
    .filter((c) => c.name)
    .map((c) => ({
      name: c.name as string,
      provider: c.provider,
      completedOn: normalizeDate(c.completedOn),
      url: c.url,
    }));
  if (courses.length > 0) spine.courses = courses;

  const projects = s.projects
    .filter((p) => p.name)
    .map((p) => ({
      name: p.name as string,
      role: p.role,
      url: p.url,
      startDate: normalizeDate(p.startDate),
      endDate: normalizeDate(p.endDate),
      description: p.description,
    }));
  if (projects.length > 0) spine.projects = projects;

  return spine;
}

/**
 * Structure free text into a profile draft (attributes + spine) via the LLM — the
 * shared core behind both résumé structuring (ARC-64) and conversational onboarding
 * (ARC-79). Sends the text to the configured provider at temperature 0 for a
 * faithful, deterministic reconstruction against the same structuring schema, then
 * parses + validates the JSON reply. The caller supplies the system prompt for its
 * source (a résumé parser vs an onboarding-conversation reader). Throws a
 * {@link ResumeStructureError} when the model returns no parseable JSON.
 */
export async function structureProfileText(
  text: string,
  opts: StructureProfileOptions = {},
): Promise<StructuredResume> {
  const provider = opts.llm ?? resolveLlm();
  const { text: reply, model } = await provider.complete(
    [
      { role: "system", content: opts.systemPrompt ?? SYSTEM_PROMPT },
      { role: "user", content: text },
    ],
    { temperature: 0, maxTokens: 4000 },
  );

  const parsed = StructuredSchema.safeParse(parseModelJson(reply));
  if (!parsed.success) {
    throw new ResumeStructureError(`structured profile failed validation: ${parsed.error.message}`);
  }
  return {
    attributes: buildAttributes(parsed.data.attributes),
    spine: buildSpine(parsed.data),
    model,
  };
}

/**
 * Structure résumé text into a profile draft (attributes + spine) via the LLM. A
 * thin wrapper over {@link structureProfileText} with the résumé-parser prompt; the
 * returned draft is what the caller attaches to a PROPOSED version (ARC-64/65).
 */
export async function structureResume(
  resumeText: string,
  opts: StructureResumeOptions = {},
): Promise<StructuredResume> {
  return structureProfileText(resumeText, { llm: opts.llm });
}
