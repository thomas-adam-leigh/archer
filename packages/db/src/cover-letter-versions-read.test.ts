import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createCoverLetterVersion,
  listCoverLetterVersionSummaries,
  setActiveCoverLetterVersion,
} from "./queries.js";

// Integration test for the cover-letter version-history read surface (ARC-145):
//   listCoverLetterVersionSummaries() over public.cover_letter_versions
//   (20260620190000_cover_letter_versions.sql). Seeds a candidacy with a couple of
//   versions and asserts the version_no ordering + the summary projection (no heavy
//   content/details payload — that is the single-version read).
//
// Targets the same migrated Postgres as packages/db/scripts/gen-types.sh builds.
// Point TEST_DATABASE_URL at it to run; skipped otherwise so no-DB CI stays green.
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// One synthetic signup + candidacy. UUIDs are fixed + namespaced (…145) so reruns
// are idempotent.
const userId = "cccccccc-0000-4000-8000-000000000145";
const boardSlug = "test-board-145";

describe.skipIf(!TEST_DB_URL)("cover-letter version-history read surface", () => {
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

  const seedCandidacy = async (db: postgres.Sql): Promise<string> => {
    await db`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${userId}, 'cl145@example.com', ${db.json({ full_name: "Cleo" })})`;
    await db`
      insert into public.boards (slug, name, base_url, cred_env_prefix)
      values (${boardSlug}, 'Test Board', 'https://example.test', 'TEST_BOARD_145')`;
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

  it("lists version summaries in version_no order, projecting summary columns only", async () => {
    const v1 = await createCoverLetterVersion(sql, {
      candidacyId,
      userId,
      label: "first pass",
      content: "Dear hiring manager,",
      details: { spoken_note: { audioUrl: "https://cdn.example/n.mp3" } },
    });
    const v2 = await createCoverLetterVersion(sql, { candidacyId, userId });
    await setActiveCoverLetterVersion(sql, candidacyId, v2.id); // v2 → approved

    const summaries = await listCoverLetterVersionSummaries(sql, candidacyId);
    expect(summaries.map((s) => s.id)).toEqual([v1.id, v2.id]);
    expect(summaries[0]).toEqual({
      id: v1.id,
      version_no: 1,
      status: "draft",
      label: "first pass",
      // postgres.js hydrates timestamptz to a Date; the API JSON-encodes it on the wire.
      created_at: expect.any(Date),
    });
    expect(summaries[1].status).toBe("approved");
    expect(summaries[1].label).toBeNull();
    // The projection excludes the heavy payload — no content/details on a summary.
    expect(summaries[0]).not.toHaveProperty("content");
    expect(summaries[0]).not.toHaveProperty("details");
  });

  it("returns an empty list for a candidacy with no versions", async () => {
    expect(await listCoverLetterVersionSummaries(sql, candidacyId)).toEqual([]);
  });
});
