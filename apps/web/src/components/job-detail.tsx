import { Link } from "@tanstack/react-router";
import {
	ArrowLeft,
	Building2,
	ExternalLink,
	MapPin,
	Sparkles,
} from "lucide-react";
import type { ReactNode } from "react";
import {
	type JobDetail,
	type JobStatusBadge,
	jobStatusBadge,
	matchScoreLabel,
	workModeLabel,
} from "#/lib/jobs.ts";

/**
 * The job-detail view (ARC-149) — one candidacy in full: the posting, the
 * why-matched (triage decision/reason + score), a company summary, and any
 * external-form state. Presentational: the route owns the query and renders calm
 * loading / error states around this.
 */

/** A read the detail view renders, narrowed from a TanStack Query result. */
interface QueryView<T> {
	data?: T;
	isPending: boolean;
	isError: boolean;
}

/** Resolve a board's display name from its slug, falling back to the slug. */
type BoardName = (slug: string) => string;

const BADGE_TONE: Record<JobStatusBadge["tone"], string> = {
	shortlisted: "border-brand/28 bg-brand/[0.08] text-[var(--accent)]",
	outreach: "border-[var(--line)] bg-white/[0.04] text-[var(--txt2)]",
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

/** A titled card section. */
function Card({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="rounded-[18px] border border-[var(--line-2)] bg-[var(--card-2)] px-[18px] py-4">
			<div className="mb-3 text-[11px] font-bold uppercase tracking-[0.09em] text-[var(--txt3)]">
				{title}
			</div>
			{children}
		</section>
	);
}

/** The "← Back to jobs" link shown above every state. */
function BackLink() {
	return (
		<Link
			to="/jobs"
			data-testid="job-detail-back"
			className="mb-5 inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--txt2)] transition-colors hover:text-[var(--txt)]"
		>
			<ArrowLeft className="size-[15px]" />
			Back to jobs
		</Link>
	);
}

/** A single labelled fact (location, work mode, salary, posted). */
function Fact({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex flex-col gap-0.5">
			<span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--txt3)]">
				{label}
			</span>
			<span className="text-[14px] text-[var(--txt)]">{value}</span>
		</div>
	);
}

function DetailBody({
	job,
	boardName,
}: {
	job: JobDetail;
	boardName: BoardName;
}) {
	const badge = jobStatusBadge(job.status);
	const score = matchScoreLabel(job.match_score);
	const workMode = workModeLabel(job.posting.work_mode);
	return (
		<div data-testid="job-detail" className="flex flex-col gap-3.5">
			{/* Heading: title, company, board + status + score pills */}
			<header>
				<h1 className="font-heading text-[clamp(22px,2.8vw,32px)] font-bold leading-[1.15] tracking-[-0.02em]">
					{job.posting.title}
				</h1>
				<p className="mt-2 flex items-center gap-1.5 text-[14px] text-[var(--txt2)]">
					<Building2 className="size-[15px] shrink-0 text-[var(--txt3)]" />
					{job.company?.name ?? "Company being researched"}
				</p>
				<div className="mt-3 flex flex-wrap items-center gap-1.5">
					<Pill className={BADGE_TONE[badge.tone]}>{badge.label}</Pill>
					<Pill className="border-[var(--line)] bg-white/[0.04] text-[var(--txt3)]">
						{boardName(job.posting.board_slug)}
					</Pill>
					{score ? (
						<Pill className="border-[var(--line)] bg-white/[0.04] text-[var(--txt2)]">
							{score}
						</Pill>
					) : null}
				</div>
			</header>

			{/* Why Archer matched this role */}
			{job.triage_reason ? (
				<Card title="Why this matched">
					<div
						data-testid="job-detail-why"
						className="flex items-start gap-2.5"
					>
						<Sparkles className="mt-0.5 size-[16px] shrink-0 text-[var(--accent)]" />
						<p className="text-[14px] leading-[1.55] text-[var(--txt)]">
							{job.triage_reason}
						</p>
					</div>
				</Card>
			) : null}

			{/* The posting */}
			<Card title="The role">
				<div className="mb-4 grid grid-cols-2 gap-x-4 gap-y-3.5 sm:grid-cols-3">
					{job.posting.location ? (
						<Fact label="Location" value={job.posting.location} />
					) : null}
					{workMode ? <Fact label="Work mode" value={workMode} /> : null}
					{job.posting.salary_raw ? (
						<Fact label="Salary" value={job.posting.salary_raw} />
					) : null}
					{job.posting.posted_on ? (
						<Fact label="Posted" value={job.posting.posted_on} />
					) : null}
				</div>
				{job.posting.description ? (
					<p className="whitespace-pre-line text-[14px] leading-[1.6] text-[var(--txt2)]">
						{job.posting.description}
					</p>
				) : (
					<p className="text-[13px] text-[var(--txt3)]">
						No description captured for this posting.
					</p>
				)}
				<a
					href={job.posting.url}
					target="_blank"
					rel="noopener noreferrer"
					className="mt-4 inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--accent)] hover:underline"
				>
					View original posting
					<ExternalLink className="size-[14px]" />
				</a>
			</Card>

			{/* Company summary (when one is attached) */}
			{job.company ? (
				<Card title="Company">
					<p className="text-[15px] font-semibold text-[var(--txt)]">
						{job.company.name}
					</p>
					{job.company.description ? (
						<p className="mt-1.5 text-[14px] leading-[1.6] text-[var(--txt2)]">
							{job.company.description}
						</p>
					) : null}
					<div className="mt-3 flex flex-col gap-1.5">
						{job.company.website_url ? (
							<a
								href={job.company.website_url}
								target="_blank"
								rel="noopener noreferrer"
								className="inline-flex w-fit items-center gap-1.5 text-[13px] font-semibold text-[var(--accent)] hover:underline"
							>
								{job.company.website_url}
								<ExternalLink className="size-[13px]" />
							</a>
						) : null}
						{job.company.recruitment_email ? (
							<span className="text-[13px] text-[var(--txt2)]">
								{job.company.recruitment_email}
							</span>
						) : null}
					</div>
				</Card>
			) : null}

			{/* External application form (when one exists) */}
			{job.external_form ? (
				<Card title="Application form">
					<div
						data-testid="job-detail-external-form"
						className="flex items-center gap-2.5"
					>
						<MapPin className="size-[15px] shrink-0 text-[var(--txt3)]" />
						<span className="text-[14px] text-[var(--txt2)]">
							External form — {job.external_form.status.replace(/_/g, " ")}
						</span>
					</div>
				</Card>
			) : null}
		</div>
	);
}

export function JobDetailView({
	detail,
	boardName,
}: {
	detail: QueryView<JobDetail>;
	boardName: BoardName;
}) {
	return (
		<div className="a-fadeup mx-auto max-w-[680px]">
			<BackLink />
			{detail.isPending ? (
				<p className="text-[13px] text-[var(--txt3)]">Loading this job…</p>
			) : detail.isError || !detail.data ? (
				<p
					data-testid="job-detail-error"
					className="text-[13px] text-[var(--txt3)]"
				>
					Couldn't load this job — it may have moved on, or something went wrong
					reaching Archer.
				</p>
			) : (
				<DetailBody job={detail.data} boardName={boardName} />
			)}
		</div>
	);
}
