import { describe, expect, it } from "vitest";
import { LlmRequestError } from "./errors";
import { createOpenAiCompatibleProvider, type FetchLike } from "./openai-compatible";
import { createMinimaxProvider, createOpenRouterProvider } from "./providers";
import type { LlmMessage } from "./types";

const MESSAGES: LlmMessage[] = [{ role: "user", content: "ping" }];

interface Captured {
  url: string;
  init: RequestInit;
}

/** A fetch double that records the request and returns a canned Response. */
function fakeFetch(response: Response): { fetch: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  return { fetch, calls };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(init.body as string);
}

describe("createOpenAiCompatibleProvider — complete", () => {
  it("posts to /chat/completions with auth + maps the response", async () => {
    const { fetch, calls } = fakeFetch(
      jsonResponse({
        model: "MiniMax-M3",
        choices: [{ message: { content: "pong" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
    );
    const llm = createOpenAiCompatibleProvider({
      name: "minimax",
      baseUrl: "https://api.example.com/v1",
      apiKey: "secret-key",
      defaultModel: "MiniMax-M3",
      fetch,
    });

    const out = await llm.complete(MESSAGES, { temperature: 0.2, maxTokens: 64 });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.example.com/v1/chat/completions");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret-key");
    expect(headers["content-type"]).toBe("application/json");
    const body = bodyOf(calls[0].init);
    expect(body).toMatchObject({
      model: "MiniMax-M3",
      stream: false,
      temperature: 0.2,
      max_tokens: 64,
      messages: MESSAGES,
    });

    expect(out).toEqual({
      text: "pong",
      model: "MiniMax-M3",
      provider: "minimax",
      finishReason: "stop",
      usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
    });
  });

  it("honors a per-call model override", async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({ choices: [{ message: { content: "x" } }] }));
    const llm = createOpenAiCompatibleProvider({
      name: "minimax",
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      defaultModel: "MiniMax-M3",
      fetch,
    });
    await llm.complete(MESSAGES, { model: "MiniMax-M2.1" });
    expect(bodyOf(calls[0].init).model).toBe("MiniMax-M2.1");
  });

  it("throws LlmRequestError on a non-2xx response", async () => {
    const { fetch } = fakeFetch(
      new Response("rate limited", { status: 429, statusText: "Too Many Requests" }),
    );
    const llm = createOpenAiCompatibleProvider({
      name: "minimax",
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      defaultModel: "MiniMax-M3",
      fetch,
    });
    const err = await llm.complete(MESSAGES).catch((e) => e);
    expect(err).toBeInstanceOf(LlmRequestError);
    expect(err).toMatchObject({ status: 429, body: "rate limited" });
  });
});

describe("createOpenAiCompatibleProvider — stream", () => {
  it("parses SSE deltas and stops at [DONE]", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      "data: [DONE]",
      'data: {"choices":[{"delta":{"content":"ignored"}}]}',
    ].join("\n\n");
    const { fetch } = fakeFetch(new Response(sse, { status: 200 }));
    const llm = createOpenAiCompatibleProvider({
      name: "openrouter",
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      defaultModel: "m",
      fetch,
    });

    let text = "";
    for await (const chunk of llm.stream(MESSAGES)) text += chunk.delta;
    expect(text).toBe("Hello");
  });

  it("sets stream:true in the request body", async () => {
    const { fetch, calls } = fakeFetch(new Response("data: [DONE]\n\n", { status: 200 }));
    const llm = createOpenAiCompatibleProvider({
      name: "minimax",
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      defaultModel: "m",
      fetch,
    });
    for await (const _ of llm.stream(MESSAGES)) {
      // drain
    }
    expect(bodyOf(calls[0].init).stream).toBe(true);
  });
});

describe("provider factories", () => {
  it("createMinimaxProvider targets the MiniMax endpoint + default model", async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    const llm = createMinimaxProvider({ apiKey: "mm", fetch });
    expect(llm.name).toBe("minimax");
    expect(llm.defaultModel).toBe("MiniMax-M3");
    await llm.complete(MESSAGES);
    expect(calls[0].url).toBe("https://api.minimax.io/v1/chat/completions");
  });

  it("createOpenRouterProvider targets OpenRouter + adds attribution headers", async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    const llm = createOpenRouterProvider({
      apiKey: "or",
      referer: "https://archer.dev",
      title: "Archer",
      fetch,
    });
    expect(llm.name).toBe("openrouter");
    expect(llm.defaultModel).toBe("minimax/minimax-m3");
    await llm.complete(MESSAGES);
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["http-referer"]).toBe("https://archer.dev");
    expect(headers["x-openrouter-title"]).toBe("Archer");
  });
});
