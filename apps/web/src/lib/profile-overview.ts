/**
 * The daily-use profile route's live data (ARC-152): the candidate's *live*
 * structured profile, their work preferences, and the version history.
 *
 * Distinct from {@link "#/lib/profile.ts"}, which reads the single PROPOSED draft
 * during onboarding review. Here we read what's already live:
 *   - `GET /profile` — the typed `profiles` row (work preferences, links, the
 *     profile-wide `attributes` snapshot).
 *   - `GET /profile/versions` — the version history + the id of the live one.
 *   - `GET /profile/versions/{liveVersionId}` — the live version's structured
 *     spine (work experience, education, skills…), rendered résumé-style.
 *
 * Work preferences are edited directly (`POST /profile/preferences`, see
 * {@link "#/lib/preferences.ts"}); the structured profile stays proposal-gated, so
 * this route renders it read-only and surfaces the version lifecycle instead.
 *
 * Reads are JWT-scoped own-rows-only; we pass `?user=` as the documented client
 * contract (jobs.ts/companies.ts) on top of the bearer token. The fetch seam is
 * injectable so the pure shaping helpers stay testable offline.
 */

import { apiGet } from "#/lib/api.ts";
import type { Session } from "#/lib/auth.ts";
import type { WorkMode } from "#/lib/preferences.ts";
import type {
	ProfileAttributes,
	ProfileSpine,
	ProfileVersionStatus,
} from "#/lib/profile.ts";

/** The GET surface these reads need — injectable so they can be tested offline. */
export type ProfileGet = <T>(path: string, accessToken: string) => Promise<T>;

/** The live `profiles` row (the typed columns + the profile-wide snapshot). */
export interface LiveProfile {
	about: string | null;
	location: string | null;
	linkedin_url: string | null;
	portfolio_url: string | null;
	resume_url: string | null;
	years_experience: number | null;
	willing_remote: boolean;
	work_pref: WorkMode;
	current_salary: string | null;
	preferred_salary: string | null;
	notice_period: string | null;
	attributes: ProfileAttributes;
	updated_at?: string;
}

/** One row in the version-history timeline (a subset of the backend version). */
export interface ProfileVersionSummary {
	id: string;
	version_no: number;
	status: ProfileVersionStatus;
	label: string | null;
	created_at: string;
}

/** Everything the profile route renders, read together. */
export interface ProfileOverview {
	/** The live profiles row, or `null` before the first approval. */
	profile: LiveProfile | null;
	/** The live version's structured spine (empty when there's no live version). */
	spine: ProfileSpine;
	/** The full version history, newest-version-number last (as the backend orders). */
	versions: ProfileVersionSummary[];
	/** The currently-live version id, or `null` before the first approval. */
	liveVersionId: string | null;
	/** An open proposed version awaiting review, if any — the proposal gate. */
	proposedVersionId: string | null;
}

interface ProfileResponse {
	user: string;
	profile: LiveProfile | null;
}
interface VersionsResponse {
	user: string;
	versions: ProfileVersionSummary[];
	liveVersionId: string | null;
}
interface VersionDetailResponse {
	spine?: ProfileSpine | null;
}

/**
 * Read the profile overview: the live profiles row + version history in parallel,
 * then the live version's spine (skipped when there's no live version yet). The
 * structured spine lives on the version, not the profiles row, so the résumé-style
 * view needs the live version detail to render experience/education/skills.
 */
export async function fetchProfileOverview(
	session: Session,
	get: ProfileGet = apiGet,
): Promise<ProfileOverview> {
	const user = encodeURIComponent(session.user.id);
	const [profileResp, versionsResp] = await Promise.all([
		get<ProfileResponse>(`/profile?user=${user}`, session.accessToken),
		get<VersionsResponse>(
			`/profile/versions?user=${user}`,
			session.accessToken,
		),
	]);
	const versions = versionsResp.versions ?? [];
	const liveVersionId = versionsResp.liveVersionId;

	let spine: ProfileSpine = {};
	if (liveVersionId) {
		const detail = await get<VersionDetailResponse>(
			`/profile/versions/${liveVersionId}?user=${user}`,
			session.accessToken,
		);
		spine = detail.spine ?? {};
	}

	return {
		profile: profileResp.profile,
		spine,
		versions,
		liveVersionId,
		proposedVersionId:
			versions.find((v) => v.status === "proposed")?.id ?? null,
	};
}

// ── presentation helpers (pure) ──────────────────────────────────────────────
/** How one version reads in the history timeline. */
export interface VersionBadge {
	label: string;
	/** A coarse tone the UI maps to colour. */
	tone: "live" | "proposed" | "neutral";
}

/**
 * The badge for a version. The live version (the currently-approved one) reads
 * "Live"; an open proposal reads "Awaiting review"; everything else — earlier
 * approved/superseded snapshots — reads "Previous".
 */
export function versionBadge(
	status: ProfileVersionStatus,
	isLive: boolean,
): VersionBadge {
	if (isLive) return { label: "Live", tone: "live" };
	if (status === "proposed")
		return { label: "Awaiting review", tone: "proposed" };
	if (status === "draft") return { label: "Draft", tone: "neutral" };
	return { label: "Previous", tone: "neutral" };
}

/** A version's date, rendered as a short, locale-stable day string. */
export function versionDate(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}
