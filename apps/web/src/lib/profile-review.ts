/**
 * Map a {@link ProfileDraft} (a proposed version's attributes + structured spine)
 * into the flat view model the résumé-style review screen renders (ARC-107).
 *
 * The backend shapes are awkward for direct rendering: contact lives on the
 * snake_case `attributes`, the spine lists are camelCase and optional, dates are
 * free-ish strings, and there is no single "headline title" field — it's derived
 * from the most-recent role. Keeping this mapping pure (no JSX) lets the suite
 * verify the derivations (initials, date ranges, headline, merged certs/courses)
 * offline; the component just lays the result out.
 */

import type { ProfileDraft } from "#/lib/profile.ts";

/** An external profile link, normalised for the header chips. */
export interface ReviewLink {
	kind: "linkedin" | "github" | "website";
	/** The human-readable label (host/handle, stripped of the scheme). */
	label: string;
	/** The full, navigable URL. */
	href: string;
}

/** One experience entry, résumé-style (role, employer, period, bullet points). */
export interface ReviewExperience {
	role: string;
	company: string | null;
	period: string | null;
	bullets: string[];
}

/** One education entry (degree line, school, period). */
export interface ReviewEducation {
	degree: string | null;
	school: string;
	period: string | null;
}

/** The flat, render-ready shape of a proposed profile draft. */
export interface ProfileReviewView {
	versionNo: number | null;
	initials: string;
	name: string;
	/** The headline role, derived from the most-recent experience (may be absent). */
	title: string | null;
	location: string | null;
	email: string | null;
	phone: string | null;
	links: ReviewLink[];
	summary: string | null;
	experience: ReviewExperience[];
	education: ReviewEducation[];
	/** Certifications and courses, merged into one "Courses & Certifications" list. */
	certifications: string[];
	skills: string[];
}

/** Trim a possibly-nullish string to a non-empty value, or null. */
function clean(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

/** Up-to-two-letter initials from a full name (falls back to "?"). */
export function initialsOf(name: string | null): string {
	const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return "?";
	const letters = [words[0], words[words.length - 1]]
		.slice(0, words.length === 1 ? 1 : 2)
		.map((w) => w[0]?.toUpperCase() ?? "");
	return letters.join("") || "?";
}

const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

/**
 * Format a single date the structurer may emit as `YYYY-MM-DD`, `YYYY-MM` or
 * `YYYY` into a résumé-friendly label ("Mar 2021", "2021"); anything else is
 * passed through trimmed, so unexpected formats still display.
 */
export function formatDate(value: string | null | undefined): string | null {
	const v = clean(value);
	if (!v) return null;
	const ym = /^(\d{4})-(\d{2})/.exec(v);
	if (ym) {
		const month = MONTHS[Number(ym[2]) - 1];
		return month ? `${month} ${ym[1]}` : ym[1];
	}
	if (/^\d{4}$/.test(v)) return v;
	return v;
}

/**
 * Build the "start – end" period label. A current role renders "start – Present";
 * a lone start or end renders on its own; nothing renders to null (so the period
 * line is hidden rather than showing an empty dash).
 */
export function formatPeriod(
	start: string | null | undefined,
	end: string | null | undefined,
	isCurrent: boolean | null | undefined,
): string | null {
	const from = formatDate(start);
	const to = isCurrent ? "Present" : formatDate(end);
	if (from && to) return `${from} – ${to}`;
	return from ?? to ?? null;
}

/** Split a free-text description into bullet points (by line), dropping blanks. */
function toBullets(description: string | null | undefined): string[] {
	return (description ?? "")
		.split(/\r?\n/)
		.map((line) => line.replace(/^[•\-*·]\s*/, "").trim())
		.filter(Boolean);
}

/** Join a name with an optional qualifier as "name · qualifier". */
function withQualifier(name: string, qualifier: string | null): string {
	return qualifier ? `${name} · ${qualifier}` : name;
}

const LINK_KINDS: ReadonlyArray<ReviewLink["kind"]> = [
	"linkedin",
	"github",
	"website",
];

/** Strip the scheme + trailing slash from a URL for a compact chip label. */
function linkLabel(url: string): string {
	return url
		.trim()
		.replace(/^https?:\/\//, "")
		.replace(/\/$/, "");
}

/** Derive the header link chips from the attributes' links snapshot, in order. */
function toLinks(
	links: ProfileDraft["version"]["attributes"]["links"],
): ReviewLink[] {
	if (!links) return [];
	const out: ReviewLink[] = [];
	for (const kind of LINK_KINDS) {
		const raw = clean(links[kind]);
		if (raw) out.push({ kind, label: linkLabel(raw), href: raw });
	}
	return out;
}

/** Map a proposed draft into the flat, render-ready review view model. */
export function toProfileReviewView(draft: ProfileDraft): ProfileReviewView {
	const { attributes, version_no } = draft.version;
	const spine = draft.spine;
	const experiences = spine.workExperiences ?? [];

	// The headline is the current role, else the first listed experience's title.
	const headline =
		experiences.find((x) => x.isCurrent) ?? experiences[0] ?? null;

	const certifications = [
		...(spine.certifications ?? []).map((c) =>
			withQualifier(c.name, clean(c.issuer)),
		),
		...(spine.courses ?? []).map((c) =>
			withQualifier(c.name, clean(c.provider)),
		),
	];

	return {
		versionNo: typeof version_no === "number" ? version_no : null,
		initials: initialsOf(clean(attributes.full_name)),
		name: clean(attributes.full_name) ?? "Your profile",
		title: clean(headline?.title),
		location: clean(attributes.location),
		email: clean(attributes.email),
		phone: clean(attributes.phone),
		links: toLinks(attributes.links),
		summary: clean(attributes.summary),
		experience: experiences.map((x) => ({
			role: clean(x.title) ?? "Role",
			company: clean(x.organization),
			period: formatPeriod(x.startDate, x.endDate, x.isCurrent),
			bullets: toBullets(x.description),
		})),
		education: (spine.education ?? []).map((e) => ({
			degree:
				clean(
					[clean(e.degree), clean(e.fieldOfStudy)].filter(Boolean).join(", "),
				) ?? null,
			school: clean(e.institution) ?? "Institution",
			period: formatPeriod(e.startDate, e.endDate, false),
		})),
		certifications,
		skills: (spine.skills ?? []).map((s) => s.name).filter(Boolean),
	};
}
