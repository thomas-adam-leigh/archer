/**
 * The applications route's live data (ARC-166): the candidacies in the apply
 * lifecycle — what Archer has applied for (or is about to), what it sent, and when.
 * The apply-side companion to the curated jobs feed.
 *
 * One read backs the route:
 *   - `GET /applications` — the owner's candidacies in the apply-related states
 *     (`approved` — awaiting the owner's apply-confirm while `apply_confirmed_at`
 *     is null, ARC-165 — `applying`, `applied`, `external_pending`,
 *     `application_failed`), each with the approved cover-letter version that was
 *     sent and the latest external-redirect form's state. Most recently moved first.
 *
 * Reads are JWT-scoped own-rows-only; we pass `?user=` as the documented client
 * contract (jobs.ts / cover-letters.ts) on top of the bearer token. The fetch seam
 * is injectable so the pure shaping helpers stay testable offline.
 */

import { apiGet, apiPost } from "#/lib/api.ts";
import type { Session } from "#/lib/auth.ts";
import type { CandidacyStatus, ExternalFormStatus } from "#/lib/jobs.ts";

/** The GET surface this read needs — injectable so it can be tested offline. */
export type ApplicationsGet = <T>(
	path: string,
	accessToken: string,
) => Promise<T>;

/** The POST surface the apply-confirm needs — injectable for offline tests. */
export type ApplicationsPost = <T>(
	path: string,
	accessToken: string,
	body?: unknown,
) => Promise<T>;

/**
 * The apply-lifecycle statuses the applications route surfaces. Everything before
 * the letter is approved (still choosing a role / drafting a letter) is kept off
 * this list — those live on the jobs feed and the cover-letters cockpit.
 */
export const APPLICATION_STATUSES = [
	"approved",
	"applying",
	"applied",
	"external_pending",
	"application_failed",
] as const satisfies readonly CandidacyStatus[];

/** A candidacy in the apply lifecycle (mirrors db `ApplicationListItem`). */
export interface ApplicationListItem {
	id: string;
	status: CandidacyStatus;
	posting_title: string;
	board_slug: string;
	company_name: string | null;
	created_at: string;
	/** When the candidacy last moved status — the apply lifecycle's clock. */
	status_changed_at: string;
	/** When the owner confirmed the apply (ARC-165), or null while awaiting it. */
	apply_confirmed_at: string | null;
	/** The approved cover-letter version that was sent, if one exists yet. */
	cover_letter_version_id: string | null;
	cover_letter_version_no: number | null;
	/** The latest external-redirect form's state, when the apply went off-board. */
	external_form_status: ExternalFormStatus | null;
	external_form_url: string | null;
}

/**
 * Read the applications list: the owner's candidacies in the apply lifecycle,
 * most recently moved first (the endpoint already orders + filters at the source).
 */
export async function listApplications(
	session: Session,
	get: ApplicationsGet = apiGet,
): Promise<ApplicationListItem[]> {
	const user = encodeURIComponent(session.user.id);
	const resp = await get<{ user: string; applications: ApplicationListItem[] }>(
		`/applications?user=${user}`,
		session.accessToken,
	);
	return resp.applications;
}

/** The result of confirming an apply (ARC-165): the go-ahead is stamped and the box
 *  apply-runner will submit; the candidacy stays `approved` (confirmed) until it does. */
export interface ApplyConfirmResult {
	candidacyId: string;
	status: CandidacyStatus;
	confirmed: boolean;
	queued: boolean;
}

/**
 * Confirm the owner's go-ahead to apply for a candidacy (ARC-165). Stamps the
 * confirmation only — the browser apply runs on the box host runner (not the API
 * container, ARC-168), which polls for confirmed candidacies and submits them.
 */
export async function confirmApply(
	session: Session,
	candidacyId: string,
	post: ApplicationsPost = apiPost,
): Promise<ApplyConfirmResult> {
	return await post<ApplyConfirmResult>(
		`/candidacies/${encodeURIComponent(candidacyId)}/apply-confirm`,
		session.accessToken,
	);
}

// ── presentation helpers (pure) ──────────────────────────────────────────────
/** How an application reads as a coloured pill on the list. */
export interface ApplicationBadge {
	label: string;
	/** A coarse tone the UI maps to colour. */
	tone: "confirm" | "active" | "done" | "failed";
}

/**
 * The badge for an application's state. `approved` splits on the apply-confirm
 * gate (ARC-165): until the owner confirms (`apply_confirmed_at` null) it's the one
 * call to action; once confirmed it's on its way. `applied` is done; a failure is
 * called out plainly so it's never buried.
 */
export function applicationBadge(item: ApplicationListItem): ApplicationBadge {
	switch (item.status) {
		case "approved":
			return item.apply_confirmed_at
				? { label: "Confirmed — applying", tone: "active" }
				: { label: "Awaiting your confirmation", tone: "confirm" };
		case "applying":
			return { label: "Applying", tone: "active" };
		case "external_pending":
			return { label: "Form to complete", tone: "active" };
		case "applied":
			return { label: "Applied", tone: "done" };
		case "application_failed":
			return { label: "Application failed", tone: "failed" };
		default:
			return { label: "In progress", tone: "active" };
	}
}

/** The "what was sent" note for an application, or null before a letter exists. */
export function coverLetterSentLabel(item: ApplicationListItem): string | null {
	if (item.cover_letter_version_no === null) return null;
	return `Cover letter v${item.cover_letter_version_no} sent`;
}
