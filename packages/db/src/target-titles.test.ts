import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addTargetTitle,
  createProfileVersion,
  listTargetTitles,
  readProfileSpine,
  setTargetTitles,
  writeProfileSpine,
} from "./queries.js";

// Integration tests for the ARC-68 title-suggestion writes/reads: setTargetTitles
// (approve the chosen ordered set) and readProfileSpine (the symmetric reader that
// feeds the LLM a populated profile). Targets the same migrated Postgres as
// gen-types.sh; point TEST_DATABASE_URL at it to run, skipped otherwise.
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// One synthetic signup, fixed + namespaced (…068) so reruns are idempotent.
const userId = "cccccccc-0000-4000-8000-000000000068";

describe.skipIf(!TEST_DB_URL)("target titles + profile spine read (ARC-68)", () => {
  let sql: postgres.Sql;

  const cleanup = async (db: postgres.Sql) => {
    await db`delete from public.users where id = ${userId}`;
    await db`delete from auth.users where id = ${userId}`;
  };

  beforeAll(async () => {
    sql = postgres(TEST_DB_URL as string, { prepare: false, max: 1 });
  });

  beforeEach(async () => {
    await cleanup(sql);
    await sql`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${userId}, 't@example.com', ${sql.json({ full_name: "Tess" })})`;
  });

  afterAll(async () => {
    await cleanup(sql);
    await sql.end();
  });

  it("setTargetTitles replaces the set in order", async () => {
    // Pre-existing titles that approval must clear.
    await addTargetTitle(sql, userId, "Old Title A");
    await addTargetTitle(sql, userId, "Old Title B");

    const persisted = await setTargetTitles(sql, userId, [
      "Staff Engineer",
      "Senior Backend Engineer",
      "AI Engineer",
    ]);
    expect(persisted.map((t) => t.title)).toEqual([
      "Staff Engineer",
      "Senior Backend Engineer",
      "AI Engineer",
    ]);
    expect(persisted.every((t) => t.is_active)).toBe(true);

    // listTargetTitles returns them in created_at order = insertion order.
    const listed = await listTargetTitles(sql, userId, { activeOnly: true });
    expect(listed.map((t) => t.title)).toEqual([
      "Staff Engineer",
      "Senior Backend Engineer",
      "AI Engineer",
    ]);
  });

  it("setTargetTitles is idempotent for a given list", async () => {
    const titles = ["Platform Engineer", "DevOps Engineer"];
    await setTargetTitles(sql, userId, titles);
    await setTargetTitles(sql, userId, titles);
    const listed = await listTargetTitles(sql, userId, { activeOnly: true });
    expect(listed.map((t) => t.title)).toEqual(titles);
  });

  it("readProfileSpine reads a version's spine back into the draft shape", async () => {
    const version = await createProfileVersion(sql, {
      userId,
      label: "test",
      attributes: { full_name: "Tess" },
    });
    await writeProfileSpine(sql, userId, version.id, {
      workExperiences: [
        {
          title: "Senior Engineer",
          organization: "Acme",
          startDate: "2021-01-01",
          isCurrent: true,
        },
        { title: "Engineer", organization: "Globex", startDate: "2018-01-01" },
      ],
      skills: [{ name: "TypeScript", yearsExperience: 8 }],
      education: [{ institution: "MIT", degree: "BSc", fieldOfStudy: "CS" }],
    });

    const spine = await readProfileSpine(sql, userId, version.id);
    // Work sorted by start_date desc — current role first.
    expect(spine.workExperiences?.map((w) => w.title)).toEqual(["Senior Engineer", "Engineer"]);
    expect(spine.workExperiences?.[0]).toMatchObject({ organization: "Acme", isCurrent: true });
    expect(spine.skills?.[0]).toMatchObject({ name: "TypeScript", yearsExperience: 8 });
    expect(spine.education?.[0]).toMatchObject({ institution: "MIT", fieldOfStudy: "CS" });
    // Lists with no rows are absent, not empty arrays.
    expect(spine.projects).toBeUndefined();
    expect(spine.certifications).toBeUndefined();
    expect(spine.courses).toBeUndefined();
  });

  it("readProfileSpine returns an empty draft for a version with no spine rows", async () => {
    const version = await createProfileVersion(sql, { userId, label: "empty", attributes: {} });
    expect(await readProfileSpine(sql, userId, version.id)).toEqual({});
  });
});
