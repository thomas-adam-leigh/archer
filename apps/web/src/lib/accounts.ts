/**
 * Acceptance-Gate onboarding completion (ported from `apps/mobile/src/lib/accounts.ts`).
 *
 * Once the candidate has approved their profile and target titles and captured a
 * rule-out, `POST /onboarding/complete` submits the account for the owner's
 * Acceptance Gate (readiness-checked server-side: an approved profile version,
 * 1–5 active target titles, and ≥1 negative criterion) — moving it out of
 * `onboarding` so the user lands on home. Web onboarding only needs the submit;
 * the post seam is injectable so it can be tested offline. The user is scoped via
 * the documented `userId` body contract on top of the bearer token.
 */

import { apiPost } from "#/lib/api.ts";
import type { Session } from "#/lib/auth.ts";

/** The Acceptance-Gate account status (mirrors the backend `account_status`). */
export type AccountStatus =
	| "onboarding"
	| "submitted"
	| "under_review"
	| "accepted"
	| "rejected";

/** The POST surface completion needs — injectable so it can be tested offline. */
export type AccountPost = <T>(
	path: string,
	accessToken: string,
	body?: unknown,
) => Promise<T>;

interface AccountStatusResponse {
	user: string;
	status: AccountStatus;
}

/**
 * Finalize onboarding: submit the account for the Acceptance Gate, returning the
 * resulting status (`submitted`). Throws (409 via the API client) when the
 * server's readiness check is unmet — the hunt-setup submit only fires once
 * titles are approved and a rule-out captured, so readiness is satisfied.
 */
export async function completeOnboarding(
	session: Session,
	post: AccountPost = apiPost,
): Promise<AccountStatus> {
	const resp = await post<AccountStatusResponse>(
		"/onboarding/complete",
		session.accessToken,
		{ userId: session.user.id },
	);
	return resp.status;
}
