import { describe, expect, it } from "vitest";
import { resolveLlm } from "./index";

// Live smoke path: hits the real model only when a key is present in the env, so
// CI (which has no key) skips it entirely. Run locally with the provisioned
// MINIMAX_API_KEY (or set LLM_PROVIDER=openrouter + OPENROUTER_API_KEY) to verify
// the real round-trip.
const hasKey = Boolean(process.env.MINIMAX_API_KEY || process.env.OPENROUTER_API_KEY);

describe.skipIf(!hasKey)("resolveLlm — live smoke", () => {
  it("completes a one-shot prompt against the real provider", async () => {
    const llm = resolveLlm(process.env);
    const out = await llm.complete(
      [
        { role: "system", content: "Reply with a single word." },
        { role: "user", content: "Say: pong" },
      ],
      { maxTokens: 16 },
    );
    expect(out.text.length).toBeGreaterThan(0);
    expect(out.provider).toBe(process.env.LLM_PROVIDER?.toLowerCase() ?? "minimax");
  }, 30_000);
});
