import { Link } from "@tanstack/react-router";
import { Building2, ChevronRight, FileText } from "lucide-react";
import { InlineErrorState } from "#/components/ui/error-state.tsx";
import {
	type CoverLetterBadge,
	coverLetterBadge,
} from "#/lib/cover-letters.ts";
import type { JobListItem } from "#/lib/jobs.ts";

/**
 * The cover-letters cockpit list (ARC-150) — the candidacies whose letter is the
 * candidate's to act on: `in_review` (your draft is waiting), `drafting` (Archer is
 * reworking it), and `approved` (done, on its way to apply). Each links to its
 * review. Presentational: the route owns the query; this renders calm loading /
 * empty / error states. The empty state is the launch default — at first there are
 * no letters to review.
 */

/** A read the list renders, narrowed from a TanStack Query result. */
interface QueryView<T> {
	data?: T;
	isPending: boolean;
	isError: boolean;
	refetch?: () => void;
}

/** Resolve a board's display name from its slug, falling back to the slug. */
type BoardName = (slug: string) => string;

/** A muted single-line note used for loading / error states. */
function Note({ children }: { children: string }) {
	return <p className="text-[13px] text-[var(--txt3)]">{children}</p>;
}

/** The tints a status badge maps its tone to. */
const BADGE_TONE: Record<CoverLetterBadge["tone"], string> = {
	review: "border-brand/28 bg-brand/[0.08] text-[var(--accent)]",
	drafting: "border-[var(--line)] bg-white/[0.04] text-[var(--txt2)]",
	approved: "border-[var(--line)] bg-white/[0.04] text-[var(--txt3)]",
	neutral: "border-[var(--line)] bg-white/[0.04] text-[var(--txt3)]",
};

/** A small coloured pill (status badge, board tag). */
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

/** One candidacy card in the list, linking through to its review. */
function CoverLetterCard({
	item,
	boardName,
}: {
	item: JobListItem;
	boardName: BoardName;
}) {
	const badge = coverLetterBadge(item.status);
	return (
		<li data-testid="cover-letters-item">
			<Link
				to="/cover-letters/$candidacyId"
				params={{ candidacyId: item.id }}
				className="flex items-center gap-3 rounded-xl border border-[var(--line-2)] bg-[var(--card)] px-4 py-3.5 transition-colors hover:border-brand/45 hover:bg-white/[0.03]"
			>
				<div className="flex min-w-0 flex-1 flex-col gap-1.5">
					<span className="truncate text-[15px] font-semibold text-[var(--txt)]">
						{item.posting_title}
					</span>
					<span className="flex items-center gap-1.5 text-[13px] text-[var(--txt2)]">
						<Building2 className="size-[14px] shrink-0 text-[var(--txt3)]" />
						{item.company_name ?? "Company being researched"}
					</span>
					<div className="mt-0.5 flex flex-wrap items-center gap-1.5">
						<Pill className={BADGE_TONE[badge.tone]}>{badge.label}</Pill>
						<Pill className="border-[var(--line)] bg-white/[0.04] text-[var(--txt3)]">
							{boardName(item.board_slug)}
						</Pill>
					</div>
				</div>
				<ChevronRight className="size-[18px] shrink-0 text-[var(--txt3)]" />
			</Link>
		</li>
	);
}

export function CoverLettersList({
	items,
	boardName,
}: {
	items: QueryView<JobListItem[]>;
	boardName: BoardName;
}) {
	const rows = items.data ?? [];
	return (
		<div data-testid="cover-letters-page" className="a-fadeup">
			<header className="mb-6">
				<h1 className="font-heading text-[clamp(22px,2.6vw,30px)] font-bold tracking-[-0.02em]">
					Cover letters
				</h1>
				<p className="mt-1.5 text-[14px] text-[var(--txt2)]">
					The letters Archer has drafted for you — review, give feedback, or
					approve them before they go out.
				</p>
			</header>

			{items.isPending ? (
				<Note>Loading your cover letters…</Note>
			) : items.isError ? (
				<InlineErrorState
					testId="cover-letters-error"
					message="Couldn't load your cover letters just now."
					onRetry={() => items.refetch?.()}
				/>
			) : rows.length === 0 ? (
				<div
					data-testid="cover-letters-empty"
					className="flex flex-col items-center gap-3 rounded-[18px] border border-[var(--line-2)] bg-[var(--card-2)] px-6 py-12 text-center"
				>
					<FileText className="size-7 text-[var(--txt3)]" />
					<p className="text-[15px] font-semibold text-[var(--txt)]">
						No cover letters to review yet
					</p>
					<p className="max-w-[380px] text-[13px] text-[var(--txt3)]">
						When you shortlist a role, Archer drafts a cover letter and brings
						it here for your review. Nothing for you to do in the meantime.
					</p>
				</div>
			) : (
				<ul data-testid="cover-letters-feed" className="flex flex-col gap-2.5">
					{rows.map((item) => (
						<CoverLetterCard key={item.id} item={item} boardName={boardName} />
					))}
				</ul>
			)}
		</div>
	);
}
