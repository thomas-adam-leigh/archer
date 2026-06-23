/**
 * Job preferences: Archer's suggested target titles + the candidate's rule-outs
 * (ported from `apps/mobile/src/lib/preferences.ts`).
 *
 * After the profile is approved, Archer suggests ~5 target job titles from the
 * live profile (`POST /onboarding/titles/suggest`). The candidate approves the
 * set, or gives feedback to re-rank/refine — a pure re-suggest the screen loops
 * until approval, then persists the chosen 1–5 to `target_titles`
 * (`POST /onboarding/titles/approve`). They also capture at least one **negative
 * criterion** (`POST /criteria`) so the account can pass the Acceptance-Gate
 * readiness check.
 *
 * The user is scoped via the `userId` body field (the documented client
 * contract) on top of the bearer token.
 */

import { apiDelete, apiGet, apiPost } from "#/lib/api.ts";
import type { Session } from "#/lib/auth.ts";

/** The POST surface these calls need — injectable so they can be tested offline. */
export type PreferencesPost = <T>(
	path: string,
	accessToken: string,
	body?: unknown,
) => Promise<T>;

/** The GET surface the reads need — injectable so they can be tested offline. */
export type PreferencesGet = <T>(
	path: string,
	accessToken: string,
) => Promise<T>;

/** The DELETE surface the removals need — injectable so they can be tested offline. */
export type PreferencesDelete = <T>(
	path: string,
	accessToken: string,
) => Promise<T>;

interface SuggestResponse {
	user: string;
	suggestions: string[];
	model?: string;
}

/** Feedback to refine a suggestion: free-text plus the list it should re-rank. */
export interface SuggestTitlesInput {
	/** The candidate's instruction, e.g. "re-rank: TypeScript Developer first". */
	feedback?: string;
	/** The current list the model should refine (sent so it re-ranks in context). */
	current?: string[];
}

/**
 * Suggest (or re-suggest) ~5 ranked target titles. With no input it returns the
 * first suggestion from the approved profile; pass `feedback`/`current` to
 * re-rank or refine. Returns the ordered title strings.
 */
export async function suggestTitles(
	session: Session,
	input: SuggestTitlesInput = {},
	post: PreferencesPost = apiPost,
): Promise<string[]> {
	const resp = await post<SuggestResponse>(
		"/onboarding/titles/suggest",
		session.accessToken,
		{
			userId: session.user.id,
			feedback: input.feedback,
			current: input.current,
		},
	);
	return resp.suggestions ?? [];
}

/** Persist the chosen/ordered 1–5 titles to `target_titles` — the end of the loop. */
export async function approveTitles(
	session: Session,
	titles: string[],
	post: PreferencesPost = apiPost,
): Promise<void> {
	await post("/onboarding/titles/approve", session.accessToken, {
		userId: session.user.id,
		titles,
	});
}

/** A saved deal-breaker (mirrors the row `POST /criteria` returns). */
export interface NegativeCriterion {
	id: string;
	text: string;
}

interface CriterionResponse {
	user: string;
	criterion: NegativeCriterion;
}

interface CriteriaListResponse {
	user: string;
	criteria: NegativeCriterion[];
}

/** List the candidate's saved negative criteria (their rule-outs). */
export async function listNegativeCriteria(
	session: Session,
	get: PreferencesGet = apiGet,
): Promise<NegativeCriterion[]> {
	const resp = await get<CriteriaListResponse>(
		`/criteria?user=${encodeURIComponent(session.user.id)}`,
		session.accessToken,
	);
	return resp.criteria ?? [];
}

/** Capture one negative criterion (a rule-out) into `negative_criteria`. */
export async function addNegativeCriterion(
	session: Session,
	text: string,
	post: PreferencesPost = apiPost,
): Promise<NegativeCriterion> {
	const resp = await post<CriterionResponse>("/criteria", session.accessToken, {
		userId: session.user.id,
		text,
	});
	return resp.criterion;
}

/** Remove a saved negative criterion by its id. */
export async function removeNegativeCriterion(
	session: Session,
	id: string,
	del: PreferencesDelete = apiDelete,
): Promise<void> {
	await del(`/criteria/${encodeURIComponent(id)}`, session.accessToken);
}
