// The Scribe brain behind the cover-letter run (ARC-61).
//
// agui.ts's scribeRun builds the run's event log but no longer has to invent the
// letter's words: this module drafts them with a real, swappable LLM (the
// @archer/llm provider abstraction — MiniMax M3 by default, OpenRouter BYOK, mock
// in tests). The route asks the Scribe for the assembled letter, then hands it to
// scribeRun() as `ScribeArgs.content`, so the event ordering stays pure while the
// letter is real — exactly the brain/runStub split (services/api/src/brain.ts).
//
// The default is the real model when a provider key is configured; with no key it
// falls back to the deterministic assembleCoverLetter (agui.ts), so a keyless run
// still produces a complete letter and never makes a live call unbidden. Like
// getBrain(), the Scribe is memoized; setScribe() injects a stand-in for tests.
import { LlmConfigError, type LlmMessage, resolveLlm } from "@archer/llm";
import { assembleCoverLetter, type ScribeContext } from "./agui.js";

/** The Scribe: one drafting context in, the assembled cover-letter text out. */
export type Scribe = (ctx: ScribeContext) => Promise<string>;

/** Frames the draft: the one thing Archer puts in front of an employer in the
 *  candidate's name, so the voice is sincere, specific, and free of placeholders. */
const SYSTEM_PROMPT =
  "You are Archer's Scribe, drafting a short, sincere cover letter in the " +
  "candidate's own voice for one specific role. Write three short paragraphs: open " +
  "with genuine interest in the role and company, weave in the candidate's " +
  "highlights, and close with a call to discuss. No placeholders, no markdown, no " +
  "subject line. Open with 'Dear <company> Hiring Team,' and sign off with 'Kind " +
  "regards,' on its own line (no name).";

/** Per-field budget for the free-text context sections (résumé / job description /
 *  company About). These arrive from the DB unbounded — a long résumé or a wall of
 *  posting boilerplate could otherwise dwarf the instructions and blow the model's
 *  context window. ~4000 chars each keeps any single source substantial but capped;
 *  the head is what matters most for a cover letter, so we truncate the tail. */
const FIELD_BUDGET = 4000;

/** Trim a free-text field to its budget for the prompt, marking where it was cut so
 *  the model knows it's reading an excerpt (and never silently invents the rest).
 *  Returns undefined for blank/absent input, so the section is dropped entirely. */
function clip(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  return text.length > FIELD_BUDGET ? `${text.slice(0, FIELD_BUDGET)}…[truncated]` : text;
}

/** Project the drafting context onto the LLM chat contract. The user message is
 *  built as labelled sections — the role + job description, the company + its About,
 *  the candidate's résumé, then the highlights — so the model can ground specifics
 *  in real text instead of inventing them. Each rich section is included only when
 *  present (any may be absent) and clipped to a budget so the prompt can't blow up. */
function toMessages(ctx: ScribeContext): LlmMessage[] {
  const company = ctx.companyName?.trim() || "the company";
  const highlights = (ctx.highlights ?? []).map((h) => h.trim()).filter(Boolean);
  const jobDescription = clip(ctx.jobDescription);
  const companyAbout = clip(ctx.companyAbout);
  const resumeText = clip(ctx.resumeText);
  const sections = [
    `Role: ${ctx.roleTitle}`,
    jobDescription ? `Job description:\n${jobDescription}` : undefined,
    `Company: ${company}`,
    companyAbout ? `About ${company}:\n${companyAbout}` : undefined,
    resumeText ? `Candidate résumé:\n${resumeText}` : undefined,
    highlights.length > 0
      ? `Candidate highlights:\n- ${highlights.join("\n- ")}`
      : "Candidate highlights: (none provided — keep it sincere but generic)",
  ].filter((s): s is string => s !== undefined);
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: sections.join("\n\n") },
  ];
}

/** The real Scribe: drafts the letter with the configured provider. Resolution is
 *  fail-closed (throws if the selected provider's key is absent), so it runs per
 *  request and only builds the provider once a real draft actually fires. */
export const llmScribe: Scribe = async (ctx) => {
  const { text } = await resolveLlm().complete(toMessages(ctx), { temperature: 0.4 });
  return text.trim();
};

/** The deterministic, network-free fallback: the pure assembler (agui.ts). */
export const stubScribe: Scribe = (ctx) => Promise.resolve(assembleCoverLetter(ctx));

let scribe: Scribe | undefined;

/** The active Scribe — the real LLM when a provider key is configured (mock in
 *  tests via `LLM_PROVIDER=mock`), else the deterministic assembler. Memoized like
 *  getBrain(); the choice is made once on first use. */
export function getScribe(): Scribe {
  if (!scribe) {
    try {
      resolveLlm(); // keys present (or mock) ⇒ draft with the real model
      scribe = llmScribe;
    } catch (err) {
      if (!(err instanceof LlmConfigError)) throw err;
      scribe = stubScribe; // no key ⇒ deterministic letter, never a live call
    }
  }
  return scribe;
}

/** Swap the Scribe (tests inject a stand-in); pass undefined to reset to default. */
export function setScribe(next: Scribe | undefined): void {
  scribe = next;
}
