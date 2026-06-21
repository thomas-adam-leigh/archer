import { createMockProvider } from "@archer/llm";
import { describe, expect, it } from "vitest";
import { ResumeStructureError, structureResume } from "./structure.js";

// Unit tests for résumé → structured-draft (ARC-64). The LLM is MOCKED — a provider
// whose reply renderer returns a fixed JSON payload — so the mapping (attributes
// snake_casing, spine reconstruction, date normalisation, dropping incomplete rows,
// JSON-fence stripping, typed failure) is asserted deterministically with no model.

/** A mock provider that always replies with `payload` (a string, usually JSON). */
const replyWith = (payload: string) => createMockProvider({ reply: () => payload });

const FULL = JSON.stringify({
  attributes: {
    fullName: "Ada Lovelace",
    email: "ada@example.com",
    phone: "+44 20 7946 0958",
    location: "London, UK",
    summary: "Analytical engine pioneer.",
    links: { linkedin: "https://linkedin.com/in/ada", github: null, website: "https://ada.dev" },
  },
  workExperiences: [
    {
      title: "Lead Engineer",
      organization: "Analytical Engines Ltd",
      employmentType: "Full-time",
      location: "London",
      startDate: "2020-03",
      endDate: null,
      isCurrent: true,
      description: "Built the engine.",
    },
    { title: null, organization: "Ghost Corp" },
  ],
  education: [{ institution: "University of London", degree: "BSc", fieldOfStudy: "Mathematics" }],
  skills: [
    { name: "TypeScript", category: "Programming", proficiency: "expert", yearsExperience: "8" },
    { name: "", category: "Empty" },
  ],
  certifications: [{ name: "AWS SA", issuer: "Amazon", issuedOn: "2021" }],
  courses: [{ name: "Distributed Systems", provider: "MIT" }],
  projects: [{ name: "Archer", role: "Creator", url: "https://archer.dev" }],
});

describe("structureResume", () => {
  it("maps a full structured reply into snake_case attributes + a populated spine", async () => {
    const { attributes, spine, model } = await structureResume("résumé text", {
      llm: replyWith(FULL),
    });

    expect(attributes).toEqual({
      full_name: "Ada Lovelace",
      email: "ada@example.com",
      phone: "+44 20 7946 0958",
      location: "London, UK",
      summary: "Analytical engine pioneer.",
      links: { linkedin: "https://linkedin.com/in/ada", website: "https://ada.dev" },
    });
    expect(model).toBe("mock-model");

    // Work: the second item (no title) is dropped; the partial start date is
    // normalised to the first of the month; isCurrent rides through.
    expect(spine.workExperiences).toHaveLength(1);
    expect(spine.workExperiences?.[0]).toMatchObject({
      title: "Lead Engineer",
      organization: "Analytical Engines Ltd",
      startDate: "2020-03-01",
      endDate: null,
      isCurrent: true,
    });

    expect(spine.education?.[0]).toMatchObject({
      institution: "University of London",
      fieldOfStudy: "Mathematics",
    });
    // Skill with a blank name is dropped; yearsExperience coerced "8" → 8.
    expect(spine.skills).toHaveLength(1);
    expect(spine.skills?.[0]).toMatchObject({ name: "TypeScript", yearsExperience: 8 });
    // A year-only date normalises to Jan 1.
    expect(spine.certifications?.[0]).toMatchObject({ name: "AWS SA", issuedOn: "2021-01-01" });
    expect(spine.courses?.[0].name).toBe("Distributed Systems");
    expect(spine.projects?.[0]).toMatchObject({ name: "Archer", url: "https://archer.dev" });
  });

  it("omits empty spine lists and drops free-text dates", async () => {
    const sparse = JSON.stringify({
      attributes: { fullName: "Grace Hopper" },
      workExperiences: [{ title: "Programmer", startDate: "Present", endDate: "whenever" }],
      skills: [],
    });
    const { attributes, spine } = await structureResume("text", { llm: replyWith(sparse) });

    expect(attributes).toEqual({ full_name: "Grace Hopper" });
    expect(spine.workExperiences?.[0]).toMatchObject({ startDate: null, endDate: null });
    // No education/skills/certs/courses/projects keys at all (not empty arrays).
    expect(spine.education).toBeUndefined();
    expect(spine.skills).toBeUndefined();
    expect(spine.projects).toBeUndefined();
  });

  it("strips a ```json code fence around the reply", async () => {
    const fenced = "```json\n" + JSON.stringify({ attributes: { email: "x@y.z" } }) + "\n```";
    const { attributes } = await structureResume("text", { llm: replyWith(fenced) });
    expect(attributes).toEqual({ email: "x@y.z" });
  });

  it("tolerates prose around the JSON object", async () => {
    const messy = `Here is the profile:\n${JSON.stringify({ attributes: { phone: "123" } })}\nDone.`;
    const { attributes } = await structureResume("text", { llm: replyWith(messy) });
    expect(attributes).toEqual({ phone: "123" });
  });

  it("throws ResumeStructureError when the model returns no JSON", async () => {
    await expect(structureResume("text", { llm: replyWith("I cannot do that.") })).rejects.toThrow(
      ResumeStructureError,
    );
  });

  it("throws ResumeStructureError on malformed JSON", async () => {
    await expect(structureResume("text", { llm: replyWith("{ broken: ") })).rejects.toThrow(
      ResumeStructureError,
    );
  });
});
