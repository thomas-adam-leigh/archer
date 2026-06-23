import { createMockProvider, type LlmMessage } from "@archer/llm";
import { describe, expect, it } from "vitest";
import { ResumeStructureError } from "../ingest/structure.js";
import { buildRevisionPrompt, reconcileSpine, reviseDraft } from "./revise.js";

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

describe("reconcileSpine (ARC-135)", () => {
  it("does not duplicate an item the model edited in place (same identity, changed fields)", () => {
    const prior = { skills: [{ name: "TypeScript", proficiency: "intermediate" }] };
    const revised = { skills: [{ name: "TypeScript", proficiency: "expert" }] };
    const out = reconcileSpine(prior, revised, "I'm expert at TypeScript now.");
    expect(out.skills).toHaveLength(1);
    expect(out.skills?.[0].proficiency).toBe("expert");
  });

  it("trusts a rename the feedback named, rather than re-attaching the old identity", () => {
    // The feedback names "Acme", so the renamed role is an edit, not a silent drop —
    // re-attaching the old "Acme" row would duplicate the candidate's job.
    const prior = { workExperiences: [{ title: "Engineer", organization: "Acme" }] };
    const revised = { workExperiences: [{ title: "Engineer", organization: "Acme Corp" }] };
    const out = reconcileSpine(prior, revised, "Rename Acme to Acme Corp.");
    expect(out.workExperiences).toHaveLength(1);
    expect(out.workExperiences?.[0].organization).toBe("Acme Corp");
  });

  it("leaves a clean revision untouched", () => {
    const prior = { skills: [{ name: "Go" }] };
    const revised = { skills: [{ name: "Go" }, { name: "Rust" }] };
    const out = reconcileSpine(prior, revised, "Add Rust.");
    expect(out.skills?.map((s) => s.name)).toEqual(["Go", "Rust"]);
  });

  it("does not match a short name as a substring of another word", () => {
    // "Go" must not be considered named by "good" — else a dropped Go skill is lost.
    const prior = { skills: [{ name: "Go" }] };
    const revised = { skills: [] };
    const out = reconcileSpine(prior, revised, "This looks good, just fix the summary.");
    expect(out.skills?.map((s) => s.name)).toEqual(["Go"]);
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

  it("re-attaches items the model silently dropped when the feedback never named them (ARC-135)", async () => {
    // The feedback only touches the summary, but the model returns a draft missing 2
    // of 3 certifications and a work role. The reconciliation must put them back so the
    // revision never loses content the candidate didn't ask to change.
    const current = {
      attributes: { full_name: "Ada Lovelace" },
      spine: {
        workExperiences: [
          { title: "Senior Engineer", organization: "Acme", isCurrent: true },
          { title: "Engineer", organization: "Globex" },
        ],
        certifications: [
          { name: "AWS Solutions Architect" },
          { name: "CKA" },
          { name: "Terraform Associate" },
        ],
      },
    };
    const llm = createMockProvider({
      reply: () =>
        JSON.stringify({
          attributes: { fullName: "Ada Lovelace", summary: "Polished summary." },
          // Model drops the Globex role and two certs — none mentioned in the feedback.
          workExperiences: [{ title: "Senior Engineer", organization: "Acme", isCurrent: true }],
          certifications: [{ name: "AWS Solutions Architect" }],
        }),
    });

    const { spine } = await reviseDraft(
      { current, feedback: "Polish my summary.", source: "résumé text" },
      { llm },
    );

    expect(spine.workExperiences?.map((w) => w.title)).toEqual(["Senior Engineer", "Engineer"]);
    expect(spine.certifications?.map((c) => c.name)).toEqual([
      "AWS Solutions Architect",
      "CKA",
      "Terraform Associate",
    ]);
  });

  it("honours a removal the feedback named, without re-attaching it (ARC-135)", async () => {
    const current = {
      attributes: {},
      spine: { certifications: [{ name: "AWS Solutions Architect" }, { name: "CKA" }] },
    };
    const llm = createMockProvider({
      reply: () =>
        JSON.stringify({
          attributes: {},
          certifications: [{ name: "AWS Solutions Architect" }],
        }),
    });

    const { spine } = await reviseDraft(
      { current, feedback: "Remove my CKA certification." },
      { llm },
    );

    // CKA was named for removal, so it stays gone — not silently re-attached.
    expect(spine.certifications?.map((c) => c.name)).toEqual(["AWS Solutions Architect"]);
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
