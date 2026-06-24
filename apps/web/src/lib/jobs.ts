/**
 * The jobs route's live data: the curated feed of candidacies worth the
 * candidate's attention, and the detail behind one of them (ARC-149).
 *
 * Two reads back the route:
 *   - `GET /jobs?status=` — a user's candidacies for one status, joined to their
 *     posting + company. The feed is deliberately *curated*: it shows only the two
 *     statuses Archer has decided are worth a look — `shortlisted` and
 *     `alternative_outreach` — and never `new`/`dismissed`. The endpoint filters by
 *     a single status, so the feed is the union of the two curated reads.
 *   - `GET /candidacies/{id}` — one candidacy's full detail: posting, why-matched
 *     (triage decision/reason/score), a company summary, and any external-form state.
 *
 * Reads are JWT-scoped own-rows-only; we pass `?user=` as the documented client
 * contract (preferences.ts/dashboard.ts) on top of the bearer token. The fetch
 * seam is injectable so the pure shaping helpers stay testable offline.
 */

import { apiGet } from "#/lib/api.ts";
import type { Session } from "#/lib/auth.ts";

/** The GET surface these reads need — injectable so they can be tested offline. */
export type JobsGet = <T>(path: string, accessToken: string) => Promise<T>;

// ── candidacy status ─────────────────────────────────────────────────────────
/** The candidacy lifecycle statuses (mirrors db enum `candidacy_status`). */
export type CandidacyStatus =
	| "new"
	| "dismissed"
	| "shortlisted"
	| "alternative_outreach"
	| "awaiting_cover_letter"
	| "drafting"
	| "in_review"
	| "approved"
	| "applying"
	| "applied"
	| "external_pending"
	| "application_failed";

/** A board's collect/apply triage decision for a candidacy. */
export type TriageDecision =
	| "shortlisted"
	| "alternative_outreach"
	| "dismissed";

/**
 * The curated statuses the jobs feed surfaces — the roles Archer has decided are
 * worth the candidate's attention. Everything else (`new`, `dismissed`, and the
 * later apply-pipeline states) is deliberately kept off this list.
 */
export const CURATED_JOB_STATUSES = [
	"shortlisted",
	"alternative_outreach",
] as const satisfies readonly CandidacyStatus[];

// ── jobs feed ────────────────────────────────────────────────────────────────
/** A candidacy projected for the feed (mirrors db `CandidacyListItem`). */
export interface JobListItem {
	id: string;
	status: CandidacyStatus;
	triage_decision: TriageDecision | null;
	match_score: number | null;
	posting_title: string;
	board_slug: string;
	company_name: string | null;
	created_at: string;
}

/**
 * Read the curated jobs feed: the union of the `shortlisted` and
 * `alternative_outreach` candidacies, newest first. The endpoint filters by a
 * single status, so we fetch each curated status and merge — keeping the
 * never-surface-`new`/`dismissed` guarantee at the source rather than relying on
 * the client to filter a broader read.
 */
export async function listJobs(
	session: Session,
	get: JobsGet = apiGet,
): Promise<JobListItem[]> {
	const user = encodeURIComponent(session.user.id);
	const reads = await Promise.all(
		CURATED_JOB_STATUSES.map((status) =>
			get<{ user: string; jobs: JobListItem[] }>(
				`/jobs?user=${user}&status=${status}`,
				session.accessToken,
			),
		),
	);
	return reads
		.flatMap((r) => r.jobs)
		.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// ── job detail ───────────────────────────────────────────────────────────────
/** The work arrangement a posting offers (mirrors db enum `work_mode`). */
export type WorkMode = "remote" | "hybrid" | "office" | "unknown";

/** A company's enrichment status (mirrors db enum `company_status`). */
export type CompanyStatus =
	| "new"
	| "researching"
	| "enriched"
	| "enrichment_failed";

/** An external application form's status (mirrors db enum `external_form_status`). */
export type ExternalFormStatus =
	| "pending"
	| "in_progress"
	| "completed"
	| "failed";

/** Full detail for one candidacy (mirrors db `CandidacyDetail`). */
export interface JobDetail {
	id: string;
	user_id: string;
	status: CandidacyStatus;
	triage_decision: TriageDecision | null;
	triage_reason: string | null;
	match_score: number | null;
	created_at: string;
	status_changed_at: string;
	posting: {
		title: string;
		board_slug: string;
		url: string;
		location: string | null;
		work_mode: WorkMode;
		salary_raw: string | null;
		posted_on: string | null;
		description: string | null;
	};
	company: {
		id: string;
		name: string;
		status: CompanyStatus;
		description: string | null;
		website_url: string | null;
		recruitment_email: string | null;
	} | null;
	external_form: {
		status: ExternalFormStatus;
		url: string;
	} | null;
}

/** Read one candidacy's full job-detail. */
export async function fetchJobDetail(
	session: Session,
	id: string,
	get: JobsGet = apiGet,
): Promise<JobDetail> {
	const resp = await get<{ candidacy: JobDetail }>(
		`/candidacies/${encodeURIComponent(id)}`,
		session.accessToken,
	);
	return resp.candidacy;
}

// ── presentation helpers (pure) ──────────────────────────────────────────────
/** How a curated job reads as a coloured pill on the feed + detail. */
export interface JobStatusBadge {
	label: string;
	/** A coarse tone the UI maps to colour. */
	tone: "shortlisted" | "outreach" | "neutral";
}

/**
 * The badge for a candidacy's status. The feed only carries the two curated
 * states, but detail can show a candidacy further along the apply pipeline, so
 * later states get a calm, humanised neutral label rather than a raw enum value.
 */
export function jobStatusBadge(status: CandidacyStatus): JobStatusBadge {
	switch (status) {
		case "shortlisted":
			return { label: "Shortlisted", tone: "shortlisted" };
		case "alternative_outreach":
			return { label: "Alternative outreach", tone: "outreach" };
		case "awaiting_cover_letter":
		case "drafting":
			return { label: "Cover letter", tone: "neutral" };
		case "in_review":
			return { label: "In review", tone: "neutral" };
		case "approved":
			return { label: "Approved", tone: "neutral" };
		case "applying":
		case "external_pending":
			return { label: "Applying", tone: "neutral" };
		case "applied":
			return { label: "Applied", tone: "neutral" };
		case "application_failed":
			return { label: "Application failed", tone: "neutral" };
		default:
			return { label: "In progress", tone: "neutral" };
	}
}

/** The match score as a short pill label (e.g. `87% match`), or `null` if unscored. */
export function matchScoreLabel(score: number | null): string | null {
	if (score === null) return null;
	return `${Math.round(score)}% match`;
}

/** A posting's work arrangement, humanised — or `null` when unknown. */
export function workModeLabel(mode: WorkMode): string | null {
	switch (mode) {
		case "remote":
			return "Remote";
		case "hybrid":
			return "Hybrid";
		case "office":
			return "In office";
		default:
			return null;
	}
}
