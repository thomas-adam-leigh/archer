/**
 * The profile-revise "Archer is reworking your draft" stage — pure logic (ARC-129).
 *
 * The review screen's feedback loop sends "Send to Archer" → `POST /onboarding/revise`,
 * which runs `reviseDraft` and emits a `reviseDraftRun` AG-UI run (services/api/src/agui.ts):
 * the run flips its shared `state.phase` through `reading → revising → complete`, the
 * last delta carrying the NEW proposed `versionId`/`proposalId`. This module mirrors
 * {@link file://./resume-processing.ts resume-processing.ts}: it owns the revise stage's
 * display copy and the projection of a folded {@link ThreadView} into the handful of
 * fields the overlay + route act on — kept free of React so it's unit-tested offline.
 *
 * The one wrinkle over ingest: the review thread already carries the PRIOR run's
 * terminal state (`phase: "complete"` with the *current* proposed version's id). A
 * revise is "ready" only once a run lands a version that DIFFERS from the one on
 * screen when the feedback was sent — exactly the {@link file://./profile-review-flow.ts
 * isRevisionReady} signal the poll fallback uses. So completion is keyed on a *fresh*
 * versionId, and until the new run resets shared state (its opening `state_snapshot`
 * clears the old ids) the stale `complete` is displayed as the first "received" phase
 * rather than a misleading 100%.
 */

import type { ThreadView } from "@archer/agui-client";
import {
	type ProcessingPhase,
	type ProcessingView,
	processingView,
} from "#/lib/resume-processing.ts";

/**
 * The ordered revise phases with their display copy. The `key`s mirror the backend
 * `REVISE_PHASES` (`services/api/src/agui.ts`) — the run flips `state.phase` through
 * `reading → revising` and then `complete` — so the overlay renders against the live
 * phase, never a fabricated timer.
 */
export const REVISE_PHASES: readonly ProcessingPhase[] = [
	{
		key: "reading",
		title: "Reading your notes…",
		log: "Took your notes on board",
		pct: 45,
	},
	{
		key: "revising",
		title: "Reworking your profile…",
		log: "Reworked your profile",
		pct: 85,
	},
];

/** The terminal phase the revise run flips to once the fresh draft has landed. */
export const COMPLETE_PHASE = "complete";

/** The reassurance copy under the revise heading. */
export const REVISE_SUBTEXT = "Working your feedback into the draft.";

/** The visible revise state for a live `state.phase` (delegates to the shared mapper). */
export function reviseProcessingView(
	phase: string | undefined,
): ProcessingView {
	return processingView(phase, REVISE_PHASES);
}

/** The revise run's state, projected to the fields the overlay + route act on. */
export interface ReviseStatus {
	/** The phase to DISPLAY: the live `state.phase`, but a stale (not-fresh)
	 *  `complete` shows as the first phase so the bar never flashes 100% early. */
	phase: string;
	/** The run failed terminally (`run_error`, or `state.phase === 'error'`). */
	failed: boolean;
	/** A FRESH proposed version has landed (a `complete`/finished run whose
	 *  versionId differs from the one on screen when the feedback was sent). */
	complete: boolean;
	/** The fresh proposed profile version id, once the revise completes. */
	versionId: string | null;
	/** The open proposal id for that version, once the revise completes. */
	proposalId: string | null;
}

/**
 * Project a folded {@link ThreadView} into the revise fields the UI acts on, given
 * the proposed version id that was on screen when the feedback was sent
 * (`fromVersion`). A version is "fresh" once it is non-null and differs from
 * `fromVersion`; only a fresh, finished run reads as {@link ReviseStatus.complete}.
 * A terminal `error` (run-level or in `state.phase`) surfaces the failure. While the
 * stale prior-run `complete` is still folded (no fresh version yet) the display phase
 * pins to the first "received" phase. A null view (before history seeds) reads as the
 * first phase, still running.
 */
export function readReviseView(
	view: ThreadView | null,
	fromVersion: string | null,
): ReviseStatus {
	const state = (view?.state ?? {}) as Record<string, unknown>;
	const phase =
		typeof state.phase === "string" ? state.phase : REVISE_PHASES[0].key;
	const lifecycle = view?.phase ?? null;
	const versionId =
		typeof state.versionId === "string" ? state.versionId : null;
	const proposalId =
		typeof state.proposalId === "string" ? state.proposalId : null;
	const fresh = versionId !== null && versionId !== fromVersion;
	const failed = lifecycle === "error" || phase === "error";
	const complete =
		fresh && (phase === COMPLETE_PHASE || lifecycle === "completed");
	// A not-fresh `complete` is the prior run's terminal state, still folded until the
	// new run's snapshot resets it — show "received", not a premature 100%.
	const display =
		phase === COMPLETE_PHASE && !fresh ? REVISE_PHASES[0].key : phase;
	return { phase: display, failed, complete, versionId, proposalId };
}
