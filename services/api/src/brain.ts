// The conversational brain behind the AG-UI run loop (ARC-60).
//
// agui.ts builds the run's event log but no longer invents the assistant's words:
// this module produces them with a real, swappable LLM (the @archer/llm provider
// abstraction — MiniMax M3 by default, OpenRouter BYOK, mock in tests). The route
// asks the brain for the turn's reply text, then hands it to runStub() as
// `StubArgs.reply`, so the event ordering stays pure while the words are real.
//
// Like getDb(), the brain is lazily resolved and memoized; setBrain() swaps in a
// deterministic stand-in for tests (or set LLM_PROVIDER=mock — same effect,
// config-only), so CI never needs a live model.
import { type LlmMessage, type LlmRole, resolveLlm } from "@archer/llm";
import type { RunAgentInput } from "./agui.js";

/** The conversational brain: one run input in, the assistant's reply text out. */
export type Brain = (input: RunAgentInput) => Promise<string>;

/** Frames every turn: who Archer is and how it should talk to the candidate. The
 *  broader Mission-Agent behaviour (planning, tool use, self-heal) is out of scope
 *  here — this is the conversational brain that talks to the candidate. */
const SYSTEM_PROMPT =
  "You are Archer, an AI job-hunting agent helping a candidate. Speak directly to " +
  "the candidate in a warm, concise, professional voice. When the conversation is " +
  "just starting, greet them and invite them to tell you about their work and what " +
  "kind of role they're after. Keep replies short.";

/** The LLM chat roles; any other AG-UI role is treated as a user turn. */
const LLM_ROLES: ReadonlySet<string> = new Set<LlmRole>(["system", "user", "assistant"]);

/** Project the run input's message turns onto the LLM chat contract, prefixing the
 *  system prompt. Conversational onboarding opens with Archer greeting first — a run
 *  with no candidate turns — but some providers (notably MiniMax) reject a chat that
 *  is *only* a system message ("invalid params, chat content is empty"). So when no
 *  candidate turn is present we seed a minimal user turn to open on; the model then
 *  greets per the system prompt. That seed primes the model only — it is never
 *  persisted to the thread's event log. */
export function toMessages(input: RunAgentInput): LlmMessage[] {
  const messages: LlmMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  for (const m of input.messages ?? []) {
    const content = m.content?.trim();
    if (!content) continue;
    const role: LlmRole = LLM_ROLES.has(m.role) ? (m.role as LlmRole) : "user";
    if (role === "system") continue; // the system frame is ours, not the caller's
    messages.push({ role, content });
  }
  // Never send a system-only chat (MiniMax 400s on it). On the opening turn, give
  // the model a user message to respond to so it produces its greeting.
  if (messages.length === 1) {
    messages.push({ role: "user", content: "Let's get started." });
  }
  return messages;
}

/** The default brain: the configured LLM provider. Resolution is fail-closed
 *  (throws if the selected provider's key is absent), so it runs per request and
 *  the memoized provider is only built once a real run actually fires. */
export const llmBrain: Brain = async (input) => {
  const { text } = await resolveLlm().complete(toMessages(input));
  return text.trim();
};

let brain: Brain | undefined;

/** The active brain — the real LLM by default, lazily resolved like getDb(). */
export function getBrain(): Brain {
  if (!brain) brain = llmBrain;
  return brain;
}

/** Swap the brain (tests inject a deterministic stand-in); pass undefined to reset
 *  to the default LLM brain. */
export function setBrain(next: Brain | undefined): void {
  brain = next;
}
