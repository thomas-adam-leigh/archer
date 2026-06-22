import type { LlmMessage } from "@archer/llm";
import { createMockProvider } from "@archer/llm";
import { describe, expect, it } from "vitest";
import { suggestTargetTitles, TitleSuggestionError } from "./titles.js";

// Unit tests for LLM job-title suggestion (ARC-68). The LLM is MOCKED — a provider
// whose reply renderer returns fixed JSON (or echoes the prompt) — so ranking,
// dedupe/cap, feedback folding, profile rendering, and typed failure are asserted
// deterministically with no live model.

const PROFILE = {
  attributes: {
    full_name: "Ada Lovelace",
    summary: "Backend engineer who builds agentic systems.",
    location: "London, UK",
  },
  spine: {
    workExperiences: [
      { title: "Senior Software Engineer", organization: "Analytical Engines", isCurrent: true },
      { title: "Software Engineer", organization: "Difference Co" },
    ],
    skills: [{ name: "TypeScript" }, { name: "PostgreSQL" }],
    education: [{ institution: "UoL", degree: "BSc", fieldOfStudy: "Mathematics" }],
  },
};

/** A mock provider that always replies with `payload`. */
const replyWith = (payload: string) => createMockProvider({ reply: () => payload });

const titlesReply = (titles: string[]) => JSON.stringify({ titles });

describe("suggestTargetTitles", () => {
  it("returns ranked titles from a populated profile, preserving order", async () => {
    const llm = replyWith(
      titlesReply(["Staff Software Engineer", "Senior Backend Engineer", "AI Engineer"]),
    );
    const { titles, model } = await suggestTargetTitles(PROFILE, { llm });
    expect(titles).toEqual(["Staff Software Engineer", "Senior Backend Engineer", "AI Engineer"]);
    expect(model).toBe("mock-model");
  });

  it("strips a ```json fence", async () => {
    const llm = replyWith("```json\n" + titlesReply(["Backend Engineer"]) + "\n```");
    const { titles } = await suggestTargetTitles(PROFILE, { llm });
    expect(titles).toEqual(["Backend Engineer"]);
  });

  it("dedupes case-insensitively, keeping the first occurrence, and drops empties", async () => {
    const llm = replyWith(
      titlesReply(["Backend Engineer", "  ", "backend engineer", "Platform Engineer"]),
    );
    const { titles } = await suggestTargetTitles(PROFILE, { llm });
    expect(titles).toEqual(["Backend Engineer", "Platform Engineer"]);
  });

  it("caps the result to `max`", async () => {
    const many = ["A", "B", "C", "D", "E", "F", "G"];
    const llm = replyWith(titlesReply(many));
    const { titles } = await suggestTargetTitles(PROFILE, { llm, max: 3 });
    expect(titles).toEqual(["A", "B", "C"]);
  });

  it("renders the profile and folds in current set + feedback for re-ranking", async () => {
    let captured: LlmMessage[] = [];
    const llm = createMockProvider({
      reply: (messages) => {
        captured = messages;
        return titlesReply(["AI Engineer", "Senior Backend Engineer"]);
      },
    });
    await suggestTargetTitles(PROFILE, {
      llm,
      current: ["Senior Backend Engineer", "AI Engineer"],
      feedback: "rank AI Engineer first",
    });
    const user = captured.find((m) => m.role === "user")?.content ?? "";
    // profile rendered
    expect(user).toContain("Ada Lovelace");
    expect(user).toContain("Senior Software Engineer at Analytical Engines (current)");
    expect(user).toContain("TypeScript, PostgreSQL");
    // re-rank context carried
    expect(user).toContain("You previously suggested: Senior Backend Engineer, AI Engineer");
    expect(user).toContain("rank AI Engineer first");
  });

  it("throws TitleSuggestionError when the model returns no JSON object", async () => {
    const llm = replyWith("Sorry, I could not help with that.");
    await expect(suggestTargetTitles(PROFILE, { llm })).rejects.toBeInstanceOf(
      TitleSuggestionError,
    );
  });

  it("throws TitleSuggestionError when the model returns zero usable titles", async () => {
    const llm = replyWith(titlesReply([]));
    await expect(suggestTargetTitles(PROFILE, { llm })).rejects.toBeInstanceOf(
      TitleSuggestionError,
    );
  });
});
