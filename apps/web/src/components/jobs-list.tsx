import { Link } from "@tanstack/react-router";
import { Building2, ChevronRight, Radar } from "lucide-react";
import { InlineErrorState } from "#/components/ui/error-state.tsx";
import {
	type JobListItem,
	type JobStatusBadge,
	jobStatusBadge,
	matchScoreLabel,
} from "#/lib/jobs.ts";

/**
 * The jobs route's curated feed (ARC-149) — the candidacies Archer has decided are
 * worth a look (`shortlisted` + `alternative_outreach`), each tagged with its board
 * and match score and linking to its detail. Presentational: the route owns the
 * query; this renders calm loading / empty / error states. The empty state is the
 * launch default — at first there are zero shortlisted jobs.
 */

/** A read the jobs list renders, narrowed from a TanStack Query result. */
interface QueryView<T> {
	data?: T;
	isPending: boolean;
	isError: boolean;
	refetch?: () => void;
}

/** A muted single-line note used for loading / error states. */
function Note({ children }: { children: string }) {
	return <p className="text-[13px] text-[var(--txt3)]">{children}</p>;
}

/** The tints a status badge maps its tone to. */
const BADGE_TONE: Record<JobStatusBadge["tone"], string> = {
	shortlisted: "border-brand/28 bg-brand/[0.08] text-[var(--accent)]",
	outreach: "border-[var(--line)] bg-white/[0.04] text-[var(--txt2)]",
	neutral: "border-[var(--line)] bg-white/[0.04] text-[var(--txt3)]",
};

/** A small coloured pill (status badge, match score, board tag). */
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

/** One job card in the feed, linking through to its detail. */
function JobCard({
	job,
	boardName,
}: {
	job: JobListItem;
	boardName: BoardName;
}) {
	const badge = jobStatusBadge(job.status);
	const score = matchScoreLabel(job.match_score);
	return (
		<li data-testid="jobs-item">
			<Link
				to="/jobs/$candidacyId"
				params={{ candidacyId: job.id }}
				className="flex items-center gap-3 rounded-xl border border-[var(--line-2)] bg-[var(--card)] px-4 py-3.5 transition-colors hover:border-brand/45 hover:bg-white/[0.03]"
			>
				<div className="flex min-w-0 flex-1 flex-col gap-1.5">
					<span className="truncate text-[15px] font-semibold text-[var(--txt)]">
						{job.posting_title}
					</span>
					<span className="flex items-center gap-1.5 text-[13px] text-[var(--txt2)]">
						<Building2 className="size-[14px] shrink-0 text-[var(--txt3)]" />
						{job.company_name ?? "Company being researched"}
					</span>
					<div className="mt-0.5 flex flex-wrap items-center gap-1.5">
						<Pill className={BADGE_TONE[badge.tone]}>{badge.label}</Pill>
						<Pill className="border-[var(--line)] bg-white/[0.04] text-[var(--txt3)]">
							{boardName(job.board_slug)}
						</Pill>
						{score ? (
							<Pill className="border-[var(--line)] bg-white/[0.04] text-[var(--txt2)]">
								{score}
							</Pill>
						) : null}
					</div>
				</div>
				<ChevronRight className="size-[18px] shrink-0 text-[var(--txt3)]" />
			</Link>
		</li>
	);
}

/** Resolve a board's display name from its slug, falling back to the slug. */
type BoardName = (slug: string) => string;

export function JobsList({
	jobs,
	boardName,
}: {
	jobs: QueryView<JobListItem[]>;
	boardName: BoardName;
}) {
	const rows = jobs.data ?? [];
	return (
		<div data-testid="jobs-page" className="a-fadeup">
			<header className="mb-6">
				<h1 className="font-heading text-[clamp(22px,2.6vw,30px)] font-bold tracking-[-0.02em]">
					Jobs
				</h1>
				<p className="mt-1.5 text-[14px] text-[var(--txt2)]">
					The roles Archer has shortlisted for you — only the ones worth your
					time.
				</p>
			</header>

			{jobs.isPending ? (
				<Note>Loading your jobs…</Note>
			) : jobs.isError ? (
				<InlineErrorState
					testId="jobs-error"
					message="Couldn't load your jobs just now."
					onRetry={() => jobs.refetch?.()}
				/>
			) : rows.length === 0 ? (
				<div
					data-testid="jobs-empty"
					className="flex flex-col items-center gap-3 rounded-[18px] border border-[var(--line-2)] bg-[var(--card-2)] px-6 py-12 text-center"
				>
					<Radar className="size-7 text-[var(--txt3)]" />
					<p className="text-[15px] font-semibold text-[var(--txt)]">
						Archer is searching — no shortlisted jobs yet
					</p>
					<p className="max-w-[380px] text-[13px] text-[var(--txt3)]">
						When Archer finds a role that fits, it'll shortlist it here for your
						review. Nothing for you to do in the meantime.
					</p>
				</div>
			) : (
				<ul data-testid="jobs-feed" className="flex flex-col gap-2.5">
					{rows.map((job) => (
						<JobCard key={job.id} job={job} boardName={boardName} />
					))}
				</ul>
			)}
		</div>
	);
}
