import {
  createCoverLetterVersion,
  createDb,
  createExternalApplicationForm,
  type Db,
  type Enums,
  getCandidacy,
  getExternalApplicationForm,
  insertCandidacy,
  setActiveCoverLetterVersion,
  setCandidacyStatus,
  upsertCompany,
  upsertPosting,
} from "@archer/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createArcherMcp } from "./archer-mcp.js";
import { type Filler, runExternalFill, stubFiller } from "./commands/external-fill.js";

// Proves the external-fill orchestration (ARC-41): one `archer external-fill` run is
// wrapped in a single `external_fill` Activity that ends succeeded/failed; the
// candidacy walks external_pending → applied | application_failed; the open
// external_application_form walks in_progress → completed | failed in lock-step;
// the (stubbed) browser agent reads the candidate + writes status only through the
// least-privilege Archer MCP surface; a candidacy with no open form is an
// idempotent no-op (no Activity — the fill never re-submits).
//
// The end-to-end run is DB-backed: point TEST_DATABASE_URL at a migrated Postgres
// to exercise it (skipped otherwise, keeping CI green). The orchestration + the MCP
// surface are still typechecked in CI, which is what proves there is no drift.

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const USER = "dddddddd-0000-4000-8000-000000000041";
const URL_PREFIX = "https://cj.test/arc41/";
const COMPANY_PREFIX = "Fill Co Arc41";

describe.skipIf(!TEST_DB_URL)("ARC-41 — external-fill orchestration (stubbed)", () => {
  let sql: Db;

  const purge = async (db: Db) => {
    await db`delete from public.external_application_forms where user_id = ${USER}`;
    await db`delete from public.notifications where user_id = ${USER}`;
    await db`delete from public.activities where user_id = ${USER}`;
    await db`delete from public.candidacies where user_id = ${USER}`;
    await db`delete from public.postings where url like ${`${URL_PREFIX}%`}`;
    await db`delete from public.companies where name like ${`${COMPANY_PREFIX}%`}`;
    await db`delete from public.users where id = ${USER}`;
    await db`delete from auth.users where id = ${USER}`;
  };

  /** Seed an external_pending candidacy with an active approved letter and an open
   *  external form (unless `withForm` is false). Each key gets its own posting. */
  const seed = async (
    key: string,
    opts: { status?: Enums<"candidacy_status">; withForm?: boolean } = {},
  ): Promise<{ candidacyId: string; formId: string | null }> => {
    const companyId = await upsertCompany(sql, `${COMPANY_PREFIX} ${key}`);
    const { id: postingId } = await upsertPosting(sql, {
      boardSlug: "careerjunction",
      url: `${URL_PREFIX}${key}`,
      title: `Fill Role ${key}`,
      companyId,
    });
    const created = await insertCandidacy(sql, USER, postingId);
    let candidacyId = created?.id;
    if (!candidacyId) {
      const [row] = await sql<{ id: string }[]>`
        select id from public.candidacies where user_id = ${USER} and posting_id = ${postingId}`;
      candidacyId = row.id;
    }
    const v = await createCoverLetterVersion(sql, {
      candidacyId,
      userId: USER,
      label: "draft",
      content: "Dear hiring team, I am excited to apply.",
    });
    await setActiveCoverLetterVersion(sql, candidacyId, v.id);
    await setCandidacyStatus(sql, candidacyId, opts.status ?? "external_pending");
    let formId: string | null = null;
    if (opts.withForm !== false) {
      const form = await createExternalApplicationForm(sql, {
        candidacyId,
        userId: USER,
        url: `https://apply.example/form/${key}`,
        coverLetterVersionId: v.id,
      });
      formId = form.id;
    }
    return { candidacyId, formId };
  };

  const activityFor = async (id: string) =>
    (
      await sql<{ type: string; status: string; error: string | null; detail: unknown }[]>`
        select type, status, error, detail from public.activities where id = ${id}`
    )[0];

  const notificationsFor = async (candidacyId: string) =>
    await sql<{ title: string; body: string | null }[]>`
      select title, body from public.notifications
      where user_id = ${USER} and kind = 'application' and ref->>'candidacyId' = ${candidacyId}`;

  beforeAll(async () => {
    sql = createDb({ DATABASE_URL: TEST_DB_URL });
    await purge(sql);
    await sql`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${USER}, 'arc41@example.com', ${sql.json({ full_name: "Arc41" })})
      on conflict (id) do nothing`;
  });

  afterAll(async () => {
    if (!sql) return;
    await purge(sql);
    await sql.end();
  });

  it("completed: applied, form completed, external_fill Activity succeeded (default stub)", async () => {
    const { candidacyId, formId } = await seed("done");
    const summary = await runExternalFill(sql, { candidacyId });
    expect(summary.skipped).toBe(false);
    expect(summary.outcome).toBe("completed");
    expect(summary.status).toBe("applied");
    expect(summary.formId).toBe(formId);

    expect((await getCandidacy(sql, candidacyId))?.status).toBe("applied");
    expect((await getExternalApplicationForm(sql, formId as string))?.status).toBe("completed");
    const act = await activityFor(summary.activityId as string);
    expect(act.type).toBe("external_fill");
    expect(act.status).toBe("succeeded");
    expect((act.detail as { reference?: string }).reference).toBe(
      `stub-external-careerjunction-${candidacyId}`,
    );

    // The external_pending → applied transition lands a notification too.
    const notes = await notificationsFor(candidacyId);
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe("Applied to Fill Role done");
  });

  it("structured failure: application_failed, form failed with error, Activity failed", async () => {
    const { candidacyId, formId } = await seed("fail");
    const failing: Filler = () => ({ kind: "failed", reason: "captcha blocked the form" });
    const summary = await runExternalFill(sql, { candidacyId, fill: failing });
    expect(summary.outcome).toBe("failed");
    expect(summary.status).toBe("application_failed");

    expect((await getCandidacy(sql, candidacyId))?.status).toBe("application_failed");
    const form = await getExternalApplicationForm(sql, formId as string);
    expect(form?.status).toBe("failed");
    expect(form?.error).toContain("captcha blocked");
    const act = await activityFor(summary.activityId as string);
    expect(act.status).toBe("failed");
    expect(act.error).toContain("captcha blocked");

    const notes = await notificationsFor(candidacyId);
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toContain("failed");
    expect(notes[0].body).toContain("captcha blocked");
  });

  it("an unexpected thrown agent fails the form + Activity, sets application_failed, rethrows", async () => {
    const { candidacyId, formId } = await seed("throw");
    const boom: Filler = () => {
      throw new Error("browser crashed mid-fill");
    };
    await expect(runExternalFill(sql, { candidacyId, fill: boom })).rejects.toThrow(
      /browser crashed/,
    );
    expect((await getCandidacy(sql, candidacyId))?.status).toBe("application_failed");
    expect((await getExternalApplicationForm(sql, formId as string))?.status).toBe("failed");
  });

  it("reads the candidate through the Archer MCP surface (the agent's only privilege)", async () => {
    const { candidacyId } = await seed("seam");
    let sawLetter = "";
    let sawCompany: string | null = null;
    const mock: Filler = async ({ mcp }) => {
      sawLetter = (await mcp.read_cover_letter())?.content ?? "";
      sawCompany = (await mcp.read_enriched_company())?.name ?? null;
      return { kind: "completed", reference: "MOCK-REF" };
    };
    const summary = await runExternalFill(sql, { candidacyId, fill: mock });
    expect(summary.status).toBe("applied");
    expect(sawLetter).toContain("excited to apply");
    expect(sawCompany).toContain(COMPANY_PREFIX);
    const act = await activityFor(summary.activityId as string);
    expect((act.detail as { reference?: string }).reference).toBe("MOCK-REF");
  });

  it("is idempotent — a candidacy with no open form is a no-op (no Activity)", async () => {
    const { candidacyId } = await seed("noform", { withForm: false });
    const summary = await runExternalFill(sql, { candidacyId });
    expect(summary.skipped).toBe(true);
    expect(summary.outcome).toBeNull();
    expect(summary.activityId).toBeNull();
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.activities
      where candidacy_id = ${candidacyId} and type = 'external_fill'`;
    expect(n).toBe(0);
  });

  it("refuses an open form on a non-external_pending candidacy (fail-closed gate)", async () => {
    const { candidacyId } = await seed("gate", { status: "approved" });
    await expect(runExternalFill(sql, { candidacyId })).rejects.toThrow(
      /gated to external_pending/,
    );
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.activities
      where candidacy_id = ${candidacyId} and type = 'external_fill'`;
    expect(n).toBe(0);
  });

  it("throws for an unknown candidacy", async () => {
    await expect(
      runExternalFill(sql, { candidacyId: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toThrow(/unknown candidacy/);
  });

  it("the Archer MCP write tool rejects an out-of-surface status", async () => {
    const { candidacyId, formId } = await seed("mcp");
    const mcp = createArcherMcp({ db: sql, candidacyId, userId: USER, formId: formId as string });
    // @ts-expect-error — 'pending' is not a writable status on the surface.
    await expect(mcp.update_external_status({ status: "pending" })).rejects.toThrow(
      /invalid status/,
    );
  });
});
