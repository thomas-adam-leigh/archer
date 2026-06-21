import { LlmRequestError } from "./errors.js";
import type {
  CompleteOptions,
  LlmCompletion,
  LlmMessage,
  LlmProvider,
  LlmStreamChunk,
} from "./types.js";

/** Minimal `fetch` shape — injectable so tests never touch the network. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface OpenAiCompatibleConfig {
  /** Backend name surfaced on completions ("minimax" | "openrouter"). */
  name: string;
  /** API root, e.g. `https://api.minimax.io/v1` (no trailing `/chat/completions`). */
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  /** Extra request headers (e.g. OpenRouter attribution). */
  headers?: Record<string, string>;
  /** Override the `fetch` implementation. Defaults to the global. */
  fetch?: FetchLike;
}

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: { content?: string | null };
  }>;
}

function buildBody(
  model: string,
  messages: LlmMessage[],
  opts: CompleteOptions | undefined,
  stream: boolean,
): string {
  const body: Record<string, unknown> = { model, messages, stream };
  if (opts?.temperature !== undefined) body.temperature = opts.temperature;
  if (opts?.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
  return JSON.stringify(body);
}

/**
 * A provider over any OpenAI-compatible `/chat/completions` endpoint. MiniMax
 * (direct) and OpenRouter both speak this dialect, so they share one backend.
 */
export function createOpenAiCompatibleProvider(config: OpenAiCompatibleConfig): LlmProvider {
  const doFetch = config.fetch ?? (globalThis.fetch as FetchLike);
  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${config.apiKey}`,
    ...config.headers,
  };

  async function send(
    messages: LlmMessage[],
    opts: CompleteOptions | undefined,
    stream: boolean,
  ): Promise<Response> {
    const res = await doFetch(url, {
      method: "POST",
      headers,
      body: buildBody(opts?.model ?? config.defaultModel, messages, opts, stream),
      signal: opts?.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LlmRequestError(
        `${config.name} request failed: ${res.status} ${res.statusText}`,
        res.status,
        text,
      );
    }
    return res;
  }

  return {
    name: config.name,
    defaultModel: config.defaultModel,

    async complete(messages, opts) {
      const res = await send(messages, opts, false);
      const json = (await res.json()) as ChatCompletionResponse;
      const choice = json.choices?.[0];
      return {
        text: choice?.message?.content ?? "",
        model: json.model ?? opts?.model ?? config.defaultModel,
        provider: config.name,
        finishReason: choice?.finish_reason ?? undefined,
        usage: json.usage
          ? {
              promptTokens: json.usage.prompt_tokens,
              completionTokens: json.usage.completion_tokens,
              totalTokens: json.usage.total_tokens,
            }
          : undefined,
      };
    },

    async *stream(messages, opts) {
      const res = await send(messages, opts, true);
      if (!res.body) return;
      for await (const data of sseDataLines(res.body)) {
        if (data === "[DONE]") return;
        let chunk: ChatCompletionChunk;
        try {
          chunk = JSON.parse(data) as ChatCompletionChunk;
        } catch {
          continue; // ignore keep-alives / non-JSON frames
        }
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) yield { delta } satisfies LlmStreamChunk;
      }
    },
  };
}

/** Parse an SSE byte stream into the payloads of its `data:` lines. */
async function* sseDataLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      // SSE frames are newline-delimited; handle one line at a time.
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith("data:")) yield tail.slice(5).trim();
  } finally {
    reader.releaseLock();
  }
}
