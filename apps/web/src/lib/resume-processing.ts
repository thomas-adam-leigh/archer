/**
 * The résumé "reading every line" processing stage — pure logic (ARC-102/ARC-125).
 *
 * Two concerns live here, kept free of React so they're unit-tested in isolation:
 *
 *  1. The *visible* build experience the spec describes — a heading that advances
 *     through phases, an accreting build log, and a progress percent. From ARC-125
 *     this is driven by the **real** ingest run: the backend flips the AG-UI run's
 *     shared `state.phase` through `reading → extracting → building → complete`
 *     (`services/api/src/agui.ts` `INGEST_PHASES`), the client folds that stream,
 *     and {@link processingView} maps the live phase onto the build card. No timer.
 *  2. The *real* readiness signal — {@link isDraftReady}, read from
 *     `/onboarding/progress`. The live AG-UI stream is the primary signal now, but
 *     the route keeps polling progress as a reconnect/fallback: a dropped socket
 *     still advances the flow once the proposed version lands.
 *
 * {@link readIngestView} projects a folded {@link ThreadView} into the handful of
 * fields the screen and route act on (the live phase, terminal failure, and the
 * completed draft's ids) — mirroring the mobile `ProcessingScreen`.
 */

import type { ThreadView } from "@archer/agui-client";
import type { OnboardingProgress } from "#/lib/onboarding.ts";

/** One ordered processing phase: its `state.phase` key plus its display copy. */
export interface ProcessingPhase {
	/** The live `state.phase` value this row renders against. */
	key: string;
	/** The heading shown while this phase is the active one. */
	title: string;
	/** The build-log line revealed once this phase has completed. */
	log: string;
	/** The progress-bar percent shown while this phase is active. */
	pct: number;
}

/**
 * The ordered ingest phases with their display copy. The `key`s mirror the
 * backend `INGEST_PHASES` (`services/api/src/agui.ts`) — the run flips
 * `state.phase` through `reading → extracting → building` and then `complete` —
 * so the screen renders against the live phase, never a fabricated timer.
 */
export const INGEST_PHASES: readonly ProcessingPhase[] = [
	{
		key: "reading",
		title: "Reading your résumé…",
		log: "Read your résumé",
		pct: 25,
	},
	{
		key: "extracting",
		title: "Pulling out your experience…",
		log: "Pulled out your experience and history",
		pct: 60,
	},
	{
		key: "building",
		title: "Building your profile…",
		log: "Assembled your candidate profile",
		pct: 90,
	},
];

/** The terminal phase the run flips to once the proposed draft has landed. */
export const COMPLETE_PHASE = "complete";

/** The reassurance copy under the heading (spec processing stage). */
export const PROCESSING_SUBTEXT =
	"Hang tight — I'm reading every line. This can take a moment.";

/** The build-card view: the active heading, the percent bar, the revealed log. */
export interface ProcessingView {
	/** The active heading. */
	title: string;
	/** Cumulative percent for the progress bar. */
	pct: number;
	/** The build-log lines revealed so far, in order. */
	log: string[];
}

/**
 * The visible processing state for a live `state.phase`. The phase locates the
 * active row: earlier phases are logged behind it, the bar sits at the active
 * phase's percent, and the active phase's heading shows.
 *
 *  - an unknown/absent phase falls back to the first phase (0 logged).
 *  - the active phase `k` logs phases `[0, k)` and holds the bar at its percent.
 *  - `complete` logs every phase and holds the final heading at 100%.
 *
 * Driving off the real phase (not a counter) means the card can never claim
 * progress the backend hasn't actually made.
 */
export function processingView(
	phase: string | undefined,
	phases: readonly ProcessingPhase[] = INGEST_PHASES,
): ProcessingView {
	if (phase === COMPLETE_PHASE) {
		return {
			title: phases[phases.length - 1].title,
			pct: 100,
			log: phases.map((p) => p.log),
		};
	}
	const found = phases.findIndex((p) => p.key === phase);
	const active = found < 0 ? 0 : found;
	return {
		title: phases[active].title,
		pct: phases[active].pct,
		log: phases.slice(0, active).map((p) => p.log),
	};
}

/** The ingest run's state, projected to the fields the screen + route act on. */
export interface IngestStatus {
	/** The live `state.phase` (the first phase until the run emits one). */
	phase: string;
	/** The run failed terminally (`run_error`, or `state.phase === 'error'`). */
	failed: boolean;
	/** The proposed draft has landed (phase `complete`/run finished, ids present). */
	complete: boolean;
	/** The proposed profile version id, once the run completes. */
	versionId: string | null;
	/** The open proposal id for that version, once the run completes. */
	proposalId: string | null;
}

/**
 * Project a folded {@link ThreadView} into the ingest fields the UI acts on.
 * Mirrors the mobile `ProcessingScreen`: the live `state.phase` drives the card,
 * a terminal `error` (run-level or in `state.phase`) surfaces the failure, and a
 * `complete` phase carrying `versionId`/`proposalId` marks the draft ready. A
 * null view (before history seeds) reads as the first phase, still running.
 */
export function readIngestView(view: ThreadView | null): IngestStatus {
	const state = (view?.state ?? {}) as Record<string, unknown>;
	const phase =
		typeof state.phase === "string" ? state.phase : INGEST_PHASES[0].key;
	const lifecycle = view?.phase ?? null;
	const versionId =
		typeof state.versionId === "string" ? state.versionId : null;
	const proposalId =
		typeof state.proposalId === "string" ? state.proposalId : null;
	const failed = lifecycle === "error" || phase === "error";
	const complete =
		(phase === COMPLETE_PHASE || lifecycle === "completed") &&
		versionId !== null &&
		proposalId !== null;
	return { phase, failed, complete, versionId, proposalId };
}

/**
 * Whether the streamed ingest has produced the draft the review screen needs.
 * Read from `/onboarding/progress`: the backend advances `step` to `review` and
 * exposes the open proposal once the proposed profile version lands. Kept as the
 * route's reconnect/fallback signal now that the live AG-UI stream is primary.
 */
export function isDraftReady(progress: OnboardingProgress): boolean {
	return (
		progress.step === "review" ||
		(progress.draftGenerated && progress.openProposalId !== null)
	);
}
