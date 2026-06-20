import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Integration smoke test for the signup round-trip:
//   auth.users insert -> on_auth_user_created -> public.users + first thread,
// and the threads RLS policy (own-rows-only for `authenticated`).
//
// It targets a Postgres with the migrations + auth stub applied — the same shape
// packages/db/scripts/gen-types.sh builds. Point TEST_DATABASE_URL at it to run:
//   pnpm --filter @archer/db test (with TEST_DATABASE_URL set)
// Skipped otherwise, so the default no-DB CI vitest run stays green.
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// Two synthetic signups. UUIDs are fixed + namespaced so reruns are idempotent.
const userA = "aaaaaaaa-0000-4000-8000-000000000018";
const userB = "bbbbbbbb-0000-4000-8000-000000000018";

describe.skipIf(!TEST_DB_URL)("auth bootstrap + threads RLS", () => {
  let sql: postgres.Sql;

  // public.users.id references auth.users (no cascade), and threads cascade off
  // public.users — so tear down public.users first, then the auth row.
  const cleanup = async (db: postgres.Sql) => {
    await db`delete from public.users where id in (${userA}, ${userB})`;
    await db`delete from auth.users where id in (${userA}, ${userB})`;
  };

  beforeAll(async () => {
    sql = postgres(TEST_DB_URL as string, { prepare: false, max: 1 });
    // The stub Postgres has none of Supabase's default grants, so grant the
    // `authenticated` role what Supabase would — this isolates the test to RLS.
    await sql`grant usage on schema public to authenticated`;
    await sql`grant select on all tables in schema public to authenticated`;
    await cleanup(sql);
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanup(sql);
    await sql.end();
  });

  it("provisions a public.users row and one first thread on signup", async () => {
    // Simulate a Supabase Auth signup: the insert fires on_auth_user_created.
    await sql`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${userA}, 'a@example.com', ${sql.json({ full_name: "Ada" })})`;

    const users = await sql`select email, full_name from public.users where id = ${userA}`;
    expect(users).toHaveLength(1);
    expect(users[0].email).toBe("a@example.com");
    expect(users[0].full_name).toBe("Ada");

    // Exactly one bootstrap conversation is ready on first contact.
    const threads = await sql`select id from public.threads where user_id = ${userA}`;
    expect(threads).toHaveLength(1);
  });

  it("scopes threads to the authenticated owner (own-rows-only)", async () => {
    await sql`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${userB}, 'b@example.com', ${sql.json({})})`;

    // Read threads as each authenticated user; auth.uid() resolves from the JWT
    // sub claim, and RLS must return only that user's rows — never the other's.
    const ownThreads = async (uid: string) =>
      await sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claim.sub', ${uid}, true)`;
        await tx`set local role authenticated`;
        return await tx<{ user_id: string }[]>`select user_id from public.threads`;
      });

    const asA = await ownThreads(userA);
    expect(asA).toHaveLength(1);
    expect(asA.every((r) => r.user_id === userA)).toBe(true);

    const asB = await ownThreads(userB);
    expect(asB).toHaveLength(1);
    expect(asB.every((r) => r.user_id === userB)).toBe(true);
  });
});
