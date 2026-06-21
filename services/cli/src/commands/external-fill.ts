import { readFileSync } from "node:fs";
import {
  type Db,
  type Enums,
  failActivity,
  getCandidacyContext,
  getOpenExternalApplicationForm,
  setCandidacyStatus,
  setExternalApplicationFormStatus,
  startActivity,
  succeedActivity,
} from "@archer/db";
import type { Command } from "commander";
import { type ArcherMcp, createArcherMcp } from "../archer-mcp.js";
import { CliError, type GlobalOpts, output, run } from "../context.js";

/** The role/company the fill targets, the external form's URL, and the Archer MCP
 *  surface the agent reads the candidate from + writes the form's status to. */
export interface ExternalFillContext {
  candidacy: { id: string; role: string; company: string | null; boardSlug: string };
  form: { id: string; url: string };
  /** Least-privilege tool surface (scoped to this candidacy/user/form). */
  mcp: ArcherMcp;
  log: (msg: string) => void;
}

/**
 * What the (stubbed) external-fill agent reports back after working the off-board
 * form. The browser automation lands in exactly one of two places:
 *  - `completed` — the external form was filled and submitted.
 *  - `failed`    — the form could not be completed (a structured, expected failure,
 *                  distinct from an unexpected thrown error).
 */
export type ExternalFillOutcome =
  | { kind: "completed"; reference?: string; detail?: Record<string, unknown> }
  | { kind: "failed"; reason: string; detail?: Record<string, unknown> };

/**
 * The external-fill agent: read the candidate via the Archer MCP surface and drive
 * the external site's form (browser automation), then report the outcome. The real
 * implementation drops the Chrome-DevTools work in here; the default `stubFiller`
 * is a deterministic, network-free stand-in that still EXERCISES the read surface,
 * so the whole loop runs (and is tested) with no live browser. Mockable seam: pass
 * your own `Filler` to `runExternalFill`.
 */
export type Filler = (
  ctx: ExternalFillContext,
) => ExternalFillOutcome | Promise<ExternalFillOutcome>;

/**
 * A deterministic, network-free stand-in for the external-fill browser agent. It
 * reads the candidate's cover letter, profile and enriched company THROUGH the
 * Archer MCP surface (proving the least-privilege read tools work), then reports
 * the on-board-equivalent success outcome with a synthetic submission reference.
 * Swap in a real browser agent via `runExternalFill`.
 */
export const stubFiller: Filler = async ({ candidacy, form, mcp }) => {
  // Exercise the read surface the way a real fill agent would.
  const letter = await mcp.read_cover_letter();
  await mcp.read_profile();
  await mcp.read_enriched_company();
  return {
    kind: "completed",
    reference: `stub-external-${candidacy.boardSlug}-${candidacy.id}`,
    detail: { provider: "stub", url: form.url, hasLetter: letter !== null },
  };
};

/** The structured detail an external-fill run records on its Activity and prints. */
export interface ExternalFillSummary {
  candidacyId: string;
  role: string;
  company: string | null;
  /** The candidacy status the run landed on. */
  status: Enums<"candidacy_status">;
  /** The fill agent's outcome kind, or null when the run was a skipped no-op. */
  outcome: ExternalFillOutcome["kind"] | null;
  /** true when there was no open external form to fill and the run was a no-op
   *  (no Activity opened) — a re-fired webhook after completion is idempotent. */
  skipped: boolean;
  /** The external-fill Activity's id, or null when the run was a skipped no-op. */
  activityId: string | null;
  /** The external_application_form worked, or null on a skipped no-op. */
  formId: string | null;
}

/**
 * Complete one redirected (off-board) application through the (stubbed) external-fill
 * agent, wrapping the work in a single `external_fill` Activity (in_progress→
 * succeeded/failed). The candidacy moves `external_pending` →:
 *  - `applied`            on a completed external form (Activity succeeded),
 *  - `application_failed` on a structured failure (Activity failed, which wakes the
 *                         self-heal Mechanic via the activity-failed webhook).
 *
 * The form row walks pending → in_progress → completed | failed in lock-step. The
 * fill agent reads the candidate and writes the form's status only through the
 * Archer MCP surface (least-privilege, scoped to this candidacy/user/form).
 *
 * Idempotent: a candidacy with no OPEN external form is a no-op (no Activity) — a
 * re-fired external-form webhook after the form already completed never re-submits.
 * Gated to `external_pending`: any other status with an open form is refused
 * fail-closed before any status change or Activity. The browser automation is a
 * mockable seam — pass your own `fill` to swap the stub for a real agent.
 */
export async function runExternalFill(
  db: Db,
  args: { candidacyId: string; userId?: string | null; fill?: Filler },
): Promise<ExternalFillSummary> {
  const fill = args.fill ?? stubFiller;
  const candidacy = await getCandidacyContext(db, args.candidacyId);
  if (!candidacy) throw new CliError(`unknown candidacy: ${args.candidacyId}`);

  const base = {
    candidacyId: candidacy.id,
    role: candidacy.posting_title,
    company: candidacy.company_name,
  };

  // Idempotent: nothing open to fill (e.g. a re-fired webhook after completion) is
  // a no-op — no Activity, no status change. The external fill never re-submits.
  const form = await getOpenExternalApplicationForm(db, candidacy.id);
  if (!form) {
    return {
      ...base,
      status: candidacy.status,
      outcome: null,
      skipped: true,
      activityId: null,
      formId: null,
    };
  }

  // Gate: an open form should only ever exist on an external_pending candidacy.
  // Anything else is an inconsistency — refuse before touching status or opening
  // an Activity (fail-closed, like the apply approval gate).
  if (candidacy.status !== "external_pending") {
    throw new CliError(
      `external fill is gated to external_pending: ${candidacy.posting_title} is ${candidacy.status}`,
    );
  }

  await setExternalApplicationFormStatus(db, form.id, "in_progress");
  const activity = await startActivity(db, {
    type: "external_fill",
    userId: args.userId ?? candidacy.user_id,
    candidacyId: candidacy.id,
    detail: { role: candidacy.posting_title, company: candidacy.company_name, url: form.url },
  });
  const mcp = createArcherMcp({
    db,
    candidacyId: candidacy.id,
    userId: candidacy.user_id,
    formId: form.id,
  });
  try {
    const outcome = await fill({
      candidacy: {
        id: candidacy.id,
        role: candidacy.posting_title,
        company: candidacy.company_name,
        boardSlug: candidacy.board_slug,
      },
      form: { id: form.id, url: form.url },
      mcp,
      log: (m) => console.error(m),
    });

    if (outcome.kind === "failed") {
      // A structured, expected failure: the form and candidacy land on failed and
      // the Activity is marked failed (which wakes the Mechanic). Not thrown — the
      // orchestration completed; the external application is what didn't.
      await mcp.update_external_status({
        status: "failed",
        error: outcome.reason,
        detail: outcome.detail,
      });
      await setCandidacyStatus(db, candidacy.id, "application_failed", { reason: outcome.reason });
      await failActivity(db, activity.id, outcome.reason, { ...outcome.detail, url: form.url });
      return {
        ...base,
        status: "application_failed",
        outcome: "failed",
        skipped: false,
        activityId: activity.id,
        formId: form.id,
      };
    }

    // Completed: the external form was submitted. Write the form completed THROUGH
    // the MCP surface (the write tool the agent owns), then land the candidacy.
    await mcp.update_external_status({
      status: "completed",
      detail: { reference: outcome.reference ?? null, ...outcome.detail },
    });
    await setCandidacyStatus(db, candidacy.id, "applied");
    await succeedActivity(db, activity.id, {
      outcome: "completed",
      url: form.url,
      reference: outcome.reference ?? null,
      ...outcome.detail,
    });
    return {
      ...base,
      status: "applied",
      outcome: "completed",
      skipped: false,
      activityId: activity.id,
      formId: form.id,
    };
  } catch (err) {
    // An unexpected crash (not a structured failure outcome): fail the form + the
    // Activity and land the candidacy on application_failed, then rethrow so the
    // CLI exits non-zero. Write the form directly — the MCP call may be what threw.
    const msg = err instanceof Error ? err.message : String(err);
    await setExternalApplicationFormStatus(db, form.id, "failed", { error: msg });
    await setCandidacyStatus(db, candidacy.id, "application_failed", { reason: msg });
    await failActivity(db, activity.id, msg, { url: form.url });
    throw err;
  }
}

interface ExternalFillOpts {
  fixture?: string;
}

export function registerExternalFill(program: Command): void {
  program
    .command("external-fill")
    .description(
      "Complete a redirected (off-board) application via the (stubbed) external-fill agent + Archer MCP",
    )
    .argument("<candidacy>", "candidacy id (uuid)")
    .option(
      "--fixture <path>",
      "read an ExternalFillOutcome from a JSON file instead of the agent (dev/testing)",
    )
    .action(async (candidacyId: string, opts: ExternalFillOpts, cmd) => {
      await run(cmd.optsWithGlobals() as GlobalOpts, async (ctx) => {
        let fill: Filler | undefined;
        if (opts.fixture) {
          const path = opts.fixture;
          fill = () => JSON.parse(readFileSync(path, "utf8")) as ExternalFillOutcome;
        }
        const summary = await runExternalFill(ctx.db, {
          candidacyId,
          userId: ctx.userId,
          fill,
        });
        output(ctx, summary, (s) =>
          console.log(
            s.skipped
              ? `external-fill: ${s.role} has no open external form (no-op)`
              : `external-fill: ${s.role} → ${s.status} (${s.outcome})`,
          ),
        );
      });
    });
}
