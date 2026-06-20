import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ingestVoicenote, searchMessages } from "./queries.js";

// Integration test for voicenote ingest (ARC-30): a transcribed voicenote becomes
// a tier-2 transcript MESSAGE on the thread (never a profile mutation), plus a
// `transcribe` activity recording the raw-audio storage reference. Asserts the
// transcript→message persistence and that it lands in the tier-2 search corpus.
//
// Targets the same migrated Postgres as packages/db/scripts/gen-types.sh builds.
// Point TEST_DATABASE_URL at it to run; skipped otherwise so no-DB CI stays green.
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// One synthetic signup. UUID is fixed + namespaced (…030) so reruns are idempotent.
const userId = "cccccccc-0000-4000-8000-000000000030";

describe.skipIf(!TEST_DB_URL)("voicenote ingest → transcript message", () => {
  let sql: postgres.Sql;

  const cleanup = async (db: postgres.Sql) => {
    // public.users → threads → messages cascade, so removing the user clears them.
    await db`delete from public.activities where user_id = ${userId}`;
    await db`delete from public.users where id = ${userId}`;
    await db`delete from auth.users where id = ${userId}`;
  };

  // The first thread the signup trigger bootstraps for a user.
  const firstThread = async () => {
    const rows = await sql<{ id: string }[]>`
      select id from public.threads where user_id = ${userId} order by created_at limit 1`;
    return rows[0].id;
  };

  beforeAll(async () => {
    sql = postgres(TEST_DB_URL as string, { prepare: false, max: 1 });
  });

  beforeEach(async () => {
    await cleanup(sql);
    // Signup fires on_auth_user_created → public.users + first thread.
    await sql`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${userId}, 'v@example.com', ${sql.json({ full_name: "Vera" })})`;
  });

  afterAll(async () => {
    await cleanup(sql);
    await sql.end();
  });

  it("persists the transcript as a thread message and a succeeded transcribe activity", async () => {
    const threadId = await firstThread();
    const result = await ingestVoicenote(sql, {
      threadId,
      userId,
      storageRef: "s3://uploads/note.m4a",
      filename: "note.m4a",
      transcript: "I led the migration of our billing system to Postgres.",
      provider: "stub",
    });

    // The transcript is stored as a user message on the thread (tier-2 memory).
    const message = await sql<{ thread_id: string; role: string; content: string }[]>`
      select thread_id, role, content from messages where id = ${result.messageId}`;
    expect(message[0]).toMatchObject({ thread_id: threadId, role: "user" });
    expect(message[0].content).toContain("billing system");

    // A succeeded `transcribe` activity records the raw-audio storage reference.
    const activity = await sql<{ type: string; status: string; detail: { storageRef?: string } }[]>`
      select type, status, detail from activities where id = ${result.activityId}`;
    expect(activity[0]).toMatchObject({ type: "transcribe", status: "succeeded" });
    expect(activity[0].detail.storageRef).toBe("s3://uploads/note.m4a");
  });

  it("makes the transcript searchable in the tier-2 corpus", async () => {
    const threadId = await firstThread();
    await ingestVoicenote(sql, {
      threadId,
      userId,
      storageRef: "s3://uploads/note.m4a",
      transcript: "My deepest experience is in distributed systems and Kafka.",
      provider: "stub",
    });

    const hits = await searchMessages(sql, userId, "kafka");
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toContain("Kafka");
  });
});
