import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Integration test for the `resumes` Storage bucket owner-RLS (ARC-62): each user
// may read/write objects only under resumes/{their uid}/…, never another user's
// folder. Targets a Postgres with the migrations + the bootstrap storage stub
// applied — the same shape packages/db/scripts/gen-types.sh builds. Point
// TEST_DATABASE_URL at it to run:
//   pnpm --filter @archer/db test (with TEST_DATABASE_URL set)
// Skipped otherwise, so the default no-DB CI vitest run stays green.
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// Two synthetic uploaders. UUIDs are fixed + namespaced so reruns are idempotent.
const userA = "aaaaaaaa-0000-4000-8000-000000000062";
const userB = "bbbbbbbb-0000-4000-8000-000000000062";

describe.skipIf(!TEST_DB_URL)("resumes bucket owner RLS", () => {
  let sql: postgres.Sql;

  const cleanup = async (db: postgres.Sql) => {
    await db`
      delete from storage.objects
      where bucket_id = 'resumes' and (storage.foldername(name))[1] in (${userA}, ${userB})`;
  };

  // Act as an authenticated user: jwt sub = uid resolves auth.uid(), role gates RLS.
  const insertAs = (uid: string, name: string) =>
    sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claim.sub', ${uid}, true)`;
      await tx`set local role authenticated`;
      return await tx<{ id: string }[]>`
        insert into storage.objects (bucket_id, name) values ('resumes', ${name}) returning id`;
    });

  const listAs = (uid: string) =>
    sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claim.sub', ${uid}, true)`;
      await tx`set local role authenticated`;
      return await tx<
        { name: string }[]
      >`select name from storage.objects where bucket_id = 'resumes'`;
    });

  beforeAll(async () => {
    sql = postgres(TEST_DB_URL as string, { prepare: false, max: 1 });
    // Grant `authenticated` what Supabase would on the storage schema, so the test
    // isolates behaviour to the RLS policy (not missing table privileges).
    await sql`grant usage on schema storage to authenticated`;
    await sql`grant select, insert, update, delete on storage.objects to authenticated`;
    await cleanup(sql);
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanup(sql);
    await sql.end();
  });

  it("lets a user write under their own uid folder", async () => {
    const inserted = await insertAs(userA, `${userA}/cv.pdf`);
    expect(inserted).toHaveLength(1);

    const rows = await listAs(userA);
    expect(rows.map((r) => r.name)).toContain(`${userA}/cv.pdf`);
  });

  it("rejects writing into another user's folder", async () => {
    await expect(insertAs(userA, `${userB}/cv.pdf`)).rejects.toThrow();
  });

  it("scopes reads to the owner's folder only", async () => {
    await insertAs(userB, `${userB}/resume.pdf`);

    const asA = await listAs(userA);
    expect(asA.every((r) => r.name.startsWith(`${userA}/`))).toBe(true);
    expect(asA.some((r) => r.name.startsWith(`${userB}/`))).toBe(false);
  });
});
