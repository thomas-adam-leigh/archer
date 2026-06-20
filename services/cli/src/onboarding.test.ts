import app from "@archer/api";
import { createDb, type Db } from "@archer/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiClient } from "./api.js";

// End-to-end proof of the candidate onboarding flow (ARC-28), over the SAME typed
// hc<AppType> client the CLI consumes, mounted on the Hono app in-process. It walks
// the round trip the milestone owns: empty-state gate → onboarding run assembles a
// profile draft in shared state (StateSnapshot + JSON-Patch deltas) → the draft is
// submitted as a proposed VERSION → approve materialises it as the live profile →
// the gate flips and history restore shows the assembled draft.
//
// Like the other DB-backed tests it targets a migrated Postgres. Point
// TEST_DATABASE_URL at it to run:
//   pnpm --filter @archer/cli test (with TEST_DATABASE_URL set)
// Skipped otherwise, so the default no-DB CI vitest run stays green. The typed
// client is still typechecked against AppType in CI, proving no contract drift.
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// A synthetic signup. UUID is fixed + namespaced (…028) so reruns are idempotent.
const userId = "cccccccc-0000-4000-8000-000000000028";

describe.skipIf(!TEST_DB_URL)("ARC-28 — onboarding flow over the typed hc client", () => {
  let sql: Db;
  let threadId: string;

  const cleanup = async (db: Db) => {
    // public.users → threads/profiles/profile_versions/spine cascade; proposals
    // bind by jsonb only, so clear them by the version owner first.
    await db`delete from public.proposals where plan->>'userId' = ${userId}`;
    await db`delete from public.users where id = ${userId}`;
    await db`delete from auth.users where id = ${userId}`;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB_URL;
    process.env.ARCHER_API_DEV_OPEN = "1";
    delete process.env.ARCHER_API_SECRET;

    sql = createDb({ DATABASE_URL: TEST_DB_URL });
    await cleanup(sql);
    // Signup fires on_auth_user_created → public.users + exactly one first thread.
    await sql`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${userId}, 'onboard@example.com', ${sql.json({ full_name: "Onnie" })})`;
    const rows = await sql<{ id: string }[]>`
      select id from public.threads where user_id = ${userId} order by created_at limit 1`;
    threadId = rows[0].id;
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanup(sql);
    await sql.end();
  });

  it("gates on empty state, assembles a draft, and approves it into the live profile", async () => {
    const client = createApiClient({
      baseUrl: "http://onboarding.test",
      fetch: (input, init) => app.request(input, init),
    });

    // ── 1. Empty-state gate: no live version yet → onboarding mode.
    const gate1 = await client.onboarding.state.$get({ query: { user: userId } });
    expect(gate1.status).toBe(200);
    const gate1Body = await gate1.json();
    expect(gate1Body.onboarding).toBe(true);
    expect(gate1Body.liveVersionId).toBeNull();

    // ── 2. Onboarding run: the Guide assembles a draft in shared state and submits
    //       it as a proposed profile version.
    const draft = { ideal_job: "Staff product engineer", ai_fluency: "high" };
    const runRes = await client.onboarding.run.$post({ json: { threadId, draft } });
    expect(runRes.status).toBe(200);
    const runBody = await runRes.json();
    if (!("proposalId" in runBody)) throw new Error("expected an onboarding run");
    expect(runBody.status).toBe("completed");
    expect(runBody.attributes).toEqual(draft);

    // The draft is assembled via JSON-Patch deltas, not snapshotted whole.
    const deltas = (runBody.events as Array<{ type: string }>).filter(
      (e) => e.type === "state_delta",
    );
    expect(deltas.length).toBeGreaterThanOrEqual(2);

    // It is durably backed by a 'submitted' profile_version proposal.
    const submitted = await sql<{ status: string; kind: string }[]>`
      select status, kind from public.proposals where plan->>'userId' = ${userId}`;
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ status: "submitted", kind: "profile_version" });

    // ── 3. Approve: the apply executor materialises the version as the live profile.
    const decideRes = await client.onboarding.proposals[":proposalId"].decide.$post({
      param: { proposalId: runBody.proposalId },
      json: { action: "approve" },
    });
    expect(decideRes.status).toBe(200);
    const decideBody = await decideRes.json();
    expect(decideBody.proposalStatus).toBe("completed");
    expect(decideBody.versionStatus).toBe("approved");

    // profiles.attributes is synced from the now-live version's snapshot.
    const profile = await sql<{ attributes: { ideal_job?: string } }[]>`
      select attributes from public.profiles where user_id = ${userId}`;
    expect(profile[0].attributes.ideal_job).toBe("Staff product engineer");

    // ── 4. The gate flips: the user now has a live version (onboarding complete).
    const gate2 = await client.onboarding.state.$get({ query: { user: userId } });
    const gate2Body = await gate2.json();
    expect(gate2Body.onboarding).toBe(false);
    expect(gate2Body.liveVersionId).toBe(runBody.versionId);

    // ── 5. History restore: the assembled draft is rebuilt from the event log.
    const histRes = await client.agui.threads[":threadId"].history.$get({ param: { threadId } });
    const hist = await histRes.json();
    if (!("state" in hist)) throw new Error("expected history");
    expect((hist.state as { phase?: string }).phase).toBe("draft_ready");
    expect((hist.state as { draft?: { attributes?: unknown } }).draft?.attributes).toEqual(draft);
  });
});
