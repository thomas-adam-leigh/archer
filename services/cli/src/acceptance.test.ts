import app from "@archer/api";
import { createDb, type Db } from "@archer/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiClient } from "./api.js";

// End-to-end proof that ties off the Candidate Profile & Onboarding project (ARC-32),
// over the SAME typed hc<AppType> client the CLI consumes, mounted on the Hono app
// in-process. It walks the full project arc the milestone owns —
//   onboarding (empty-state gate) → approved profile version → accepted account —
// and rounds out the version surface (draft → submit → approve → cycle/rollback)
// plus the titles + negative-criteria endpoints the acceptance readiness check keys on.
//
// Like the other DB-backed tests it targets a migrated Postgres. Point
// TEST_DATABASE_URL at it to run:
//   pnpm --filter @archer/cli test (with TEST_DATABASE_URL set)
// Skipped otherwise, so the default no-DB CI vitest run stays green. The typed
// client is still typechecked against AppType in CI, proving no contract drift.
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// A synthetic signup. UUID is fixed + namespaced (…032) so reruns are idempotent.
const userId = "cccccccc-0000-4000-8000-000000000032";

describe.skipIf(!TEST_DB_URL)("ARC-32 — onboarding → approved version → accepted", () => {
  let sql: Db;
  let threadId: string;
  let firstVersionId: string;

  const client = createApiClient({
    baseUrl: "http://acceptance.test",
    fetch: (input, init) => app.request(input, init),
  });

  const cleanup = async (db: Db) => {
    // public.users cascades to threads/profiles/profile_versions/spine/titles/
    // criteria/accounts; proposals bind by jsonb only, so clear them by owner first.
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
      values (${userId}, 'accept@example.com', ${sql.json({ full_name: "Ada" })})`;
    const rows = await sql<{ id: string }[]>`
      select id from public.threads where user_id = ${userId} order by created_at limit 1`;
    threadId = rows[0].id;
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanup(sql);
    await sql.end();
  });

  it("onboards to an approved version, then the owner accepts the account", async () => {
    // ── 1. Empty-state gate: no live version yet → onboarding mode, not accepted.
    const gate1 = await client.onboarding.state.$get({ query: { user: userId } });
    expect((await gate1.json()).onboarding).toBe(true);

    // ── 2. Onboarding run assembles a draft and submits it as a proposed version.
    const draft = { ideal_job: "Staff platform engineer", ai_fluency: "high" };
    const runRes = await client.onboarding.run.$post({ json: { threadId, draft } });
    const runBody = await runRes.json();
    if (!("proposalId" in runBody)) throw new Error("expected an onboarding run");
    firstVersionId = runBody.versionId;

    // ── 3. Approve: the apply executor materialises it as the live profile.
    const decide = await client.onboarding.proposals[":proposalId"].decide.$post({
      param: { proposalId: runBody.proposalId },
      json: { action: "approve" },
    });
    const decideBody = await decide.json();
    expect(decideBody.proposalStatus).toBe("completed");
    expect(decideBody.versionStatus).toBe("approved");

    // The version surface reflects the live version (read).
    const vlist = await client.profile.versions.$get({ query: { user: userId } });
    const vlistBody = await vlist.json();
    if (!("versions" in vlistBody)) throw new Error("expected versions");
    expect(vlistBody.liveVersionId).toBe(firstVersionId);
    expect(vlistBody.versions).toHaveLength(1);

    // ── 4. Readiness needs 1–5 titles + ≥1 negative criterion + an approved version.
    //       Before adding them, accept must be blocked even though a version is live.
    await client.titles.$post({ json: { userId, title: "Staff Platform Engineer" } });
    await client.titles.$post({ json: { userId, title: "Principal Engineer" } });
    await client.criteria.$post({ json: { userId, text: "no on-call rotations" } });

    const titles = await client.titles.$get({ query: { user: userId } });
    expect((await titles.json()).titles).toHaveLength(2);
    const criteria = await client.criteria.$get({ query: { user: userId } });
    expect((await criteria.json()).criteria).toHaveLength(1);

    const stateRes = await client.accounts.state.$get({ query: { user: userId } });
    const stateBody = await stateRes.json();
    expect(stateBody.status).toBe("onboarding");
    expect(stateBody.readiness.ready).toBe(true);

    // ── 5. Submit → owner review → accept (the ≤24h owner gate).
    const submit = await client.accounts.submit.$post({ json: { userId } });
    expect((await submit.json()).status).toBe("submitted");

    const review = await client.accounts[":userId"].decide.$post({
      param: { userId },
      json: { action: "review" },
    });
    expect((await review.json()).status).toBe("under_review");

    const accept = await client.accounts[":userId"].decide.$post({
      param: { userId },
      json: { action: "accept", note: "real, sincere, human" },
    });
    expect(accept.status).toBe(200);
    const acceptBody = await accept.json();
    expect(acceptBody.status).toBe("accepted");

    // The gate is now enforceable: the account is accepted.
    const finalState = await client.accounts.state.$get({ query: { user: userId } });
    expect((await finalState.json()).status).toBe("accepted");
  });

  it("rounds out the version surface: draft → submit → approve → rollback", async () => {
    // ── Draft a second version directly (the non-conversational path).
    const created = await client.profile.versions.$post({
      json: { userId, attributes: { ideal_job: "VP Engineering" }, label: "v2" },
    });
    const createdBody = await created.json();
    if (!("versionId" in createdBody)) throw new Error("expected a draft version");
    const secondVersionId = createdBody.versionId;
    expect(createdBody.status).toBe("draft");

    // Read it back (scoped to the user).
    const show = await client.profile.versions[":id"].$get({
      param: { id: secondVersionId },
      query: { user: userId },
    });
    const showBody = await show.json();
    if (!("version" in showBody)) throw new Error("expected the version");
    expect(showBody.version.status).toBe("draft");

    // Submit → approve: v2 goes live, v1 is superseded.
    const submit = await client.profile.versions[":id"].submit.$post({
      param: { id: secondVersionId },
      json: { userId },
    });
    const submitBody = await submit.json();
    if (!("proposalId" in submitBody)) throw new Error("expected a proposal");
    const approve = await client.onboarding.proposals[":proposalId"].decide.$post({
      param: { proposalId: submitBody.proposalId },
      json: { action: "approve" },
    });
    expect((await approve.json()).versionStatus).toBe("approved");

    const afterApprove = await client.profile.versions.$get({ query: { user: userId } });
    expect((await afterApprove.json()).liveVersionId).toBe(secondVersionId);

    // ── Cycle/rollback to the original version: v1 live again, v2 superseded.
    const rollback = await client.profile.versions[":id"].rollback.$post({
      param: { id: firstVersionId },
      json: { userId },
    });
    expect(rollback.status).toBe(200);
    expect((await rollback.json()).versionStatus).toBe("approved");

    const afterRollback = await client.profile.versions.$get({ query: { user: userId } });
    expect((await afterRollback.json()).liveVersionId).toBe(firstVersionId);

    // profiles.attributes is re-synced from the now-live (original) version.
    const profile = await sql<{ attributes: { ideal_job?: string } }[]>`
      select attributes from public.profiles where user_id = ${userId}`;
    expect(profile[0].attributes.ideal_job).toBe("Staff platform engineer");
  });
});
