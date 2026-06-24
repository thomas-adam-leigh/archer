/**
 * The cover-letters route's live data: the candidacies whose cover letter is the
 * candidate's to act on, and the review behind one of them (ARC-150) — the daily
 * heartbeat / one human gate before applying.
 *
 * Reads (JWT-scoped own rows):
 *   - `GET /jobs?status=` — the cover-letter cockpit's three relevant candidacy
 *     states: `in_review` (Archer's draft is waiting for you), `drafting` (Archer
 *     is reworking it), and `approved` (done, on its way to apply). The endpoint
 *     filters by a single status, so the list is the union of those reads.
 *   - `GET /candidacies/{id}/cover-letters` — a candidacy's version history plus the
 *     open (submitted) proposal id awaiting a decision (null when none), the
 *     cover-letter analogue of `/onboarding/progress`'s openProposalId.
 *   - `GET /cover-letters/{versionId}` — one version's full content + the spoken-note
 *     (TTS) artifact recorded on its `details`.
 *
 * Writes (the human gate, self-scoped):
 *   - `POST /cover-letters/proposals/{id}/decide/self` (action `approve`) — make the
 *     letter the candidacy's active one and advance it toward apply.
 *   - the same route with action `reject` + the feedback as `note` — return the
 *     candidacy to drafting so Archer reworks the letter (the "revise" trigger).
 *
 * The fetch/post seams are injectable so the pure shaping helpers stay testable
 * offline (matching jobs.ts / profile.ts).
 */

import { apiGet, apiPost } from "#/lib/api.ts";
import type { Session } from "#/lib/auth.ts";
import type { CandidacyStatus, JobListItem } from "#/lib/jobs.ts";

/** The GET surface these reads need — injectable so they can be tested offline. */
export type CoverLettersGet = <T>(
	path: string,
	accessToken: string,
) => Promise<T>;
/** The POST surface the decide calls need — injectable for offline tests. */
export type CoverLettersPost = <T>(
	path: string,
	accessToken: string,
	body?: unknown,
) => Promise<T>;

// ── the cockpit list ─────────────────────────────────────────────────────────
/**
 * The candidacy states the cover-letters cockpit surfaces: a draft waiting for the
 * candidate's review, one Archer is reworking, and the approved ones on their way
 * to apply. Everything earlier (`awaiting_cover_letter` has no letter yet) and the
 * apply-pipeline tail are deliberately kept off this list.
 */
export const COVER_LETTER_STATUSES = [
	"in_review",
	"drafting",
	"approved",
] as const satisfies readonly CandidacyStatus[];

/**
 * Read the cover-letters cockpit list: the union of the in-review / drafting /
 * approved candidacies, newest first. The endpoint filters by a single status, so
 * we fetch each and merge — keeping the cockpit's scope at the source.
 */
export async function listCoverLetterCandidacies(
	session: Session,
	get: CoverLettersGet = apiGet,
): Promise<JobListItem[]> {
	const user = encodeURIComponent(session.user.id);
	const reads = await Promise.all(
		COVER_LETTER_STATUSES.map((status) =>
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

// ── the review ───────────────────────────────────────────────────────────────
/** The lifecycle of a cover-letter version (mirrors db `cover_letter_version_status`). */
export type CoverLetterVersionStatus =
	| "draft"
	| "proposed"
	| "approved"
	| "rejected"
	| "superseded";

/** One cover-letter version as a history summary (mirrors db `CoverLetterVersionSummary`). */
export interface CoverLetterVersionSummary {
	id: string;
	version_no: number;
	status: CoverLetterVersionStatus;
	label: string | null;
	created_at: string;
}

/** Archer's spoken note for a version — the audio artifact a client plays aloud. */
export interface SpokenNote {
	audioUrl: string;
	provider: string;
}

/** The version under review: its content plus the spoken-note artifact, if any. */
export interface CoverLetterContent {
	id: string;
	version_no: number;
	status: CoverLetterVersionStatus;
	content: string;
	spokenNote: SpokenNote | null;
}

/** The review screen's data: the letter on screen, the history, and the open proposal. */
export interface CoverLetterReview {
	candidacyId: string;
	/** The version presented for review: the open proposal's target, else the active
	 *  (approved) version, else the newest version. Null when no letter exists yet. */
	current: CoverLetterContent | null;
	/** The candidacy's versions, newest first (the history rail). */
	versions: CoverLetterVersionSummary[];
	/** The open (submitted) proposal id to decide, or null when none is awaiting one. */
	openProposalId: string | null;
}

/** Raised when no cover-letter version exists for the candidacy yet. */
export class NoCoverLetterError extends Error {
	constructor() {
		super("No cover letter has been drafted for this job yet.");
		this.name = "NoCoverLetterError";
	}
}

interface VersionsResponse {
	versions: CoverLetterVersionSummary[];
	openProposalId: string | null;
	proposedVersionId: string | null;
}
interface VersionResponse {
	version: {
		id: string;
		version_no: number;
		status: CoverLetterVersionStatus;
		content: string;
		details?: { spokenNote?: SpokenNote | null } | null;
	};
}

/** Pull the spoken-note artifact off a version's `details`, or null when none. */
function readSpokenNote(
	details: VersionResponse["version"]["details"],
): SpokenNote | null {
	const note = details?.spokenNote;
	if (note && typeof note.audioUrl === "string" && note.audioUrl !== "") {
		return { audioUrl: note.audioUrl, provider: note.provider };
	}
	return null;
}

/**
 * Read the review for one candidacy's cover letter: the version history + open
 * proposal, then the full content of the version to present. The presented version
 * is the open proposal's target (the draft awaiting review) if one is open, else
 * the active (approved) version, else the newest version. Throws
 * {@link NoCoverLetterError} when the candidacy has no versions yet.
 */
export async function fetchCoverLetterReview(
	session: Session,
	candidacyId: string,
	get: CoverLettersGet = apiGet,
): Promise<CoverLetterReview> {
	const history = await get<VersionsResponse>(
		`/candidacies/${encodeURIComponent(candidacyId)}/cover-letters`,
		session.accessToken,
	);
	// Newest first for the history rail (the endpoint returns oldest-first).
	const versions = [...history.versions].sort(
		(a, b) => b.version_no - a.version_no,
	);
	const presentId =
		history.proposedVersionId ??
		versions.find((v) => v.status === "approved")?.id ??
		versions[0]?.id ??
		null;

	if (!presentId) throw new NoCoverLetterError();

	const detail = await get<VersionResponse>(
		`/cover-letters/${encodeURIComponent(presentId)}`,
		session.accessToken,
	);
	return {
		candidacyId,
		current: {
			id: detail.version.id,
			version_no: detail.version.version_no,
			status: detail.version.status,
			content: detail.version.content,
			spokenNote: readSpokenNote(detail.version.details),
		},
		versions,
		openProposalId: history.openProposalId,
	};
}

/**
 * Approve the candidate's OWN open cover-letter proposal — make the letter the
 * candidacy's active one and advance it toward apply. Keyed by the open proposal id
 * the review read resolved. Self-scoped via the `userId` body field on top of the
 * bearer token (the client contract, like the profile decide path).
 */
export async function approveCoverLetter(
	session: Session,
	proposalId: string,
	post: CoverLettersPost = apiPost,
): Promise<void> {
	await post(
		`/cover-letters/proposals/${encodeURIComponent(proposalId)}/decide/self`,
		session.accessToken,
		{ userId: session.user.id, action: "approve" },
	);
}

/**
 * Send the candidate's feedback on the open proposal — reject it with the feedback
 * captured as the note, returning the candidacy to drafting so Archer reworks the
 * letter. This is the "revise" trigger: the cockpit then watches for the reworked
 * draft to land as a fresh proposal.
 */
export async function reviseCoverLetter(
	session: Session,
	args: { proposalId: string; feedback: string },
	post: CoverLettersPost = apiPost,
): Promise<void> {
	await post(
		`/cover-letters/proposals/${encodeURIComponent(args.proposalId)}/decide/self`,
		session.accessToken,
		{ userId: session.user.id, action: "reject", note: args.feedback },
	);
}

// ── presentation helpers (pure) ──────────────────────────────────────────────
/** How a cover-letter candidacy reads as a coloured pill on the cockpit list. */
export interface CoverLetterBadge {
	label: string;
	tone: "review" | "drafting" | "approved" | "neutral";
}

/**
 * The badge for a candidacy's cover-letter state. `in_review` is the call to
 * action (your draft is waiting), `drafting` is in progress, `approved` is done.
 */
export function coverLetterBadge(status: CandidacyStatus): CoverLetterBadge {
	switch (status) {
		case "in_review":
			return { label: "Needs your review", tone: "review" };
		case "drafting":
		case "awaiting_cover_letter":
			return { label: "Archer is drafting", tone: "drafting" };
		case "approved":
			return { label: "Approved", tone: "approved" };
		default:
			return { label: "In progress", tone: "neutral" };
	}
}
