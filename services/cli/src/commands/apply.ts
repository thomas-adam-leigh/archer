import {
  type ApplyConfirmMode,
  applyConfirmMode,
  createNotification,
  type Db,
  type Enums,
  failActivity,
  getActiveCoverLetterVersion,
  getCandidacyContext,
  isApplyConfirmationRequired,
  openExternalApplicationForm,
  startActivity,
  succeedActivity,
  transitionCandidacy,
} from "@archer/db";
import type { Command } from "commander";
import { CliError, type GlobalOpts, output, readJsonFixture, run } from "../context.js";

/** The role/company/board the apply targets, plus the approved letter it submits. */
export interface ApplyContext {
  candidacy: { id: string; role: string; company: string | null; boardSlug: string };
  coverLetter: { versionId: string; content: string };
  log: (msg: string) => void;
}

/**
 * What the (stubbed) apply adapter reports back. The apply step is the one
 * irreversible outside-world action, and it lands in exactly one of three places:
 *  - `submitted`  — the form was filled and submitted on the board itself.
 *  - `redirect`   — the board bounces off-site; the application must be completed
 *                   on an external form (handled in a later milestone via the URL).
 *  - `failed`     — the apply could not be completed (a structured, expected
 *                   failure — distinct from an unexpected thrown error).
 */
export type ApplyOutcome =
  | { kind: "submitted"; reference?: string; detail?: Record<string, unknown> }
  | { kind: "redirect"; url: string; detail?: Record<string, unknown> }
  | { kind: "failed"; reason: string; detail?: Record<string, unknown> };

/**
 * The apply adapter: drive the board's application form (browser automation) and
 * report the outcome. The real implementation drops the Chrome-DevTools work in
 * here; the default `stubApplier` is a deterministic, network-free stand-in so the
 * whole apply loop runs (and is tested) with no live browser. Mockable seam: pass
 * your own `Applier` to `runApply` to exercise the redirect / failure branches.
 */
export type Applier = (ctx: ApplyContext) => ApplyOutcome | Promise<ApplyOutcome>;

/**
 * A deterministic, network-free stand-in for the Archer CLI apply adapter. It
 * returns the on-board success outcome — the happy path that walks a candidacy to
 * `applied` — recording a synthetic submission reference. Swap in a real adapter
 * (or the redirect/failure stubs) via `runApply`.
 */
export const stubApplier: Applier = ({ candidacy }) => ({
  kind: "submitted",
  reference: `stub-${candidacy.boardSlug}-${candidacy.id}`,
  detail: { provider: "stub", board: candidacy.boardSlug },
});

/** The structured detail an apply run records on its Activity and prints. */
export interface ApplySummary {
  candidacyId: string;
  role: string;
  company: string | null;
  /** The candidacy status the run landed on. */
  status: Enums<"candidacy_status">;
  /** The apply adapter's outcome kind, or null when the run was a skipped no-op. */
  outcome: ApplyOutcome["kind"] | null;
  /** true when the candidacy was already applied/external_pending and the run was
   *  a no-op (no Activity opened) — apply is irreversible and never re-fires. */
  skipped: boolean;
  /** The apply Activity's id, or null when the run was a skipped no-op. */
  activityId: string | null;
}

/**
 * Apply to one candidacy through the (stubbed) Archer CLI apply adapter, wrapping
 * the work in a single `apply` Activity (in_progress→succeeded/failed). The
 * candidacy moves `approved` → applying while the run is open, then to one of:
 *  - `applied`            on an on-board submission (Activity succeeded),
 *  - `external_pending`   on an off-board redirect (Activity succeeded; the
 *                         external form is handled in a later milestone),
 *  - `application_failed` on a structured failure (Activity failed, which wakes
 *                         the self-heal Mechanic via the activity-failed webhook).
 *
 * Gated to an `approved` cover letter: a candidacy that isn't `approved` is refused
 * (fail-closed precondition, no Activity opened), and an already-`applied` /
 * `external_pending` candidacy is an idempotent no-op (apply is irreversible — it
 * never re-submits). An approved candidacy must also have an active (approved)
 * cover-letter version to submit, or the run is refused. The browser automation is
 * a mockable seam — pass your own `apply` to swap the stub for a real adapter.
 */
export async function runApply(
  db: Db,
  args: {
    candidacyId: string;
    userId?: string | null;
    apply?: Applier;
    /** Apply-confirm gate mode (ARC-165). Defaults to the ARCHER_APPLY_CONFIRM_MODE
     *  env config; injectable so tests can exercise always vs first-N deterministically. */
    confirmMode?: ApplyConfirmMode;
  },
): Promise<ApplySummary> {
  const apply = args.apply ?? stubApplier;
  const candidacy = await getCandidacyContext(db, args.candidacyId);
  if (!candidacy) throw new CliError(`unknown candidacy: ${args.candidacyId}`);

  const base = {
    candidacyId: candidacy.id,
    role: candidacy.posting_title,
    company: candidacy.company_name,
  };

  // Idempotent: a candidacy that already applied (or is pending an external form)
  // is a no-op — apply is the one irreversible action and never re-fires.
  if (candidacy.status === "applied" || candidacy.status === "external_pending") {
    return { ...base, status: candidacy.status, outcome: null, skipped: true, activityId: null };
  }

  // Approval gate: only an `approved` cover letter may be applied. Refused before
  // any status change or Activity, so apply never fires on an un-approved draft.
  if (candidacy.status !== "approved") {
    throw new CliError(
      `apply is gated to an approved cover letter: ${candidacy.posting_title} is ${candidacy.status}`,
    );
  }

  // Apply-confirm gate (ARC-165): the one irreversible action waits for an explicit
  // owner confirmation. Refused fail-closed (before any status change or Activity)
  // when confirmation is required (per ARCHER_APPLY_CONFIRM_MODE) and the owner has
  // not yet confirmed this candidacy. Once `apply_confirmed_at` is stamped — or the
  // user is past their first-N window — the apply proceeds.
  if (!candidacy.apply_confirmed_at) {
    const mode = args.confirmMode ?? applyConfirmMode();
    if (await isApplyConfirmationRequired(db, candidacy.user_id, mode)) {
      throw new CliError(
        `apply requires owner confirmation: ${candidacy.posting_title} is approved but not yet confirmed`,
      );
    }
  }

  // The approved letter the adapter submits. Fail closed if there isn't one — an
  // `approved` candidacy should always have an active version, but never apply blind.
  const version = await getActiveCoverLetterVersion(db, candidacy.id);
  if (!version) {
    throw new CliError(`no approved cover-letter version to apply for: ${candidacy.posting_title}`);
  }

  const owner = args.userId ?? candidacy.user_id;
  // Open the Activity FIRST, then move the candidacy in-flight INSIDE the try (ARC-58
  // M4): a throw from startActivity leaves the candidacy `approved` (recoverable, not
  // stranded), and a throw at the `applying` write still lands in the catch. `applying`
  // records whether the move actually happened, so the catch only reverts to
  // application_failed when it did — approved → application_failed is not a legal move.
  const activity = await startActivity(db, {
    type: "apply",
    userId: args.userId ?? candidacy.user_id,
    candidacyId: candidacy.id,
    detail: { role: candidacy.posting_title, company: candidacy.company_name },
  });
  let applying = false;
  try {
    await transitionCandidacy(db, candidacy.id, "applying");
    applying = true;
    const outcome = await apply({
      candidacy: {
        id: candidacy.id,
        role: candidacy.posting_title,
        company: candidacy.company_name,
        boardSlug: candidacy.board_slug,
      },
      coverLetter: { versionId: version.id, content: version.content },
      log: (m) => console.error(m),
    });

    if (outcome.kind === "failed") {
      // A structured, expected failure: the candidacy lands on application_failed
      // and the Activity is marked failed (which wakes the Mechanic). Not thrown —
      // the orchestration itself completed; the application is what didn't.
      await transitionCandidacy(db, candidacy.id, "application_failed", { reason: outcome.reason });
      await failActivity(db, activity.id, outcome.reason, {
        ...outcome.detail,
        board: candidacy.board_slug,
      });
      await notifyApply(db, owner, candidacy, {
        title: `Application to ${candidacy.posting_title} failed`,
        body: outcome.reason,
        activityId: activity.id,
      });
      return {
        ...base,
        status: "application_failed",
        outcome: "failed",
        skipped: false,
        activityId: activity.id,
      };
    }

    const status: Enums<"candidacy_status"> =
      outcome.kind === "submitted" ? "applied" : "external_pending";
    if (outcome.kind === "redirect") {
      // Off-board redirect: record the durable external-form row, raise an
      // owner-facing proposal carrying the URL (the agent→owner control channel),
      // and push a notification — all before the candidacy enters external_pending,
      // whose status-change trigger webhooks the external-fill path (ARC-41).
      await openExternalApplicationForm(db, {
        candidacyId: candidacy.id,
        userId: candidacy.user_id,
        url: outcome.url,
        coverLetterVersionId: version.id,
        detail: {
          board: candidacy.board_slug,
          role: candidacy.posting_title,
          company: candidacy.company_name,
        },
      });
    }
    await transitionCandidacy(db, candidacy.id, status);
    await succeedActivity(db, activity.id, {
      outcome: outcome.kind,
      board: candidacy.board_slug,
      ...(outcome.kind === "submitted"
        ? { reference: outcome.reference ?? null }
        : { redirectUrl: outcome.url }),
      ...outcome.detail,
    });
    // On-board success notifies here; the redirect path already pushed the owner its
    // notification via openExternalApplicationForm — so every apply-phase transition
    // lands exactly one notification + one activity-feed event.
    if (outcome.kind === "submitted") {
      await notifyApply(db, owner, candidacy, {
        title: `Applied to ${candidacy.posting_title}`,
        body: candidacy.company_name
          ? `Your application to ${candidacy.company_name} was submitted.`
          : "Your application was submitted.",
        activityId: activity.id,
      });
    }
    return { ...base, status, outcome: outcome.kind, skipped: false, activityId: activity.id };
  } catch (err) {
    // An unexpected crash (not a structured failure outcome): fail the Activity and,
    // if the candidacy actually reached `applying`, land it on application_failed — a
    // throw before that leaves it `approved` (already recoverable). Then rethrow so the
    // CLI exits non-zero.
    const msg = err instanceof Error ? err.message : String(err);
    if (applying) {
      await transitionCandidacy(db, candidacy.id, "application_failed", { reason: msg });
    }
    await failActivity(db, activity.id, msg, { board: candidacy.board_slug });
    await notifyApply(db, owner, candidacy, {
      title: `Application to ${candidacy.posting_title} failed`,
      body: msg,
      activityId: activity.id,
    });
    throw err;
  }
}

/** Push the owner a notification for an apply-phase transition, scoped to the
 *  candidacy (kind 'application', matching the redirect hand-off) so the live feed
 *  and the kanban can correlate it. */
async function notifyApply(
  db: Db,
  userId: string,
  candidacy: { id: string },
  n: { title: string; body: string; activityId: string },
): Promise<void> {
  await createNotification(db, {
    userId,
    kind: "application",
    title: n.title,
    body: n.body,
    ref: { candidacyId: candidacy.id, activityId: n.activityId },
  });
}

interface ApplyOpts {
  fixture?: string;
}

export function registerApply(program: Command): void {
  program
    .command("apply")
    .description(
      "Apply to a candidacy via the (stubbed) Archer CLI apply adapter — on-board, redirect, or failure",
    )
    .argument("<candidacy>", "candidacy id (uuid)")
    .option(
      "--fixture <path>",
      "read an ApplyOutcome from a JSON file instead of the adapter (dev/testing)",
    )
    .action(async (candidacyId: string, opts: ApplyOpts, cmd) => {
      await run(cmd.optsWithGlobals() as GlobalOpts, async (ctx) => {
        let apply: Applier | undefined;
        if (opts.fixture) {
          const path = opts.fixture;
          apply = () => readJsonFixture<ApplyOutcome>(path, "--fixture");
        }
        const summary = await runApply(ctx.db, {
          candidacyId,
          userId: ctx.userId,
          apply,
        });
        output(ctx, summary, (s) =>
          console.log(
            s.skipped
              ? `apply: ${s.role} already ${s.status} (no-op)`
              : `apply: ${s.role} → ${s.status} (${s.outcome})`,
          ),
        );
      });
    });
}
