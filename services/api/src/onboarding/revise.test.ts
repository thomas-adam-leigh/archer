import { createMockProvider, type LlmMessage } from "@archer/llm";
import { describe, expect, it } from "vitest";
import { ResumeStructureError } from "../ingest/structure.js";
import { buildRevisionPrompt, reviseDraft } from "./revise.js";

// Unit tests for feedback-aware draft revision (ARC-85). The LLM is MOCKED, so the
// prompt framing (current draft + source + feedback) and the amended draft it yields
// are asserted deterministically with no model. The structuring core is the résumé
// structurer's (covered in ingest/structure.test.ts); here we assert the revise
// framing and that revising produces a non-empty, amended draft (the DoD).

const CURRENT = {
  attributes: { full_name: "Ada Lovelace", summary: "Senior engineer." },
  spine: {
    workExperiences: [{ title: "Senior Engineer", organization: "Acme", isCurrent: true }],
    skills: [{ name: "TypeScript" }],
  },
};

describe("buildRevisionPrompt", () => {
  it("labels the current draft, the source, and the feedback as distinct sections", () => {
    const prompt = buildRevisionPrompt({
      current: CURRENT,
      feedback: "Add Go to my skills.",
      source: "Ada Lovelace — Senior Engineer at Acme. Skills: TypeScript.",
    });
    expect(prompt).toContain("CURRENT PROFILE DRAFT");
    expect(prompt).toContain('"full_name":"Ada Lovelace"');
    expect(prompt).toContain('"title":"Senior Engineer"');
    expect(prompt).toContain("SOURCE MATERIAL");
    expect(prompt).toContain("Skills: TypeScript.");
    expect(prompt).toContain("CANDIDATE FEEDBACK");
    expect(prompt).toContain("Add Go to my skills.");
  });

  it("notes when no source was retained, rather than emitting an empty section", () => {
    const prompt = buildRevisionPrompt({ current: CURRENT, feedback: "Tweak my summary." });
    expect(prompt).toContain("(none retained)");
  });
});

describe("reviseDraft", () => {
  it("amends the draft per feedback, yielding a non-empty version that keeps prior content", async () => {
    // Capture the messages so we assert the revise framing, and return an amended
    // draft that preserves the existing experience while applying the feedback.
    let seen: LlmMessage[] = [];
    const llm = createMockProvider({
      reply: (messages) => {
        seen = messages;
        return JSON.stringify({
          attributes: { fullName: "Ada Lovelace", summary: "Senior engineer." },
          workExperiences: [{ title: "Senior Engineer", organization: "Acme", isCurrent: true }],
          skills: [{ name: "TypeScript" }, { name: "Go" }],
        });
      },
    });

    const { attributes, spine } = await reviseDraft(
      {
        current: CURRENT,
        feedback: "Add Go to my skills.",
        source: "Ada Lovelace — Senior Engineer at Acme. Skills: TypeScript.",
      },
      { llm },
    );

    // The revise prompt (not the résumé/conversation parser) frames the turn, and the
    // current draft + feedback ride in on the user turn.
    expect(seen[0].role).toBe("system");
    expect(seen[0].content).toContain("revising a candidate's professional profile");
    expect(seen[1].content).toContain("Add Go to my skills.");

    // The amended draft is non-empty: it preserves the prior experience and applies
    // the feedback (Go added) — it does not blank the draft.
    expect(attributes.full_name).toBe("Ada Lovelace");
    expect(spine.workExperiences).toHaveLength(1);
    expect(spine.workExperiences?.[0]).toMatchObject({ title: "Senior Engineer" });
    expect(spine.skills).toHaveLength(2);
    expect(spine.skills?.map((s) => s.name)).toContain("Go");
  });

  it("propagates a structuring failure when the model returns no JSON", async () => {
    await expect(
      reviseDraft(
        { current: CURRENT, feedback: "change something" },
        { llm: createMockProvider({ reply: () => "I cannot do that." }) },
      ),
    ).rejects.toThrow(ResumeStructureError);
  });
});
