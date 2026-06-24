import {
  confirmApply,
  createCoverLetterVersion,
  createDb,
  type Db,
  type Enums,
  getCandidacy,
  getOpenExternalApplicationForm,
  insertCandidacy,
  setActiveCoverLetterVersion,
  setCandidacyStatus,
  upsertCompany,
  upsertPosting,
} from "@archer/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Applier, runApply, stubApplier } from "./commands/apply.js";

// Proves the approve-to-apply orchestration (ARC-40): one `archer apply` run is
// wrapped in a single `apply` Activity that ends succeeded/failed; the candidacy
// walks approved → applying → applied | external_pending | application_failed; the
// (stubbed) apply adapter is a swappable seam returning the three outcomes; an
// already-applied candidacy is an idempotent no-op (no Activity — apply is
// irreversible); and a non-approved candidacy (or one with no active letter) is
// refused fail-closed before any status change or Activity.
//
// The deterministic `stubApplier` is pure, so its tests run in the default no-DB CI
// vitest pass. The end-to-end run is DB-backed: point TEST_DATABASE_URL at a migrated
// Postgres to exercise it (skipped otherwise, keeping CI green). The orchestration is
// still typechecked in CI, which is what proves there is no contract drift.

describe("stubApplier — deterministic apply adapter stand-in", () => {
  it("returns the on-board submitted outcome with a synthetic reference", async () => {
    const outcome = await stubApplier({
      candidacy: { id: "cand-1", role: "Engineer", company: "Acme", boardSlug: "careerjunction" },
      coverLetter: { versionId: "v-1", content: "Dear team" },
      log: () => {},
    });
    expect(outcome.kind).toBe("submitted");
    if (outcome.kind === "submitted") {
      expect(outcome.reference).toBe("stub-careerjunction-cand-1");
      expect(outcome.detail?.board).toBe("careerjunction");
    }
  });
});

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const USER = "dddddddd-0000-4000-8000-000000000040";
const URL_PREFIX = "https://cj.test/arc40/";
const COMPANY_PREFIX = "Apply Co Arc40";

describe.skipIf(!TEST_DB_URL)("ARC-40 — approve-to-apply orchestration (stubbed)", () => {
  let sql: Db;

  const purge = async (db: Db) => {
    await db`delete from public.external_application_forms where user_id = ${USER}`;
    await db`delete from public.notifications where user_id = ${USER}`;
    await db`delete from public.proposals where candidacy_id in (
      select id from public.candidacies where user_id = ${USER})`;
    await db`delete from public.activities where user_id = ${USER}`;
    await db`delete from public.candidacies where user_id = ${USER}`;
    await db`delete from public.postings where url like ${`${URL_PREFIX}%`}`;
    await db`delete from public.companies where name like ${`${COMPANY_PREFIX}%`}`;
    await db`delete from public.users where id = ${USER}`;
    await db`delete from auth.users where id = ${USER}`;
  };

  /** Seed a candidacy in `status` (default approved), with an active approved
   *  cover-letter version unless `withLetter` is false. Each `key` gets its own
   *  posting/company so a status-mutating apply never collides with another test.
   *  An `approved` candidacy is apply-confirmed by default (ARC-165) so it passes the
   *  apply-confirm gate — pass `confirmed: false` to leave it awaiting confirmation. */
  const seed = async (
    key: string,
    opts: {
      status?: Enums<"candidacy_status">;
      withLetter?: boolean;
      confirmed?: boolean;
    } = {},
  ): Promise<string> => {
    const companyId = await upsertCompany(sql, `${COMPANY_PREFIX} ${key}`);
    const { id: postingId } = await upsertPosting(sql, {
      boardSlug: "careerjunction",
      url: `${URL_PREFIX}${key}`,
      title: `Apply Role ${key}`,
      companyId,
    });
    const created = await insertCandidacy(sql, USER, postingId);
    let candidacyId = created?.id;
    if (!candidacyId) {
      const [row] = await sql<{ id: string }[]>`
        select id from public.candidacies where user_id = ${USER} and posting_id = ${postingId}`;
      candidacyId = row.id;
    }
    if (opts.withLetter !== false) {
      const v = await createCoverLetterVersion(sql, {
        candidacyId,
        userId: USER,
        label: "draft",
        content: "Dear hiring team, I am excited to apply.",
      });
      await setActiveCoverLetterVersion(sql, candidacyId, v.id);
    }
    const status = opts.status ?? "approved";
    await setCandidacyStatus(sql, candidacyId, status);
    // Apply-confirm gate (ARC-165): an approved candidacy is confirmed by default so
    // the existing approve-to-apply cases pass the gate; opt out with confirmed:false.
    if (status === "approved" && opts.confirmed !== false) {
      await confirmApply(sql, candidacyId);
    }
    return candidacyId;
  };

  const activityFor = async (id: string) =>
    (
      await sql<{ type: string; status: string; error: string | null; detail: unknown }[]>`
        select type, status, error, detail from public.activities where id = ${id}`
    )[0];

  // Notifications for a candidacy (scoped by ref so the per-USER count is order-
  // independent across the cases in this describe).
  const notificationsFor = async (candidacyId: string) =>
    await sql<{ title: string; body: string | null }[]>`
      select title, body from public.notifications
      where user_id = ${USER} and kind = 'application' and ref->>'candidacyId' = ${candidacyId}`;

  beforeAll(async () => {
    sql = createDb({ DATABASE_URL: TEST_DB_URL });
    await purge(sql);
    // Signup fires on_auth_user_created → public.users (the candidacy FK target).
    await sql`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${USER}, 'arc40@example.com', ${sql.json({ full_name: "Arc40" })})
      on conflict (id) do nothing`;
  });

  afterAll(async () => {
    if (!sql) return;
    await purge(sql);
    await sql.end();
  });

  it("on-board success: applied, with a succeeded Activity (default stub)", async () => {
    const id = await seed("onboard");
    const summary = await runApply(sql, { candidacyId: id });
    expect(summary.skipped).toBe(false);
    expect(summary.outcome).toBe("submitted");
    expect(summary.status).toBe("applied");
    expect(summary.activityId).not.toBeNull();

    expect((await getCandidacy(sql, id))?.status).toBe("applied");
    const act = await activityFor(summary.activityId as string);
    expect(act.type).toBe("apply");
    expect(act.status).toBe("succeeded");
    expect((act.detail as { reference?: string }).reference).toBe(`stub-careerjunction-${id}`);

    // Each apply-phase transition lands a notification + an activity-feed event.
    const notes = await notificationsFor(id);
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe(`Applied to Apply Role onboard`);
  });

  it("off-board redirect: external_pending, with a succeeded Activity carrying the URL", async () => {
    const id = await seed("redirect");
    const redirect: Applier = () => ({ kind: "redirect", url: "https://apply.example/form/123" });
    const summary = await runApply(sql, { candidacyId: id, apply: redirect });
    expect(summary.outcome).toBe("redirect");
    expect(summary.status).toBe("external_pending");

    expect((await getCandidacy(sql, id))?.status).toBe("external_pending");
    const act = await activityFor(summary.activityId as string);
    expect(act.status).toBe("succeeded");
    expect((act.detail as { redirectUrl?: string }).redirectUrl).toBe(
      "https://apply.example/form/123",
    );

    // ARC-41: the redirect raises the durable external-form record + an owner-facing
    // proposal carrying the URL + a notification — the hand-off into external-fill.
    const form = await getOpenExternalApplicationForm(sql, id);
    expect(form?.status).toBe("pending");
    expect(form?.url).toBe("https://apply.example/form/123");
    const [proposal] = await sql<{ kind: string; plan: { url?: string } }[]>`
      select kind, plan from public.proposals where candidacy_id = ${id} order by created_at desc limit 1`;
    expect(proposal.kind).toBe("external_application");
    expect(proposal.plan.url).toBe("https://apply.example/form/123");
    // The redirect hand-off pushes exactly one application notification (apply itself
    // does not double-notify on the redirect branch).
    const notes = await notificationsFor(id);
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe("An external application needs completing");
  });

  it("structured failure: application_failed, with a failed Activity + error", async () => {
    const id = await seed("fail");
    const failing: Applier = () => ({ kind: "failed", reason: "form fields not found" });
    const summary = await runApply(sql, { candidacyId: id, apply: failing });
    expect(summary.outcome).toBe("failed");
    expect(summary.status).toBe("application_failed");
    expect(summary.activityId).not.toBeNull();

    expect((await getCandidacy(sql, id))?.status).toBe("application_failed");
    const act = await activityFor(summary.activityId as string);
    expect(act.status).toBe("failed");
    expect(act.error).toContain("form fields not found");

    const notes = await notificationsFor(id);
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toContain("failed");
    expect(notes[0].body).toContain("form fields not found");
  });

  it("an unexpected thrown adapter fails the Activity, sets application_failed, and rethrows", async () => {
    const id = await seed("throw");
    const boom: Applier = () => {
      throw new Error("browser crashed");
    };
    await expect(runApply(sql, { candidacyId: id, apply: boom })).rejects.toThrow(
      /browser crashed/,
    );

    expect((await getCandidacy(sql, id))?.status).toBe("application_failed");
    const [act] = await sql<{ status: string; error: string }[]>`
      select status, error from public.activities
      where candidacy_id = ${id} and type = 'apply' order by started_at desc limit 1`;
    expect(act.status).toBe("failed");
    expect(act.error).toContain("browser crashed");
  });

  it("uses an injected applier — the browser automation is a mockable seam", async () => {
    const id = await seed("seam");
    let sawContent = "";
    const mock: Applier = (ctx) => {
      sawContent = ctx.coverLetter.content;
      return { kind: "submitted", reference: "MOCK-REF" };
    };
    const summary = await runApply(sql, { candidacyId: id, apply: mock });
    expect(summary.status).toBe("applied");
    expect(sawContent).toContain("excited to apply");
    const act = await activityFor(summary.activityId as string);
    expect((act.detail as { reference?: string }).reference).toBe("MOCK-REF");
  });

  it("is idempotent — re-applying an applied candidacy is a no-op (no new Activity)", async () => {
    const id = await seed("idem");
    await runApply(sql, { candidacyId: id });
    const [{ n: before }] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.activities where candidacy_id = ${id} and type = 'apply'`;

    const summary = await runApply(sql, { candidacyId: id });
    expect(summary.skipped).toBe(true);
    expect(summary.status).toBe("applied");
    expect(summary.activityId).toBeNull();

    const [{ n: after }] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.activities where candidacy_id = ${id} and type = 'apply'`;
    expect(after).toBe(before);
  });

  it("refuses a non-approved candidacy and opens no Activity (approval gate)", async () => {
    const id = await seed("gate", { status: "in_review" });
    await expect(runApply(sql, { candidacyId: id })).rejects.toThrow(/gated to an approved/);

    // Fail-closed precondition: status untouched and no Activity opened.
    expect((await getCandidacy(sql, id))?.status).toBe("in_review");
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.activities where candidacy_id = ${id} and type = 'apply'`;
    expect(n).toBe(0);
  });

  it("refuses an approved candidacy with no active cover letter (no Activity)", async () => {
    const id = await seed("noletter", { withLetter: false });
    await expect(runApply(sql, { candidacyId: id })).rejects.toThrow(
      /no approved cover-letter version/,
    );
    expect((await getCandidacy(sql, id))?.status).toBe("approved");
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.activities where candidacy_id = ${id} and type = 'apply'`;
    expect(n).toBe(0);
  });

  // ARC-165 — apply-safety: the irreversible apply waits for an explicit owner
  // confirmation. With the default `always` gate, an approved-but-unconfirmed
  // candidacy must not apply; confirming is what fires it.
  it("refuses an approved but unconfirmed candidacy and opens no Activity (apply-confirm gate)", async () => {
    const id = await seed("unconfirmed", { confirmed: false });
    await expect(runApply(sql, { candidacyId: id })).rejects.toThrow(/requires owner confirmation/);

    // Fail-closed precondition: status untouched and no Activity opened — apply never
    // fired on an unconfirmed candidacy.
    expect((await getCandidacy(sql, id))?.status).toBe("approved");
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.activities where candidacy_id = ${id} and type = 'apply'`;
    expect(n).toBe(0);
  });

  it("applies once the owner confirms — confirming fires the apply", async () => {
    const id = await seed("confirm-fires", { confirmed: false });
    // Unconfirmed: refused.
    await expect(runApply(sql, { candidacyId: id })).rejects.toThrow(/requires owner confirmation/);
    // The owner confirms, then apply proceeds to a real submission.
    await confirmApply(sql, id);
    const summary = await runApply(sql, { candidacyId: id });
    expect(summary.outcome).toBe("submitted");
    expect(summary.status).toBe("applied");
    expect((await getCandidacy(sql, id))?.status).toBe("applied");
  });

  it("first-N mode lets an unconfirmed apply through once the user is past the window", async () => {
    // A fresh user with N applications already fired is past their first-N window, so
    // confirmation is no longer required — the gate honours the configured mode.
    const id = await seed("first-n", { confirmed: false });
    const summary = await runApply(sql, {
      candidacyId: id,
      // n=0 means "no applications need confirming" — the user is immediately past the
      // window (count 0 ≥ 0), so this approved-unconfirmed candidacy applies.
      confirmMode: { kind: "first-n", n: 0 },
    });
    expect(summary.status).toBe("applied");
  });

  it("throws for an unknown candidacy", async () => {
    await expect(
      runApply(sql, { candidacyId: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toThrow(/unknown candidacy/);
  });
});
