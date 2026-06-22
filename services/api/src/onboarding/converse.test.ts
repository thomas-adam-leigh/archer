import { createMockProvider, type LlmMessage } from "@archer/llm";
import { describe, expect, it } from "vitest";
import { restoreThread, runStub } from "../agui.js";
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

describe("multi-turn onboarding → populated draft (ARC-84)", () => {
  const THREAD = "33333333-3333-3333-3333-333333333333";

  it("records both sides over /agui/run turns, yielding a non-empty structured draft", async () => {
    // Two ASKING turns over the run loop: each runStub call records the candidate's
    // answer + Archer's reply (the bug was that the answers were never recorded, so
    // the finalize structured ONLY Archer's questions → an empty profile).
    const turn1 = runStub({
      threadId: THREAD,
      runId: "run-1",
      input: {
        threadId: THREAD,
        messages: [{ role: "user", content: "I'm a senior engineer at Acme building APIs." }],
      },
      reply: "Great — what are your top skills?",
    });
    const turn2 = runStub({
      threadId: THREAD,
      runId: "run-2",
      input: {
        threadId: THREAD,
        messages: [
          { role: "assistant", content: "Great — what are your top skills?" },
          { role: "user", content: "TypeScript and Go." },
        ],
      },
      reply: "Thanks — that's everything I need.",
    });

    // The finalize step folds the persisted event log back into the transcript.
    const transcript = buildTranscript(restoreThread([...turn1, ...turn2]).messages);
    expect(transcript).toContain("Candidate: I'm a senior engineer at Acme building APIs.");
    expect(transcript).toContain("Candidate: TypeScript and Go.");

    // Structure that transcript (LLM mocked) — a populated draft, not empty.
    const llm = createMockProvider({
      reply: () =>
        JSON.stringify({
          attributes: { fullName: "Ada Lovelace", summary: "Senior engineer." },
          workExperiences: [{ title: "Senior Engineer", organization: "Acme", isCurrent: true }],
          skills: [{ name: "TypeScript" }, { name: "Go" }],
        }),
    });
    const { attributes, spine } = await structureConversation(transcript, { llm });
    expect(attributes.full_name).toBe("Ada Lovelace");
    expect(hasSpine(spine)).toBe(true);
    expect(spine.workExperiences).toHaveLength(1);
    expect(spine.skills).toHaveLength(2);
  });
});
