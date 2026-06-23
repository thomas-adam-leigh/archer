/**
 * The profile-review decision signals — pure logic (ARC-108).
 *
 * The review screen lets the candidate either approve the proposed draft or send
 * feedback that re-runs it. Approving advances onboarding (the route guard moves
 * them to negative criteria once `/onboarding/progress` reports the draft
 * approved). Feedback kicks off a streamed revise run that lands a NEW proposed
 * version on the same review step — so, unlike the résumé ingest, the `step`
 * never changes. The only reliable "the revision is ready" signal the web client
 * (which has no Realtime run stream) can poll is the proposed version id flipping
 * to a different one. {@link isRevisionReady} encodes exactly that, kept free of
 * React so it's unit-tested offline.
 */

import type { OnboardingProgress } from "#/lib/onboarding.ts";

/**
 * Whether a revise run has produced a fresh proposed version, given the version
 * id that was on screen when the feedback was sent. True once progress reports a
 * proposed version that differs from `fromVersionId` (a non-null id we haven't
 * seen yet). While the revise run is still working the backend either holds the
 * old proposed version or briefly clears it, so neither a matching nor a null id
 * ends the wait.
 */
export function isRevisionReady(
	progress: OnboardingProgress,
	fromVersionId: string | null,
): boolean {
	const next = progress.proposedVersionId;
	return next !== null && next !== fromVersionId;
}
