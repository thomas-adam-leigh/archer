import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ScribeContext } from "./agui";
import { getScribe, llmScribe, type Scribe, setScribe, stubScribe } from "./scribe";

const CTX: ScribeContext = {
  roleTitle: "Platform Engineer",
  companyName: "Acme Corp",
  highlights: ["shipped the billing rewrite", "led a team of four"],
};

// The same role with the rich, specific context (ARC-37 enrichment): the candidate's
// résumé, the company's About, and the job description that turn a generic letter
// into a grounded one. Kept separate from CTX so the existing minimal-context tests
// stay exactly as they were.
const RICH_CTX: ScribeContext = {
  ...CTX,
  resumeText: "Adam Leigh — 8 years building payment platforms in TypeScript and Go.",
  companyAbout: "Acme Corp builds developer tooling for fintech teams.",
  jobDescription: "We need someone to own our billing platform and mentor engineers.",
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

  it("llmScribe folds the rich context into labelled prompt sections (ARC-37)", async () => {
    // The mock provider echoes the last user message, so the prompt is observable:
    // role + job description, company + About, and the candidate's résumé all land.
    const text = await llmScribe(RICH_CTX);
    expect(text).toContain("Role: Platform Engineer");
    expect(text).toContain(`Job description:\n${RICH_CTX.jobDescription}`);
    expect(text).toContain("Company: Acme Corp");
    expect(text).toContain(`About Acme Corp:\n${RICH_CTX.companyAbout}`);
    expect(text).toContain(`Candidate résumé:\n${RICH_CTX.resumeText}`);
    expect(text).toContain("Candidate highlights:");
  });

  it("llmScribe omits a rich section that is absent or blank (graceful degradation)", async () => {
    // No résumé / About / job description on file: those sections drop out entirely,
    // and the prompt is exactly the minimal-context shape (no empty labels).
    const text = await llmScribe({
      ...CTX,
      resumeText: null,
      companyAbout: "  ",
      jobDescription: undefined,
    });
    expect(text).toContain("Role: Platform Engineer");
    expect(text).toContain("Company: Acme Corp");
    expect(text).not.toContain("Candidate résumé:");
    expect(text).not.toContain("About Acme Corp:");
    expect(text).not.toContain("Job description:");
  });

  it("llmScribe clips an over-budget rich field so the prompt can't blow up", async () => {
    const huge = "x".repeat(10_000);
    const text = await llmScribe({ ...CTX, resumeText: huge });
    expect(text).toContain("…[truncated]");
    // The full 10k never reaches the prompt — only the ~4000-char head plus marker.
    expect(text).not.toContain(huge);
  });

  it("stubScribe stays pure + complete and lightly nods to the company About", async () => {
    const letter = await stubScribe(RICH_CTX);
    expect(letter).toContain("Dear Acme Corp Hiring Team,");
    expect(letter).toContain("Platform Engineer");
    expect(letter).toContain("drawn to what Acme Corp is building"); // the About nod
    expect(await stubScribe(RICH_CTX)).toBe(letter); // still pure: same ctx ⇒ same letter
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
