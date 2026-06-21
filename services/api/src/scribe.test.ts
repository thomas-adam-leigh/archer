import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ScribeContext } from "./agui";
import { getScribe, llmScribe, type Scribe, setScribe, stubScribe } from "./scribe";

const CTX: ScribeContext = {
  roleTitle: "Platform Engineer",
  companyName: "Acme Corp",
  highlights: ["shipped the billing rewrite", "led a team of four"],
};

// Proves the Scribe LLM seam (ARC-61): the cover-letter draft is produced by the
// real, swappable provider in non-test runs and a mock in tests; with no provider
// key it falls back to the deterministic assembler — never a live call, CI green.
describe("scribe — the cover-letter LLM seam (ARC-61)", () => {
  beforeEach(() => {
    // mock provider: deterministic, network-free, no key — CI never needs a model.
    process.env.LLM_PROVIDER = "mock";
  });
  afterEach(() => {
    delete process.env.LLM_PROVIDER;
    setScribe(undefined); // reset the memoized scribe between tests
  });

  it("llmScribe drafts via the configured provider", async () => {
    const text = await llmScribe(CTX);
    // The mock provider echoes the last user message (the drafting context).
    expect(text).toContain("Role: Platform Engineer");
    expect(text).toContain("Acme Corp");
  });

  it("stubScribe is the deterministic assembler (a complete letter, offline)", async () => {
    const letter = await stubScribe(CTX);
    expect(letter).toContain("Dear Acme Corp Hiring Team,");
    expect(letter).toContain("Platform Engineer");
    expect(await stubScribe(CTX)).toBe(letter); // pure: same context ⇒ same letter
  });

  it("getScribe uses the real model when a provider key is configured", () => {
    expect(getScribe()).toBe(llmScribe);
  });

  it("getScribe falls back to the deterministic assembler with no provider key", () => {
    const saved = {
      provider: process.env.LLM_PROVIDER,
      minimax: process.env.MINIMAX_API_KEY,
      openrouter: process.env.OPENROUTER_API_KEY,
    };
    delete process.env.LLM_PROVIDER;
    delete process.env.MINIMAX_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    setScribe(undefined);
    try {
      expect(getScribe()).toBe(stubScribe);
    } finally {
      if (saved.provider !== undefined) process.env.LLM_PROVIDER = saved.provider;
      if (saved.minimax !== undefined) process.env.MINIMAX_API_KEY = saved.minimax;
      if (saved.openrouter !== undefined) process.env.OPENROUTER_API_KEY = saved.openrouter;
    }
  });

  it("setScribe injects a stand-in, and undefined resets it", async () => {
    const fixed: Scribe = async () => "fixed letter";
    setScribe(fixed);
    expect(getScribe()).toBe(fixed);
    expect(await getScribe()(CTX)).toBe("fixed letter");
    setScribe(undefined);
    expect(getScribe()).toBe(llmScribe);
  });
});
