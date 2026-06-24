/**
 * The companies route's live data: the browsable directory of companies Archer
 * has finished researching, the live "Archer is researching …" in-progress
 * indicator, and the detail behind one company (ARC-151).
 *
 * Two reads back the list route:
 *   - `GET /companies?status=enriched` — the user's *enriched* companies, the only
 *     ones the directory shows. A company is "theirs" if a candidacy of theirs
 *     points at a posting there; `new`/`enrichment_failed` are never surfaced as a
 *     directory.
 *   - `GET /companies?status=researching` — the companies Archer is researching
 *     right now (kicked off once a job there is shortlisted), rendered as a calm
 *     in-action indicator separate from the enriched directory.
 *
 * The detail route reads `GET /companies/{id}` — one company's full identity (the
 * enrichment the Researcher materialized: description, links, recruitment email)
 * plus its contacts.
 *
 * Reads are JWT-scoped own-rows-only; we pass `?user=` as the documented client
 * contract (jobs.ts/preferences.ts) on top of the bearer token. The fetch seam is
 * injectable so the pure shaping helpers stay testable offline.
 */

import { apiGet } from "#/lib/api.ts";
import type { Session } from "#/lib/auth.ts";

/** The GET surface these reads need — injectable so they can be tested offline. */
export type CompaniesGet = <T>(path: string, accessToken: string) => Promise<T>;

/** A company's enrichment status (mirrors db enum `company_status`). */
export type CompanyStatus =
	| "new"
	| "researching"
	| "enriched"
	| "enrichment_failed";

// ── company list ───────────────────────────────────────────────────────────
/** A company projected for the directory/indicator (mirrors db `CompanySummary`). */
export interface CompanyListItem {
	id: string;
	name: string;
	status: CompanyStatus;
	domain: string | null;
	website_url: string | null;
	description: string | null;
	created_at: string;
}

/** The enriched directory + the live researching indicator, read together. */
export interface CompaniesOverview {
	/** The browsable directory — enriched only. */
	enriched: CompanyListItem[];
	/** Companies Archer is researching right now (the in-action indicator). */
	researching: CompanyListItem[];
}

/** Read the user's companies for one enrichment status, ordered by name. */
async function listCompaniesByStatus(
	session: Session,
	status: CompanyStatus,
	get: CompaniesGet,
): Promise<CompanyListItem[]> {
	const user = encodeURIComponent(session.user.id);
	const resp = await get<{ user: string; companies: CompanyListItem[] }>(
		`/companies?user=${user}&status=${status}`,
		session.accessToken,
	);
	return resp.companies ?? [];
}

/**
 * Read the companies overview: the `enriched` directory and the `researching`
 * in-action set in parallel. Keeping each read status-filtered at the source
 * preserves the never-surface-`new`/`failed` guarantee rather than relying on the
 * client to filter a broader read.
 */
export async function fetchCompaniesOverview(
	session: Session,
	get: CompaniesGet = apiGet,
): Promise<CompaniesOverview> {
	const [enriched, researching] = await Promise.all([
		listCompaniesByStatus(session, "enriched", get),
		listCompaniesByStatus(session, "researching", get),
	]);
	return { enriched, researching };
}

// ── company detail ─────────────────────────────────────────────────────────
/** A person on a company's team (mirrors db `Contact`). */
export interface CompanyContact {
	id: string;
	full_name: string;
	email: string | null;
	linkedin_url: string | null;
	role_title: string | null;
	notes: string | null;
}

/** Full detail for one company (mirrors db `CompanyDetail`). */
export interface CompanyDetail {
	id: string;
	name: string;
	status: CompanyStatus;
	domain: string | null;
	website_url: string | null;
	linkedin_url: string | null;
	description: string | null;
	recruitment_email: string | null;
	enrichment: unknown;
	created_at: string;
	updated_at: string;
	contacts: CompanyContact[];
}

/** Read one company's full detail. */
export async function fetchCompanyDetail(
	session: Session,
	id: string,
	get: CompaniesGet = apiGet,
): Promise<CompanyDetail> {
	const resp = await get<{ company: CompanyDetail }>(
		`/companies/${encodeURIComponent(id)}`,
		session.accessToken,
	);
	return resp.company;
}

// ── presentation helpers (pure) ──────────────────────────────────────────────
/** How a company's enrichment status reads as a coloured pill. */
export interface CompanyStatusBadge {
	label: string;
	/** A coarse tone the UI maps to colour. */
	tone: "enriched" | "researching" | "neutral";
}

/**
 * The badge for a company's status. The directory only carries `enriched`, but
 * the detail view can show a company at any stage, so the in-progress and
 * not-yet states get calm, humanised labels rather than raw enum values.
 */
export function companyStatusBadge(status: CompanyStatus): CompanyStatusBadge {
	switch (status) {
		case "enriched":
			return { label: "Researched", tone: "enriched" };
		case "researching":
			return { label: "Researching…", tone: "researching" };
		case "enrichment_failed":
			return { label: "Research paused", tone: "neutral" };
		default:
			return { label: "Not yet researched", tone: "neutral" };
	}
}

/**
 * A company's website host, trimmed to a clean display string (no scheme or
 * trailing slash) — or `null` when there's no usable URL. Falls back to the raw
 * value if it isn't a parseable URL.
 */
export function websiteLabel(url: string | null): string | null {
	if (!url) return null;
	try {
		return new URL(url).host.replace(/^www\./, "");
	} catch {
		return url.replace(/^https?:\/\//, "").replace(/\/$/, "") || null;
	}
}
