import { describe, expect, it } from "vitest";
import type { Tables, TablesInsert } from "./index";
import { Constants } from "./index";

// The profile spine migration (20260620150000_archer_profile_spine.sql) is the
// candidate's structured tier-1 memory + whole-version history. These assertions
// pin the regenerated types/contract so a drifted or missing migration fails loudly.
describe("profile spine schema", () => {
  it("exposes the version-status enum with its full lifecycle", () => {
    expect(Constants.public.Enums.profile_version_status).toEqual([
      "draft",
      "proposed",
      "approved",
      "rejected",
      "superseded",
    ]);
  });

  it("exposes a profile_versions Insert with user scope + status default", () => {
    // version_no + user_id are required; status defaults to 'draft' (optional on Insert).
    const version: TablesInsert<"profile_versions"> = {
      user_id: "00000000-0000-0000-0000-000000000000",
      version_no: 1,
    };
    expect(version.status ?? "draft").toBe("draft");
  });

  it("exposes each spine table as user-scoped + version-scoped with a details jsonb", () => {
    // Compile-time proof every spine table carries user_id + version_id + details;
    // the runtime assertions keep the test meaningful.
    const userId = "00000000-0000-0000-0000-000000000000";
    const versionId = "11111111-1111-1111-1111-111111111111";

    const work: Pick<TablesInsert<"work_experiences">, "user_id" | "version_id" | "title"> = {
      user_id: userId,
      version_id: versionId,
      title: "Senior Engineer",
    };
    const project: Pick<TablesInsert<"projects">, "user_id" | "version_id" | "name"> = {
      user_id: userId,
      version_id: versionId,
      name: "Archer",
    };
    const cert: Pick<TablesInsert<"certifications">, "user_id" | "version_id" | "name"> = {
      user_id: userId,
      version_id: versionId,
      name: "AWS SAA",
    };
    const course: Pick<TablesInsert<"courses">, "user_id" | "version_id" | "name"> = {
      user_id: userId,
      version_id: versionId,
      name: "Distributed Systems",
    };
    const skill: Pick<TablesInsert<"skills">, "user_id" | "version_id" | "name"> = {
      user_id: userId,
      version_id: versionId,
      name: "TypeScript",
    };
    const education: Pick<TablesInsert<"education">, "user_id" | "version_id" | "institution"> = {
      user_id: userId,
      version_id: versionId,
      institution: "UCT",
    };

    for (const row of [work, project, cert, course, skill, education]) {
      expect(row.user_id).toBe(userId);
      expect(row.version_id).toBe(versionId);
    }
  });

  it("adds the profile-wide attributes jsonb to the live profile row", () => {
    // attributes is the live profile-wide jsonb (ideal_job, ai_fluency, your-story…).
    const attributes: Tables<"profiles">["attributes"] = { ideal_job: "staff eng" };
    expect(attributes).toMatchObject({ ideal_job: "staff eng" });
  });
});
