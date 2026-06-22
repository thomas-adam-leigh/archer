/**
 * The proposed profile draft a user reviews during onboarding (ported from
 * `apps/mobile/src/lib/profile.ts`).
 *
 * After résumé ingestion (or the scripted path) Archer submits a PROPOSED
 * profile version — never the live profile — for the candidate to approve. The
 * review screen reads that version's profile-wide `attributes` plus its
 * structured spine (work experience, education, skills, certifications, courses,
 * projects) and renders them résumé-style.
 *
 * The version + spine shapes mirror the backend: `attributes` is a snake_case
 * snapshot; spine lists are camelCase and only present when non-empty. We resolve
 * the single `proposed` version via the user-scoped version list, then read its
 * detail (which carries the spine).
 */

import { apiGet, apiPost } from "#/lib/api.ts";
import type { Session } from "#/lib/auth.ts";

/** External links captured on the profile-wide attributes snapshot. */
export interface ProfileLinks {
	linkedin?: string | null;
	github?: string | null;
	website?: string | null;
}

/** The version's profile-wide snapshot (snake_case, as the structurer writes it). */
export interface ProfileAttributes {
	full_name?: string | null;
	email?: string | null;
	phone?: string | null;
	location?: string | null;
	summary?: string | null;
	links?: ProfileLinks | null;
}

export interface WorkExperience {
	title: string;
	organization?: string | null;
	employmentType?: string | null;
	location?: string | null;
	startDate?: string | null;
	endDate?: string | null;
	isCurrent?: boolean | null;
	description?: string | null;
}
export interface Education {
	institution: string;
	degree?: string | null;
	fieldOfStudy?: string | null;
	startDate?: string | null;
	endDate?: string | null;
	grade?: string | null;
}
export interface Skill {
	name: string;
	category?: string | null;
	proficiency?: string | null;
	yearsExperience?: number | null;
}
export interface Certification {
	name: string;
	issuer?: string | null;
	issuedOn?: string | null;
	expiresOn?: string | null;
	credentialId?: string | null;
	url?: string | null;
}
export interface Course {
	name: string;
	provider?: string | null;
	completedOn?: string | null;
	url?: string | null;
}
export interface Project {
	name: string;
	role?: string | null;
	url?: string | null;
	startDate?: string | null;
	endDate?: string | null;
	description?: string | null;
}

/** A version's structured spine — every list optional, present only when non-empty. */
export interface ProfileSpine {
	workExperiences?: WorkExperience[];
	education?: Education[];
	skills?: Skill[];
	certifications?: Certification[];
	courses?: Course[];
	projects?: Project[];
}

/** The lifecycle of a profile version (mirrors the DB `profile_version_status`). */
export type ProfileVersionStatus =
	| "draft"
	| "proposed"
	| "approved"
	| "superseded";

/** One version of the user's profile (the approvable unit). */
export interface ProfileVersion {
	id: string;
	status: ProfileVersionStatus;
	version_no?: number;
	label?: string | null;
	attributes: ProfileAttributes;
}

/** The proposed draft the review screen renders: a version plus its spine. */
export interface ProfileDraft {
	version: ProfileVersion;
	spine: ProfileSpine;
}

/** Raised when no proposed version exists to review (e.g. it was already decided). */
export class NoProposedVersionError extends Error {
	constructor() {
		super("No profile draft is waiting for review.");
		this.name = "NoProposedVersionError";
	}
}

/** The GET surface the fetch needs — injectable so it can be tested offline. */
export type ProfileFetch = <T>(path: string, accessToken: string) => Promise<T>;

interface VersionsResponse {
	versions: ProfileVersion[];
	liveVersionId: string | null;
}
interface VersionResponse {
	version: ProfileVersion;
	spine?: ProfileSpine | null;
}

/**
 * Fetch the user's PROPOSED profile draft (version + spine) for review.
 *
 * Resolves the single `proposed` version from the user-scoped version list, then
 * reads its detail (attributes + spine). Throws {@link NoProposedVersionError}
 * when nothing is awaiting review, so the screen can show a graceful empty state.
 */
export async function fetchProposedProfileDraft(
	session: Session,
	get: ProfileFetch = apiGet,
): Promise<ProfileDraft> {
	const user = encodeURIComponent(session.user.id);
	const list = await get<VersionsResponse>(
		`/profile/versions?user=${user}`,
		session.accessToken,
	);
	const proposed = list.versions.find((v) => v.status === "proposed");
	if (!proposed) throw new NoProposedVersionError();

	const detail = await get<VersionResponse>(
		`/profile/versions/${proposed.id}?user=${user}`,
		session.accessToken,
	);
	return { version: detail.version, spine: detail.spine ?? {} };
}

/** The POST surface the decide/revise calls need — injectable for offline tests. */
export type ProfilePost = <T>(
	path: string,
	accessToken: string,
	body?: unknown,
) => Promise<T>;

/**
 * Self-approve the candidate's OWN proposed profile draft, advancing onboarding
 * past the review step. Keyed by the open proposal id the review screen resolves
 * from `/onboarding/progress`. The user is scoped via the `userId` body field on
 * top of the bearer token (the client contract).
 */
export async function approveProposedDraft(
	session: Session,
	proposalId: string,
	post: ProfilePost = apiPost,
): Promise<void> {
	await post(
		`/onboarding/proposals/${proposalId}/decide/self`,
		session.accessToken,
		{ userId: session.user.id, action: "approve" },
	);
}

/** A streamed revise run the review screen subscribes to (same shape as an ingest run). */
export interface RevisionStarted {
	threadId: string;
	runId: string;
}

/**
 * Revise the open proposed draft from the candidate's feedback, kicking off a
 * streamed run that amends the draft (never blanking it) and lands a NEW
 * proposed version on the shared review. Returns the run's `threadId`/`runId` so
 * the caller can show the live processing state and loop back to review.
 */
export async function reviseProposedDraft(
	session: Session,
	args: { threadId: string; feedback: string },
	post: ProfilePost = apiPost,
): Promise<RevisionStarted> {
	const resp = await post<{ threadId: string; runId: string }>(
		"/onboarding/revise",
		session.accessToken,
		{ threadId: args.threadId, feedback: args.feedback },
	);
	return { threadId: resp.threadId, runId: resp.runId };
}
