import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { searchMessages } from "./queries.js";

// Integration test for the tier-2 message corpus search:
//   messages.search_tsv (20260620140000_message_search.sql) + searchMessages().
// Seeds two users' conversations and asserts keyword relevance and own-rows-only
// scoping (a user never sees another user's messages).
//
// Targets the same migrated Postgres as packages/db/scripts/gen-types.sh builds.
// Point TEST_DATABASE_URL at it to run:
//   pnpm --filter @archer/db test (with TEST_DATABASE_URL set)
// Skipped otherwise, so the default no-DB CI vitest run stays green.
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// Two synthetic signups. UUIDs are fixed + namespaced (…022) so reruns are idempotent.
const userA = "aaaaaaaa-0000-4000-8000-000000000022";
const userB = "bbbbbbbb-0000-4000-8000-000000000022";

describe.skipIf(!TEST_DB_URL)("tier-2 message corpus search", () => {
  let sql: postgres.Sql;

  const cleanup = async (db: postgres.Sql) => {
    // public.users → threads → messages cascade, so removing the users clears all.
    await db`delete from public.users where id in (${userA}, ${userB})`;
    await db`delete from auth.users where id in (${userA}, ${userB})`;
  };

  // First thread for a user (the signup trigger bootstraps exactly one).
  const firstThread = async (uid: string) => {
    const rows = await sql<{ id: string }[]>`
      select id from public.threads where user_id = ${uid} order by created_at limit 1`;
    return rows[0].id;
  };

  beforeAll(async () => {
    sql = postgres(TEST_DB_URL as string, { prepare: false, max: 1 });
    await cleanup(sql);

    // Signups fire on_auth_user_created → public.users + first thread.
    await sql`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${userA}, 'a@example.com', ${sql.json({ full_name: "Ada" })}),
             (${userB}, 'b@example.com', ${sql.json({ full_name: "Ben" })})`;

    const threadA = await firstThread(userA);
    const threadB = await firstThread(userB);

    // Seed a conversation per user. Ada talks about TypeScript + salary; Ben also
    // mentions TypeScript, which must never surface in Ada's results.
    await sql`
      insert into public.messages (thread_id, role, content) values
        (${threadA}, 'user', 'I have years of experience with TypeScript and Postgres.'),
        (${threadA}, 'assistant', 'Great — let us discuss your salary expectations and notice period.'),
        (${threadA}, 'user', 'My current salary is competitive and I prefer remote work.'),
        (${threadB}, 'user', 'I also enjoy building things in TypeScript every day.')`;
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanup(sql);
    await sql.end();
  });

  it("returns a user's own messages matching a keyword, best match first", async () => {
    const hits = await searchMessages(sql, userA, "typescript");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.content?.toLowerCase().includes("typescript"))).toBe(true);
    expect(hits[0].rank).toBeGreaterThan(0);
  });

  it("scopes results own-rows-only (never another user's corpus)", async () => {
    // Both users mention TypeScript; each must see only their own message.
    const asA = await searchMessages(sql, userA, "typescript");
    const asB = await searchMessages(sql, userB, "typescript");

    expect(asA).toHaveLength(1);
    expect(asA[0].content).toContain("years of experience");
    expect(asB).toHaveLength(1);
    expect(asB[0].content).toContain("every day");
  });

  it("matches on conversation content beyond the literal keyword (stemming)", async () => {
    // websearch_to_tsquery stems, so 'salaries' matches the stored 'salary' —
    // surfacing both of Ada's salary turns despite the different surface form.
    const hits = await searchMessages(sql, userA, "salaries");
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.content?.includes("salary"))).toBe(true);
  });

  it("can scope a search to a single thread", async () => {
    const threadA = await firstThread(userA);
    const inThread = await searchMessages(sql, userA, "remote", { threadId: threadA });
    expect(inThread).toHaveLength(1);
    expect(inThread[0].thread_id).toBe(threadA);

    // A thread the user does not own yields nothing even on a matching keyword.
    const threadB = await firstThread(userB);
    const crossUser = await searchMessages(sql, userA, "typescript", { threadId: threadB });
    expect(crossUser).toHaveLength(0);
  });

  it("returns no matches for a query absent from the corpus", async () => {
    const hits = await searchMessages(sql, userA, "kubernetes");
    expect(hits).toHaveLength(0);
  });
});
