import {
	Briefcase,
	ExternalLink,
	GraduationCap,
	History,
	MapPin,
	Sparkles,
	UserRound,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { InlineErrorState } from "#/components/ui/error-state.tsx";
import { WorkPreferences } from "#/components/work-preferences.tsx";
import type { WorkPreferences as Prefs } from "#/lib/preferences.ts";
import {
	type LiveProfile,
	type ProfileOverview,
	type VersionBadge,
	versionBadge,
	versionDate,
} from "#/lib/profile-overview.ts";
import { toProfileReviewView } from "#/lib/profile-review.ts";

/**
 * The daily-use profile route's view (ARC-152) — the candidate's live profile as
 * a calm reference page: who Archer understands them to be (identity + the
 * structured spine, rendered résumé-style and read-only), their *editable* work
 * preferences (the one direct write this route owns), and the version history.
 *
 * The structured profile stays proposal-gated — there's no inline editor here; a
 * pending proposed version surfaces as a calm "awaiting review" note instead, and
 * the history shows the live/previous lifecycle. Presentational: the route owns
 * the query + the save mutation and threads them in.
 */

/** A read the view renders, narrowed from a TanStack Query result. */
interface QueryView<T> {
	data?: T;
	isPending: boolean;
	isError: boolean;
	refetch?: () => void;
}

/** The save surface the preferences card drives, narrowed from a mutation. */
interface SaveView {
	mutate: (prefs: Prefs) => void;
	isPending: boolean;
	isSuccess: boolean;
	isError: boolean;
}

/** A muted single-line note used for loading / error states. */
function Note({ children }: { children: string }) {
	return <p className="text-[13px] text-[var(--txt3)]">{children}</p>;
}

/** A titled card section with an icon. */
function Card({
	title,
	icon,
	testid,
	children,
}: {
	title: string;
	icon: ReactNode;
	testid?: string;
	children: ReactNode;
}) {
	return (
		<section
			data-testid={testid}
			className="rounded-[18px] border border-[var(--line-2)] bg-[var(--card-2)] px-[18px] py-4"
		>
			<div className="mb-3 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.09em] text-[var(--txt3)]">
				{icon}
				{title}
			</div>
			{children}
		</section>
	);
}

const BADGE_TONE: Record<VersionBadge["tone"], string> = {
	live: "border-brand/28 bg-brand/[0.08] text-[var(--accent)]",
	proposed: "border-[var(--line)] bg-white/[0.04] text-[var(--txt2)]",
	neutral: "border-[var(--line)] bg-white/[0.04] text-[var(--txt3)]",
};

function Pill({
	children,
	className = "",
}: {
	children: string;
	className?: string;
}) {
	return (
		<span
			className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${className}`}
		>
			{children}
		</span>
	);
}

/** Seed the editable preferences from the live profile (no live profile → empty). */
function prefsFromProfile(profile: LiveProfile | null): Prefs {
	if (!profile) return {};
	return {
		workPref: profile.work_pref === "unknown" ? undefined : profile.work_pref,
		willingRemote: profile.willing_remote,
		currentSalary: profile.current_salary ?? undefined,
		preferredSalary: profile.preferred_salary ?? undefined,
		noticePeriod: profile.notice_period ?? undefined,
	};
}

/** The identity header + structured spine, rendered résumé-style and read-only. */
function StructuredProfile({ overview }: { overview: ProfileOverview }) {
	const view = toProfileReviewView({
		version: {
			id: overview.liveVersionId ?? "live",
			status: "approved",
			attributes: overview.profile?.attributes ?? {},
		},
		spine: overview.spine,
	});
	const hasAny =
		view.experience.length > 0 ||
		view.education.length > 0 ||
		view.skills.length > 0 ||
		view.certifications.length > 0 ||
		Boolean(view.summary);

	return (
		<div data-testid="profile-structured" className="flex flex-col gap-4">
			<Card title="You" icon={<UserRound className="size-3.5" />}>
				<h2
					data-testid="profile-name"
					className="text-[20px] font-bold tracking-[-0.01em] text-[var(--txt)]"
				>
					{view.name}
				</h2>
				{view.title ? (
					<p className="mt-0.5 text-[14px] font-semibold text-[var(--accent-2)]">
						{view.title}
					</p>
				) : null}
				{view.location ? (
					<p className="mt-1.5 inline-flex items-center gap-1.5 text-[13px] text-[var(--txt2)]">
						<MapPin className="size-[14px] text-[var(--txt3)]" />
						{view.location}
					</p>
				) : null}
				{view.links.length > 0 ? (
					<div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
						{view.links.map((link) => (
							<a
								key={link.href}
								href={link.href}
								target="_blank"
								rel="noopener noreferrer"
								className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--accent)] hover:underline"
							>
								{link.label}
								<ExternalLink className="size-[13px]" />
							</a>
						))}
					</div>
				) : null}
				{view.summary ? (
					<p className="mt-3 text-[14px] leading-relaxed text-[var(--txt2)]">
						{view.summary}
					</p>
				) : null}
			</Card>

			{view.experience.length > 0 ? (
				<Card
					title="Experience"
					icon={<Briefcase className="size-3.5" />}
					testid="profile-experience"
				>
					<ul className="flex flex-col gap-3.5">
						{view.experience.map((exp) => (
							<li
								key={`${exp.role}-${exp.company}-${exp.period}`}
								className="flex flex-col gap-0.5"
							>
								<span className="text-[14px] font-semibold text-[var(--txt)]">
									{exp.role}
									{exp.company ? (
										<span className="font-normal text-[var(--txt2)]">
											{" · "}
											{exp.company}
										</span>
									) : null}
								</span>
								{exp.period ? (
									<span className="text-[12px] text-[var(--txt3)]">
										{exp.period}
									</span>
								) : null}
								{exp.bullets.length > 0 ? (
									<ul className="mt-1 flex flex-col gap-1 text-[13px] text-[var(--txt2)]">
										{exp.bullets.map((b) => (
											<li key={b} className="pl-3 -indent-3">
												• {b}
											</li>
										))}
									</ul>
								) : null}
							</li>
						))}
					</ul>
				</Card>
			) : null}

			{view.education.length > 0 ? (
				<Card title="Education" icon={<GraduationCap className="size-3.5" />}>
					<ul className="flex flex-col gap-2.5">
						{view.education.map((ed) => (
							<li
								key={`${ed.school}-${ed.degree}-${ed.period}`}
								className="flex flex-col gap-0.5"
							>
								<span className="text-[14px] font-semibold text-[var(--txt)]">
									{ed.degree ?? ed.school}
								</span>
								{ed.degree ? (
									<span className="text-[13px] text-[var(--txt2)]">
										{ed.school}
									</span>
								) : null}
								{ed.period ? (
									<span className="text-[12px] text-[var(--txt3)]">
										{ed.period}
									</span>
								) : null}
							</li>
						))}
					</ul>
				</Card>
			) : null}

			{view.skills.length > 0 ? (
				<Card title="Skills" icon={<Sparkles className="size-3.5" />}>
					<div className="flex flex-wrap gap-1.5">
						{view.skills.map((skill) => (
							<Pill
								key={skill}
								className="border-[var(--line)] bg-white/[0.04] text-[var(--txt2)]"
							>
								{skill}
							</Pill>
						))}
					</div>
				</Card>
			) : null}

			{view.certifications.length > 0 ? (
				<Card
					title="Courses & certifications"
					icon={<Sparkles className="size-3.5" />}
				>
					<ul className="flex flex-col gap-1.5 text-[13px] text-[var(--txt2)]">
						{view.certifications.map((c) => (
							<li key={c}>{c}</li>
						))}
					</ul>
				</Card>
			) : null}

			{!hasAny ? (
				<Note>
					Archer hasn't structured your experience yet — it'll appear here once
					it has.
				</Note>
			) : null}
		</div>
	);
}

/** The editable work-preferences card — the one direct write this route owns. */
function PreferencesCard({
	profile,
	save,
}: {
	profile: LiveProfile | null;
	save: SaveView;
}) {
	const [prefs, setPrefs] = useState<Prefs>(() => prefsFromProfile(profile));
	// Re-seed when the loaded profile changes (e.g. it arrives after first paint).
	useEffect(() => {
		setPrefs(prefsFromProfile(profile));
	}, [profile]);

	return (
		<div data-testid="profile-preferences">
			<WorkPreferences value={prefs} onChange={setPrefs} />
			<div className="mt-3 flex items-center gap-3">
				<Button
					type="button"
					data-testid="profile-preferences-save"
					onClick={() => save.mutate(prefs)}
					disabled={save.isPending}
				>
					{save.isPending ? "Saving…" : "Save preferences"}
				</Button>
				{save.isSuccess ? (
					<span
						data-testid="profile-preferences-saved"
						className="text-[13px] font-semibold text-[var(--accent)]"
					>
						Saved.
					</span>
				) : null}
				{save.isError ? (
					<span className="text-[13px] text-[#f0936c]">
						Couldn't save just now.
					</span>
				) : null}
			</div>
		</div>
	);
}

/** A calm note that an update is proposal-gated and waiting for review. */
function ProposedBanner() {
	return (
		<div
			data-testid="profile-proposed"
			className="mb-5 flex items-start gap-2.5 rounded-[14px] border border-brand/25 bg-brand/[0.06] px-4 py-3"
		>
			<Sparkles className="mt-0.5 size-[16px] shrink-0 text-[var(--accent)]" />
			<p className="text-[13px] text-[var(--txt2)]">
				<span className="font-semibold text-[var(--txt)]">
					Archer has proposed an update
				</span>{" "}
				to your profile — it's waiting for your review before it goes live.
			</p>
		</div>
	);
}

/** The version-history timeline (newest first), with live / previous badges. */
function VersionHistory({ overview }: { overview: ProfileOverview }) {
	if (overview.versions.length === 0) return null;
	const ordered = [...overview.versions].reverse();
	return (
		<Card
			title="Version history"
			icon={<History className="size-3.5" />}
			testid="profile-versions"
		>
			<ul className="flex flex-col gap-2">
				{ordered.map((v) => {
					const badge = versionBadge(v.status, v.id === overview.liveVersionId);
					return (
						<li
							key={v.id}
							data-testid="profile-version"
							className="flex items-center gap-3 rounded-xl border border-[var(--line-2)] bg-[var(--card)] px-3.5 py-2.5"
						>
							<span className="text-[13px] font-semibold text-[var(--txt)]">
								v{v.version_no}
							</span>
							{v.label ? (
								<span className="min-w-0 flex-1 truncate text-[13px] text-[var(--txt2)]">
									{v.label}
								</span>
							) : (
								<span className="flex-1" />
							)}
							<span className="text-[12px] text-[var(--txt3)]">
								{versionDate(v.created_at)}
							</span>
							<Pill className={BADGE_TONE[badge.tone]}>{badge.label}</Pill>
						</li>
					);
				})}
			</ul>
		</Card>
	);
}

export function ProfileView({
	overview,
	save,
}: {
	overview: QueryView<ProfileOverview>;
	save: SaveView;
}) {
	return (
		<div data-testid="profile-page" className="a-fadeup">
			<header className="mb-6">
				<h1 className="font-heading text-[clamp(22px,2.6vw,30px)] font-bold tracking-[-0.02em]">
					Profile
				</h1>
				<p className="mt-1.5 text-[14px] text-[var(--txt2)]">
					Who Archer understands you to be — and how you want to work.
				</p>
			</header>

			{overview.isPending ? (
				<Note>Loading your profile…</Note>
			) : overview.isError ? (
				<InlineErrorState
					testId="profile-error"
					message="Couldn't load your profile just now."
					onRetry={() => overview.refetch?.()}
				/>
			) : overview.data ? (
				<div className="flex flex-col gap-4">
					{overview.data.proposedVersionId ? <ProposedBanner /> : null}
					<PreferencesCard profile={overview.data.profile} save={save} />
					<StructuredProfile overview={overview.data} />
					<p className="text-[12px] text-[var(--txt3)]">
						Changes to your experience go through Archer's review, so the live
						profile always reflects what you've approved.
					</p>
					<VersionHistory overview={overview.data} />
				</div>
			) : null}
		</div>
	);
}
