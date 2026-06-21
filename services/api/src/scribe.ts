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

/** Project the drafting context onto the LLM chat contract. */
function toMessages(ctx: ScribeContext): LlmMessage[] {
  const company = ctx.companyName?.trim() || "the company";
  const highlights = (ctx.highlights ?? []).map((h) => h.trim()).filter(Boolean);
  const detail = [
    `Role: ${ctx.roleTitle}`,
    `Company: ${company}`,
    highlights.length > 0
      ? `Candidate highlights:\n- ${highlights.join("\n- ")}`
      : "Candidate highlights: (none provided — keep it sincere but generic)",
  ].join("\n");
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: detail },
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
