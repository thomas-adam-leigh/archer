import { describe, expect, it } from "vitest";
import { LlmConfigError } from "./errors";
import { type FetchLike, type LlmEnv, resolveLlm } from "./index";

const okFetch: FetchLike = async () =>
  new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("resolveLlm", () => {
  it("defaults to MiniMax M3 when LLM_PROVIDER is unset", () => {
    const env: LlmEnv = { MINIMAX_API_KEY: "mm" };
    const llm = resolveLlm(env);
    expect(llm.name).toBe("minimax");
    expect(llm.defaultModel).toBe("MiniMax-M3");
  });

  it("fails closed when the selected provider's key is missing", () => {
    expect(() => resolveLlm({})).toThrow(LlmConfigError);
    expect(() => resolveLlm({ LLM_PROVIDER: "openrouter" })).toThrow(LlmConfigError);
  });

  it("selects OpenRouter and applies LLM_MODEL override", () => {
    const env: LlmEnv = { LLM_PROVIDER: "openrouter", OPENROUTER_API_KEY: "or", LLM_MODEL: "x/y" };
    const llm = resolveLlm(env);
    expect(llm.name).toBe("openrouter");
    expect(llm.defaultModel).toBe("x/y");
  });

  it("selects the mock provider with no key required", async () => {
    const llm = resolveLlm({ LLM_PROVIDER: "mock" });
    expect(llm.name).toBe("mock");
    expect((await llm.complete([{ role: "user", content: "hi" }])).text).toBe("mock: hi");
  });

  it("throws on an unknown provider", () => {
    expect(() => resolveLlm({ LLM_PROVIDER: "bogus" })).toThrow(LlmConfigError);
  });

  it("threads the injected fetch through to the chosen backend", async () => {
    let called = false;
    const fetch: FetchLike = (url, init) => {
      called = true;
      return okFetch(url, init);
    };
    const llm = resolveLlm({ MINIMAX_API_KEY: "mm" }, { fetch });
    await llm.complete([{ role: "user", content: "hi" }]);
    expect(called).toBe(true);
  });
});
