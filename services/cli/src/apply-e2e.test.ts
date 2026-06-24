import {
  confirmApply,
  createCoverLetterVersion,
  createDb,
  type Db,
  getCandidacy,
  getOpenExternalApplicationForm,
  IllegalCandidacyTransitionError,
  insertCandidacy,
  setActiveCoverLetterVersion,
  setCandidacyStatus,
  transitionCandidacy,
  upsertCompany,
  upsertPosting,
} from "@archer/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Applier, runApply } from "./commands/apply.js";
import { runExternalFill } from "./commands/external-fill.js";

// ARC-42 — the apply-phase status machine, end to end. The per-orchestration tests
// (apply.test.ts, external-fill.test.ts) prove each branch in isolation; this proves
// the two orchestrations COMPOSE into the one documented machine and that it is
// ENFORCED: an approved candidacy walks all the way to `applied` on both the on-board
// and the external-redirect paths, every transition lands its activity + notification,
// the failure path lands application_failed, and an illegal jump is rejected.
//
// DB-backed: point TEST_DATABASE_URL at a migrated Postgres to exercise it (skipped
// otherwise, keeping CI green — the pure machine is proven in
// packages/db/src/candidacy-status.test.ts, which runs in every CI pass).

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const USER = "dddddddd-0000-4000-8000-000000000042";
const URL_PREFIX = "https://cj.test/arc42/";
const COMPANY_PREFIX = "Apply Co Arc42";

describe.skipIf(!TEST_DB_URL)("ARC-42 — apply-phase status machine, end to end", () => {
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

  /** A candidacy + posting/company. `approved` is true by default with an active
   *  approved cover-letter version (the apply precondition); pass approved:false to
   *  leave it at the default `new` (for the machine-enforcement case). */
  const seed = async (key: string, opts: { approved?: boolean } = {}): Promise<string> => {
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
    if (opts.approved !== false) {
      const v = await createCoverLetterVersion(sql, {
        candidacyId,
        userId: USER,
        label: "draft",
        content: "Dear hiring team, I am excited to apply.",
      });
      await setActiveCoverLetterVersion(sql, candidacyId, v.id);
      await setCandidacyStatus(sql, candidacyId, "approved");
      // Apply-confirm gate (ARC-165): confirm so the apply-phase machine runs end to end.
      await confirmApply(sql, candidacyId);
    }
    return candidacyId;
  };

  const applicationNotes = async (candidacyId: string) =>
    await sql<{ title: string }[]>`
      select title from public.notifications
      where user_id = ${USER} and kind = 'application' and ref->>'candidacyId' = ${candidacyId}
      order by created_at`;

  beforeAll(async () => {
    sql = createDb({ DATABASE_URL: TEST_DB_URL });
    await purge(sql);
    await sql`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${USER}, 'arc42@example.com', ${sql.json({ full_name: "Arc42" })})
      on conflict (id) do nothing`;
  });

  afterAll(async () => {
    if (!sql) return;
    await purge(sql);
    await sql.end();
  });

  it("on-board happy path: approved → applying → applied", async () => {
    const id = await seed("onboard");
    const summary = await runApply(sql, { candidacyId: id });
    expect(summary.status).toBe("applied");
    expect((await getCandidacy(sql, id))?.status).toBe("applied");
    expect((await applicationNotes(id)).map((n) => n.title)).toEqual([
      "Applied to Apply Role onboard",
    ]);
  });

  it("external-redirect happy path: apply redirect → external_pending → external-fill → applied", async () => {
    const id = await seed("redirect");
    const redirect: Applier = () => ({ kind: "redirect", url: "https://apply.example/form/arc42" });

    const applied = await runApply(sql, { candidacyId: id, apply: redirect });
    expect(applied.status).toBe("external_pending");
    expect((await getCandidacy(sql, id))?.status).toBe("external_pending");
    const form = await getOpenExternalApplicationForm(sql, id);
    expect(form?.status).toBe("pending");

    // The redirect webhooks the external-fill path — compose it here and walk to applied.
    const filled = await runExternalFill(sql, { candidacyId: id });
    expect(filled.status).toBe("applied");
    expect((await getCandidacy(sql, id))?.status).toBe("applied");
    expect(await getOpenExternalApplicationForm(sql, id)).toBeUndefined();

    // One notification per transition: the redirect hand-off, then the completed fill.
    expect((await applicationNotes(id)).map((n) => n.title)).toEqual([
      "An external application needs completing",
      "Applied to Apply Role redirect",
    ]);
  });

  it("failure path: apply fails → application_failed", async () => {
    const id = await seed("fail");
    const failing: Applier = () => ({ kind: "failed", reason: "board form unreachable" });
    const summary = await runApply(sql, { candidacyId: id, apply: failing });
    expect(summary.status).toBe("application_failed");
    expect((await getCandidacy(sql, id))?.status).toBe("application_failed");
    const titles = (await applicationNotes(id)).map((n) => n.title);
    expect(titles).toEqual(["Application to Apply Role fail failed"]);
  });

  it("enforces the machine: an illegal jump is rejected, a legal move is applied", async () => {
    const id = await seed("machine", { approved: false }); // stays `new`
    await expect(transitionCandidacy(sql, id, "applied")).rejects.toBeInstanceOf(
      IllegalCandidacyTransitionError,
    );
    // The rejected move left the candidacy untouched.
    expect((await getCandidacy(sql, id))?.status).toBe("new");
    // A legal move from `new` goes through.
    const moved = await transitionCandidacy(sql, id, "shortlisted");
    expect(moved?.status).toBe("shortlisted");
  });

  it("returns undefined transitioning an unknown candidacy", async () => {
    expect(
      await transitionCandidacy(sql, "00000000-0000-4000-8000-000000000000", "applying"),
    ).toBeUndefined();
  });
});
