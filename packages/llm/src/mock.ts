import type { LlmMessage, LlmProvider } from "./types.js";

export interface MockProviderOptions {
  /** Custom reply renderer. Defaults to echoing the last user message. */
  reply?: (messages: LlmMessage[]) => string;
  /** Model name reported on completions. */
  model?: string;
}

function lastUserContent(messages: LlmMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return "";
}

function defaultReply(messages: LlmMessage[]): string {
  return `mock: ${lastUserContent(messages)}`;
}

/**
 * A deterministic, network-free provider for tests and CI. Streaming yields the
 * same text the one-shot path returns, split into word-sized deltas.
 */
export function createMockProvider(opts: MockProviderOptions = {}): LlmProvider {
  const model = opts.model ?? "mock-model";
  const render = opts.reply ?? defaultReply;
  return {
    name: "mock",
    defaultModel: model,

    async complete(messages, o) {
      const text = render(messages);
      return {
        text,
        model: o?.model ?? model,
        provider: "mock",
        finishReason: "stop",
      };
    },

    async *stream(messages) {
      const text = render(messages);
      for (const piece of text.split(/(\s+)/).filter((s) => s.length > 0)) {
        yield { delta: piece };
      }
    },
  };
}
