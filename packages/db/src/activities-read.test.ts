import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { failActivity, listActivities, startActivity, succeedActivity } from "./queries.js";

// Integration test for the activities observability read surface (ARC-43):
//   listActivities() over public.activities (20260619101500_archer_core.sql).
// Seeds two users' activities and asserts own-rows-only scoping (a user never
// sees another user's runs), the type/status filters, and the limit.
//
// Targets the same migrated Postgres as packages/db/scripts/gen-types.sh builds.
// Point TEST_DATABASE_URL at it to run:
//   pnpm --filter @archer/db test (with TEST_DATABASE_URL set)
// Skipped otherwise, so the default no-DB CI vitest run stays green.
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// Two synthetic signups. UUIDs are fixed + namespaced (…043) so reruns are idempotent.
const userA = "aaaaaaaa-0000-4000-8000-000000000043";
const userB = "bbbbbbbb-0000-4000-8000-000000000043";

describe.skipIf(!TEST_DB_URL)("activities read surface", () => {
  let sql: postgres.Sql;

  const cleanup = async (db: postgres.Sql) => {
    // public.users → activities cascade (user_id references users on delete cascade).
    await db`delete from public.users where id in (${userA}, ${userB})`;
    await db`delete from auth.users where id in (${userA}, ${userB})`;
  };

  beforeAll(async () => {
    sql = postgres(TEST_DB_URL as string, { prepare: false, max: 1 });
    await cleanup(sql);

    // Signups fire on_auth_user_created → public.users.
    await sql`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${userA}, 'a43@example.com', ${sql.json({ full_name: "Ada" })}),
             (${userB}, 'b43@example.com', ${sql.json({ full_name: "Ben" })})`;

    // Ada has two runs: a succeeded collect and a failed apply.
    const aCollect = await startActivity(sql, { type: "collect", userId: userA });
    await succeedActivity(sql, aCollect.id, { who: "A-collect" });
    const aApply = await startActivity(sql, { type: "apply", userId: userA });
    await failActivity(sql, aApply.id, "stub failure", { who: "A-apply" });

    // Ben has one run: an in-progress collect that must never surface for Ada.
    await startActivity(sql, { type: "collect", userId: userB, detail: { who: "B-collect" } });
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanup(sql);
    await sql.end();
  });

  it("returns a user's own activities, newest first", async () => {
    const rows = await listActivities(sql, userA);
    expect(rows).toHaveLength(2);
    // Most recent insert (the apply) comes first.
    expect(rows[0].type).toBe("apply");
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error).toBe("stub failure");
  });

  it("scopes results own-rows-only (never another user's runs)", async () => {
    const asA = await listActivities(sql, userA);
    const asB = await listActivities(sql, userB);

    expect(asA.map((r) => (r.detail as { who?: string } | null)?.who).sort()).toEqual([
      "A-apply",
      "A-collect",
    ]);
    expect(asB).toHaveLength(1);
    expect((asB[0].detail as { who?: string }).who).toBe("B-collect");
  });

  it("filters by activity type", async () => {
    const applies = await listActivities(sql, userA, { type: "apply" });
    expect(applies).toHaveLength(1);
    expect(applies[0].type).toBe("apply");
  });

  it("filters by activity status", async () => {
    const succeeded = await listActivities(sql, userA, { status: "succeeded" });
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0].type).toBe("collect");
    expect(succeeded[0].status).toBe("succeeded");
  });

  it("honours the limit", async () => {
    const one = await listActivities(sql, userA, { limit: 1 });
    expect(one).toHaveLength(1);
  });
});
