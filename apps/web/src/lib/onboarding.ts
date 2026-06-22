/**
 * The resumable onboarding step (ported from `apps/mobile/src/lib/onboarding.ts`).
 *
 * Reads `GET /onboarding/progress` and surfaces the precise step the user is on
 * so the router can restore exactly where they left off. The endpoint scopes to
 * the user via the `user` query param (the documented client contract) on top of
 * the authenticated request.
 */

import { apiGet } from "#/lib/api.ts";
import type { Session } from "#/lib/auth.ts";

/** The onboarding step machine (mirrors the backend `OnboardingStep`). */
export type OnboardingStep =
	| "intro"
	| "processing"
	| "review"
	| "titles"
	| "submitting"
	| "done";

/** The folded onboarding progress for a user. */
export interface OnboardingProgress {
	hasProfileData: boolean;
	draftGenerated: boolean;
	draftApproved: boolean;
	titlesGenerated: boolean;
	titlesApproved: boolean;
	negativeCriteriaCaptured: boolean;
	completed: boolean;
	step: OnboardingStep;
	/** The open profile-version proposal the review screen self-approves with,
	 *  or null when none is awaiting the candidate's decision. */
	openProposalId: string | null;
	/** The proposed version that open proposal targets, or null when none open. */
	proposedVersionId: string | null;
}

/** The `/onboarding/progress` response also echoes the resolved `user`. */
type ProgressResponse = OnboardingProgress & { user: string };

/** The GET surface the fetch needs — injectable so it can be tested offline. */
export type ProgressFetch = (
	path: string,
	accessToken: string,
) => Promise<ProgressResponse>;

/** Fetch the user's resumable onboarding progress. */
export function fetchOnboardingProgress(
	session: Session,
	get: ProgressFetch = apiGet,
): Promise<OnboardingProgress> {
	return get(
		`/onboarding/progress?user=${encodeURIComponent(session.user.id)}`,
		session.accessToken,
	);
}
