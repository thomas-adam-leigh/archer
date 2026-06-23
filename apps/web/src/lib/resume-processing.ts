/**
 * The résumé "reading every line" processing stage — pure logic (ARC-102).
 *
 * Two concerns live here, kept free of React so they're unit-tested in isolation:
 *
 *  1. The *visible* build experience the spec describes — a heading that advances
 *     through phases (`buildStageText`), an accreting build log (`buildLog`), and
 *     a progress percent (`buildPct`). This cadence is presentational reassurance;
 *     it never decides that processing is finished.
 *  2. The *real* readiness signal — {@link isDraftReady}, read from
 *     `/onboarding/progress`. Unlike the mobile app (which subscribes to the
 *     AG-UI Realtime phase stream), the web client polls progress: the backend
 *     advances the onboarding `step` to `review` and exposes the open proposal
 *     once the proposed profile version lands. Only this ends the wait, so the
 *     screen never claims the draft is done on a timer.
 */

import type { OnboardingProgress } from "#/lib/onboarding.ts";

/** One ordered processing phase: its heading, the log line it leaves, its percent. */
export interface ProcessingPhase {
	key: string;
	/** The heading shown while this phase is active (the spec's `buildStageText`). */
	title: string;
	/** The build-log line revealed once this phase completes (the spec's `buildLog`). */
	log: string;
	/** Cumulative progress percent once this phase completes (the spec's `buildPct`). */
	pct: number;
}

/**
 * The ordered ingest phases with their display copy, mirroring the design spec's
 * `runBuild` staging. Reusing the spec's wording keeps the web flow recognisable
 * against the mockup; the backend ingest is the three-phase reading → extracting
 * → building run, surfaced here as finer reassurance copy.
 */
export const INGEST_PHASES: readonly ProcessingPhase[] = [
	{
		key: "reading",
		title: "Reading your résumé…",
		log: "Read your résumé",
		pct: 18,
	},
	{
		key: "experience",
		title: "Pulling out your experience…",
		log: "Found your roles and career timeline",
		pct: 46,
	},
	{
		key: "links",
		title: "Finding your links…",
		log: "Picked up your links and profiles",
		pct: 70,
	},
	{
		key: "skills",
		title: "Structuring your skills…",
		log: "Organised your skills and tools",
		pct: 88,
	},
	{
		key: "building",
		title: "Building your profile…",
		log: "Assembled your candidate profile",
		pct: 100,
	},
];

/** The reassurance copy under the heading (spec processing stage). */
export const PROCESSING_SUBTEXT =
	"Hang tight — I'm reading every line. This can take a moment.";

/** The build-card view: the active heading, the percent bar, the revealed log. */
export interface ProcessingView {
	/** The active heading (`buildStageText`). */
	title: string;
	/** Cumulative percent for the progress bar (`buildPct`). */
	pct: number;
	/** The build-log lines revealed so far, in order (`buildLog`). */
	log: string[];
}

/**
 * The visible processing state once `revealed` phases have elapsed on the client
 * cadence. `revealed` is clamped to `[0, phases.length]`:
 *  - `0` → the first phase is active, nothing logged yet, 0%.
 *  - `k` (0 < k < len) → phase `k` is active; phases `[0, k)` are logged; the bar
 *    sits at the last completed phase's percent.
 *  - `len` → every phase logged; the card holds on the final heading at 100%.
 *
 * Holding on the last phase (rather than flipping to a "done" state) is deliberate:
 * the screen waits on the real {@link isDraftReady} signal, so the cadence can run
 * out without ever claiming the draft is finished.
 */
export function processingView(
	revealed: number,
	phases: readonly ProcessingPhase[] = INGEST_PHASES,
): ProcessingView {
	const n = Math.max(0, Math.min(Math.trunc(revealed), phases.length));
	const log = phases.slice(0, n).map((p) => p.log);
	const activeIndex = Math.min(n, phases.length - 1);
	const pct = n === 0 ? 0 : phases[n - 1].pct;
	return { title: phases[activeIndex].title, pct, log };
}

/**
 * Whether the streamed ingest has produced the draft the review screen needs.
 * Read from `/onboarding/progress`: the backend advances `step` to `review` and
 * exposes the open proposal once the proposed profile version lands.
 */
export function isDraftReady(progress: OnboardingProgress): boolean {
	return (
		progress.step === "review" ||
		(progress.draftGenerated && progress.openProposalId !== null)
	);
}
