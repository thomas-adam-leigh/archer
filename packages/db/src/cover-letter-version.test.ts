import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createCoverLetterVersion,
  getActiveCoverLetterVersion,
  getCoverLetterVersion,
  listCoverLetterVersions,
  setActiveCoverLetterVersion,
} from "./queries.js";

// Integration test for cover-letter version history (ARC-14): whole-version rows
// per candidacy with one active version, mirroring the profile version model.
// Exercises create → list → get → setActive (and the cycle/supersede invariant)
// against a migrated Postgres.
//
// Targets the same migrated Postgres as packages/db/scripts/gen-types.sh builds.
// Point TEST_DATABASE_URL at it to run; skipped otherwise so no-DB CI stays green.
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// One synthetic signup + candidacy. UUIDs are fixed + namespaced (…014) so reruns
// are idempotent.
const userId = "cccccccc-0000-4000-8000-000000000014";
const boardSlug = "test-board-014";

describe.skipIf(!TEST_DB_URL)("cover-letter version history", () => {
  let sql: postgres.Sql;
  let candidacyId: string;

  const cleanup = async (db: postgres.Sql) => {
    // users cascades to candidacies → cover_letter_versions; postings hang off the
    // board, so drop them explicitly before the board.
    await db`delete from public.users where id = ${userId}`;
    await db`delete from auth.users where id = ${userId}`;
    await db`delete from public.postings where board_slug = ${boardSlug}`;
    await db`delete from public.boards where slug = ${boardSlug}`;
  };

  // A minimal board → posting → candidacy chain to hang cover-letter versions off.
  const seedCandidacy = async (db: postgres.Sql): Promise<string> => {
    await db`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${userId}, 'cl@example.com', ${db.json({ full_name: "Cleo" })})`;
    await db`
      insert into public.boards (slug, name, base_url, cred_env_prefix)
      values (${boardSlug}, 'Test Board', 'https://example.test', 'TEST_BOARD_014')`;
    const posting = await db<{ id: string }[]>`
      insert into public.postings (board_slug, url, title)
      values (${boardSlug}, 'https://example.test/job/1', 'Staff Engineer')
      returning id`;
    const candidacy = await db<{ id: string }[]>`
      insert into public.candidacies (user_id, posting_id, status)
      values (${userId}, ${posting[0].id}, 'awaiting_cover_letter')
      returning id`;
    return candidacy[0].id;
  };

  beforeAll(async () => {
    sql = postgres(TEST_DB_URL as string, { prepare: false, max: 1 });
  });

  beforeEach(async () => {
    await cleanup(sql);
    candidacyId = await seedCandidacy(sql);
  });

  afterAll(async () => {
    await cleanup(sql);
    await sql.end();
  });

  it("creates versions with monotonic per-candidacy version_no, listed in order", async () => {
    const v1 = await createCoverLetterVersion(sql, {
      candidacyId,
      userId,
      label: "first pass",
      content: "Dear hiring manager,",
    });
    const v2 = await createCoverLetterVersion(sql, { candidacyId, userId });
    expect(v1.version_no).toBe(1);
    expect(v2.version_no).toBe(2);
    expect(v1.status).toBe("draft");
    expect(v1.content).toBe("Dear hiring manager,");
    expect(v2.content).toBe(""); // defaults empty until the Scribe fills it

    const versions = await listCoverLetterVersions(sql, candidacyId);
    expect(versions.map((v) => v.id)).toEqual([v1.id, v2.id]);
  });

  it("getCoverLetterVersion returns a row by id, undefined when absent", async () => {
    const v = await createCoverLetterVersion(sql, { candidacyId, userId });
    expect((await getCoverLetterVersion(sql, v.id))?.id).toBe(v.id);
    expect(
      await getCoverLetterVersion(sql, "00000000-0000-4000-8000-000000000000"),
    ).toBeUndefined();
  });

  it("has no active version until one is set", async () => {
    await createCoverLetterVersion(sql, { candidacyId, userId });
    expect(await getActiveCoverLetterVersion(sql, candidacyId)).toBeUndefined();
  });

  it("setActive makes exactly one version active and supersedes the prior (cycle)", async () => {
    const v1 = await createCoverLetterVersion(sql, { candidacyId, userId });
    const v2 = await createCoverLetterVersion(sql, { candidacyId, userId });

    const active1 = await setActiveCoverLetterVersion(sql, candidacyId, v1.id);
    expect(active1.status).toBe("approved");
    expect((await getActiveCoverLetterVersion(sql, candidacyId))?.id).toBe(v1.id);

    // Promoting v2 supersedes v1 — at most one active version per candidacy.
    const active2 = await setActiveCoverLetterVersion(sql, candidacyId, v2.id);
    expect(active2.status).toBe("approved");
    expect((await getActiveCoverLetterVersion(sql, candidacyId))?.id).toBe(v2.id);
    expect((await getCoverLetterVersion(sql, v1.id))?.status).toBe("superseded");
  });

  it("setActive rejects a version that does not belong to the candidacy", async () => {
    await expect(
      setActiveCoverLetterVersion(sql, candidacyId, "00000000-0000-4000-8000-000000000000"),
    ).rejects.toThrow(/not found for candidacy/);
  });
});
