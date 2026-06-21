import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createCoverLetterVersion,
  getCoverLetterVersion,
  recordCoverLetterSpokenNote,
} from "./queries.js";

// Integration test for the spoken-note artifact (ARC-39): Archer's TTS note for a
// cover letter is stored on the version's `details` jsonb (audio URL + provider).
// Exercises recordCoverLetterSpokenNote against a migrated Postgres — the artifact
// ref is created on the version and a second note replaces the first.
//
// Targets the same migrated Postgres as packages/db/scripts/gen-types.sh builds.
// Point TEST_DATABASE_URL at it to run; skipped otherwise so no-DB CI stays green.
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// One synthetic signup + candidacy. UUIDs are fixed + namespaced (…039) so reruns
// are idempotent.
const userId = "cccccccc-0000-4000-8000-000000000039";
const boardSlug = "test-board-039";

describe.skipIf(!TEST_DB_URL)("cover-letter spoken-note artifact", () => {
  let sql: postgres.Sql;
  let candidacyId: string;

  const cleanup = async (db: postgres.Sql) => {
    await db`delete from public.users where id = ${userId}`;
    await db`delete from auth.users where id = ${userId}`;
    await db`delete from public.postings where board_slug = ${boardSlug}`;
    await db`delete from public.boards where slug = ${boardSlug}`;
  };

  const seedCandidacy = async (db: postgres.Sql): Promise<string> => {
    await db`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${userId}, 'note@example.com', ${db.json({ full_name: "Noa" })})`;
    await db`
      insert into public.boards (slug, name, base_url, cred_env_prefix)
      values (${boardSlug}, 'Test Board', 'https://example.test', 'TEST_BOARD_039')`;
    const posting = await db<{ id: string }[]>`
      insert into public.postings (board_slug, url, title)
      values (${boardSlug}, 'https://example.test/job/1', 'Staff Engineer')
      returning id`;
    const candidacy = await db<{ id: string }[]>`
      insert into public.candidacies (user_id, posting_id, status)
      values (${userId}, ${posting[0].id}, 'drafting')
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

  it("records the spoken-note artifact on the version's details jsonb", async () => {
    const v = await createCoverLetterVersion(sql, {
      candidacyId,
      userId,
      content: "Dear hiring manager,",
    });
    const note = {
      audioUrl: `stub://spoken-notes/${v.id}.mp3`,
      provider: "stub",
      durationMs: 1200,
    };
    const updated = await recordCoverLetterSpokenNote(sql, v.id, note);

    expect((updated.details as { spokenNote?: typeof note }).spokenNote).toEqual(note);
    // Persisted, not just returned.
    const reread = await getCoverLetterVersion(sql, v.id);
    expect((reread?.details as { spokenNote?: typeof note }).spokenNote?.audioUrl).toBe(
      note.audioUrl,
    );
  });

  it("merges the note without clobbering other details keys, and replaces a prior note", async () => {
    const v = await createCoverLetterVersion(sql, {
      candidacyId,
      userId,
      details: { source: "scribe" },
    });
    await recordCoverLetterSpokenNote(sql, v.id, {
      audioUrl: "stub://spoken-notes/first.mp3",
      provider: "stub",
      durationMs: 1000,
    });
    const note2 = {
      audioUrl: "stub://spoken-notes/second.mp3",
      provider: "stub",
      durationMs: 2000,
    };
    const updated = await recordCoverLetterSpokenNote(sql, v.id, note2);

    const details = updated.details as { source?: string; spokenNote?: typeof note2 };
    expect(details.source).toBe("scribe"); // pre-existing key preserved
    expect(details.spokenNote).toEqual(note2); // prior note replaced
  });

  it("throws when the version does not exist", async () => {
    await expect(
      recordCoverLetterSpokenNote(sql, "00000000-0000-4000-8000-000000000000", {
        audioUrl: "stub://x.mp3",
        provider: "stub",
        durationMs: 1,
      }),
    ).rejects.toThrow();
  });
});
