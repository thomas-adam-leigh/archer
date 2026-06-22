import { createMockProvider, type LlmMessage } from "@archer/llm";
import { describe, expect, it } from "vitest";
import { ResumeStructureError } from "../ingest/structure.js";
import { buildTranscript, hasSpine, structureConversation } from "./converse.js";

// Unit tests for the conversational onboarding finalize (ARC-79). The LLM is MOCKED,
// so transcript building, spine detection, and the structure-from-conversation
// mapping are asserted deterministically with no model. The structuring core is the
// résumé structurer's (covered in ingest/structure.test.ts); here we assert the
// conversation framing (its own system prompt) and the draft it yields.

const replyWith = (payload: string) => createMockProvider({ reply: () => payload });

describe("buildTranscript", () => {
  it("labels assistant turns Archer and the rest Candidate, skipping blanks", () => {
    const transcript = buildTranscript([
      { id: "1", role: "assistant", content: "What's your current role?" },
      { id: "2", role: "user", content: "Senior engineer at Acme." },
      { id: "3", role: "user", content: "   " },
      { id: "4", role: "assistant", content: "Great — and your top skills?" },
    ]);
    expect(transcript).toBe(
      "Archer: What's your current role?\n" +
        "Candidate: Senior engineer at Acme.\n" +
        "Archer: Great — and your top skills?",
    );
  });

  it("is empty for a conversation with no usable turns", () => {
    expect(buildTranscript([])).toBe("");
    expect(buildTranscript([{ id: "1", role: "assistant", content: "" }])).toBe("");
  });
});

describe("hasSpine", () => {
  it("is true only when some list has rows", () => {
    expect(hasSpine({})).toBe(false);
    expect(hasSpine({ skills: [], education: [] })).toBe(false);
    expect(hasSpine({ skills: [{ name: "Go" }] })).toBe(true);
  });
});

describe("structureConversation", () => {
  it("structures a transcript into attributes + spine using the onboarding prompt", async () => {
    // Capture the messages the provider receives to assert the conversation framing.
    let seen: LlmMessage[] = [];
    const llm = createMockProvider({
      reply: (messages) => {
        seen = messages;
        return JSON.stringify({
          attributes: { fullName: "Grace Hopper", summary: "Programmer." },
          workExperiences: [{ title: "Programmer", organization: "US Navy", isCurrent: true }],
          skills: [{ name: "COBOL" }],
        });
      },
    });

    const { attributes, spine } = await structureConversation("Candidate: I write COBOL.", { llm });

    // The conversation prompt (not the résumé parser) frames the turn.
    expect(seen[0].role).toBe("system");
    expect(seen[0].content).toContain("conversation transcript");
    expect(seen[1].content).toBe("Candidate: I write COBOL.");

    expect(attributes).toEqual({ full_name: "Grace Hopper", summary: "Programmer." });
    expect(spine.workExperiences).toHaveLength(1);
    expect(spine.workExperiences?.[0]).toMatchObject({ title: "Programmer", isCurrent: true });
    expect(spine.skills?.[0]).toMatchObject({ name: "COBOL" });
  });

  it("propagates a structuring failure when the model returns no JSON", async () => {
    await expect(
      structureConversation("text", { llm: replyWith("I cannot do that.") }),
    ).rejects.toThrow(ResumeStructureError);
  });
});
