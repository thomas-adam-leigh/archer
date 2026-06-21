import { describe, expect, it } from "vitest";
import { createMockProvider } from "./mock";
import type { LlmMessage } from "./types";

const MESSAGES: LlmMessage[] = [
  { role: "system", content: "be brief" },
  { role: "user", content: "hello there" },
];

describe("createMockProvider", () => {
  it("is deterministic and echoes the last user message by default", async () => {
    const llm = createMockProvider();
    const a = await llm.complete(MESSAGES);
    const b = await llm.complete(MESSAGES);
    expect(a).toEqual(b);
    expect(a.text).toBe("mock: hello there");
    expect(a.provider).toBe("mock");
    expect(a.finishReason).toBe("stop");
  });

  it("uses a custom reply renderer when provided", async () => {
    const llm = createMockProvider({ reply: (m) => `seen ${m.length} messages` });
    const out = await llm.complete(MESSAGES);
    expect(out.text).toBe("seen 2 messages");
  });

  it("reports the configured model, overridable per call", async () => {
    const llm = createMockProvider({ model: "fixture-1" });
    expect(llm.defaultModel).toBe("fixture-1");
    expect((await llm.complete(MESSAGES)).model).toBe("fixture-1");
    expect((await llm.complete(MESSAGES, { model: "other" })).model).toBe("other");
  });

  it("streams deltas that concatenate to the one-shot text", async () => {
    const llm = createMockProvider();
    let streamed = "";
    for await (const chunk of llm.stream(MESSAGES)) streamed += chunk.delta;
    expect(streamed).toBe((await llm.complete(MESSAGES)).text);
  });
});
