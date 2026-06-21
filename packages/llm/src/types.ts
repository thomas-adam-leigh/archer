/**
 * The one LLM interface every Archer call-site uses (AG-UI conversational agent,
 * Matchmaker triage, Scribe). Backends — MiniMax direct, OpenRouter, mock — all
 * implement {@link LlmProvider}, so swapping provider/model is config-only.
 */

export type LlmRole = "system" | "user" | "assistant";

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

export interface CompleteOptions {
  /** Override the provider's default model for this call. */
  model?: string;
  /** Sampling temperature (0–2). Omitted ⇒ provider default. */
  temperature?: number;
  /** Upper bound on generated tokens. */
  maxTokens?: number;
  /** Cancel the in-flight request. */
  signal?: AbortSignal;
}

export interface LlmUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface LlmCompletion {
  /** The assistant's full text reply. */
  text: string;
  /** Model that produced the reply (as reported by the backend, else requested). */
  model: string;
  /** Backend that served the call: "minimax" | "openrouter" | "mock". */
  provider: string;
  /** Why generation stopped (e.g. "stop", "length"), when reported. */
  finishReason?: string;
  usage?: LlmUsage;
}

export interface LlmStreamChunk {
  /** Incremental text delta. Concatenating every delta yields the full reply. */
  delta: string;
}

export interface LlmProvider {
  /** Backend identifier, mirrored onto {@link LlmCompletion.provider}. */
  readonly name: string;
  /** Model used when {@link CompleteOptions.model} is not supplied. */
  readonly defaultModel: string;
  /** One-shot completion. */
  complete(messages: LlmMessage[], opts?: CompleteOptions): Promise<LlmCompletion>;
  /** Streamed completion, yielding text deltas as they arrive. */
  stream(messages: LlmMessage[], opts?: CompleteOptions): AsyncIterable<LlmStreamChunk>;
}
