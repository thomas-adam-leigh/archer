import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createExternalApplicationForm,
  getExternalApplicationForm,
  getOpenExternalApplicationForm,
  openExternalApplicationForm,
  setExternalApplicationFormStatus,
} from "./queries.js";

// Integration test for the off-board redirect record (ARC-41): one
// external_application_form per redirect, walking pending → in_progress →
// completed | failed, plus the openExternalApplicationForm transaction that raises
// the form + owner-facing proposal + notification together.
//
// Targets the same migrated Postgres as packages/db/scripts/gen-types.sh builds.
// Point TEST_DATABASE_URL at it to run; skipped otherwise so no-DB CI stays green.
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

const userId = "cccccccc-0000-4000-8000-000000000041";
const boardSlug = "test-board-041";

describe.skipIf(!TEST_DB_URL)("external application forms", () => {
  let sql: postgres.Sql;
  let candidacyId: string;

  const cleanup = async (db: postgres.Sql) => {
    await db`delete from public.proposals where candidacy_id in (
      select id from public.candidacies where user_id = ${userId})`;
    await db`delete from public.users where id = ${userId}`;
    await db`delete from auth.users where id = ${userId}`;
    await db`delete from public.postings where board_slug = ${boardSlug}`;
    await db`delete from public.boards where slug = ${boardSlug}`;
  };

  const seedCandidacy = async (db: postgres.Sql): Promise<string> => {
    await db`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${userId}, 'eaf@example.com', ${db.json({ full_name: "Eddie" })})`;
    await db`
      insert into public.boards (slug, name, base_url, cred_env_prefix)
      values (${boardSlug}, 'Test Board', 'https://example.test', 'TEST_BOARD_041')`;
    const posting = await db<{ id: string }[]>`
      insert into public.postings (board_slug, url, title)
      values (${boardSlug}, 'https://example.test/job/41', 'Staff Engineer')
      returning id`;
    const candidacy = await db<{ id: string }[]>`
      insert into public.candidacies (user_id, posting_id, status)
      values (${userId}, ${posting[0].id}, 'external_pending')
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

  it("creates a pending form and reads it back as the candidacy's open form", async () => {
    const form = await createExternalApplicationForm(sql, {
      candidacyId,
      userId,
      url: "https://apply.example/form/41",
    });
    expect(form.status).toBe("pending");
    expect(form.started_at).toBeNull();

    const open = await getOpenExternalApplicationForm(sql, candidacyId);
    expect(open?.id).toBe(form.id);
    expect((await getExternalApplicationForm(sql, form.id))?.url).toBe(
      "https://apply.example/form/41",
    );
  });

  it("walks pending → in_progress → completed, stamping the timestamps", async () => {
    const form = await createExternalApplicationForm(sql, {
      candidacyId,
      userId,
      url: "https://apply.example/form/41",
    });
    await setExternalApplicationFormStatus(sql, form.id, "in_progress");
    let row = await getExternalApplicationForm(sql, form.id);
    expect(row?.status).toBe("in_progress");
    expect(row?.started_at).not.toBeNull();
    expect(row?.finished_at).toBeNull();

    await setExternalApplicationFormStatus(sql, form.id, "completed", {
      detail: { reference: "REF-1" } as never,
    });
    row = await getExternalApplicationForm(sql, form.id);
    expect(row?.status).toBe("completed");
    expect(row?.finished_at).not.toBeNull();
    expect((row?.detail as { reference?: string }).reference).toBe("REF-1");

    // A completed form is no longer "open".
    expect(await getOpenExternalApplicationForm(sql, candidacyId)).toBeUndefined();
  });

  it("records an error on failure", async () => {
    const form = await createExternalApplicationForm(sql, {
      candidacyId,
      userId,
      url: "https://apply.example/form/41",
    });
    await setExternalApplicationFormStatus(sql, form.id, "failed", { error: "captcha blocked" });
    const row = await getExternalApplicationForm(sql, form.id);
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("captcha blocked");
  });

  it("openExternalApplicationForm raises the form + proposal + notification atomically", async () => {
    const { formId, proposalId } = await openExternalApplicationForm(sql, {
      candidacyId,
      userId,
      url: "https://apply.example/form/41",
      detail: { board: boardSlug } as never,
    });

    const form = await getExternalApplicationForm(sql, formId);
    expect(form?.status).toBe("pending");
    expect(form?.url).toBe("https://apply.example/form/41");

    const [proposal] = await sql<
      { kind: string; status: string; candidacy_id: string; plan: { url?: string } }[]
    >`select kind, status, candidacy_id, plan from public.proposals where id = ${proposalId}`;
    expect(proposal.kind).toBe("external_application");
    expect(proposal.status).toBe("submitted");
    expect(proposal.candidacy_id).toBe(candidacyId);
    expect(proposal.plan.url).toBe("https://apply.example/form/41");

    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.notifications
      where user_id = ${userId} and kind = 'application'`;
    expect(n).toBe(1);
  });

  it("enforces at most one OPEN form per candidacy (partial unique index)", async () => {
    await createExternalApplicationForm(sql, { candidacyId, userId, url: "https://a.example/1" });
    await expect(
      createExternalApplicationForm(sql, { candidacyId, userId, url: "https://a.example/2" }),
    ).rejects.toThrow();
  });
});
