import { Building2, ExternalLink, SendHorizonal } from "lucide-react";
import { InlineErrorState } from "#/components/ui/error-state.tsx";
import {
	type ApplicationBadge,
	type ApplicationListItem,
	applicationBadge,
	coverLetterSentLabel,
} from "#/lib/applications.ts";
import { versionDate } from "#/lib/profile-overview.ts";

/**
 * The applications list (ARC-166) — the candidacies in the apply lifecycle: the
 * one awaiting the owner's apply-confirm, those Archer is applying for, the
 * applied, the external forms still to complete, and any failures. Read-only: it
 * shows what was sent and when. Presentational — the route owns the query; this
 * renders calm loading / empty / error states. The empty state is the launch
 * default: until a cover letter is approved there's nothing here yet.
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
const BADGE_TONE: Record<ApplicationBadge["tone"], string> = {
	confirm: "border-brand/28 bg-brand/[0.08] text-[var(--accent)]",
	active: "border-[var(--line)] bg-white/[0.04] text-[var(--txt2)]",
	done: "border-[var(--line)] bg-white/[0.04] text-[var(--txt3)]",
	failed: "border-red-500/30 bg-red-500/[0.08] text-red-400",
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

/** One application card — read-only; shows its state, what was sent, and when. */
function ApplicationCard({
	item,
	boardName,
}: {
	item: ApplicationListItem;
	boardName: BoardName;
}) {
	const badge = applicationBadge(item);
	const sent = coverLetterSentLabel(item);
	return (
		<li
			data-testid="applications-item"
			className="flex items-start gap-3 rounded-xl border border-[var(--line-2)] bg-[var(--card)] px-4 py-3.5"
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
				<div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--txt3)]">
					{sent ? <span>{sent}</span> : null}
					<span>Updated {versionDate(item.status_changed_at)}</span>
					{item.external_form_url ? (
						<a
							href={item.external_form_url}
							target="_blank"
							rel="noreferrer"
							className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline"
						>
							<ExternalLink className="size-[12px]" />
							Open application form
						</a>
					) : null}
				</div>
			</div>
		</li>
	);
}

export function ApplicationsList({
	items,
	boardName,
}: {
	items: QueryView<ApplicationListItem[]>;
	boardName: BoardName;
}) {
	const rows = items.data ?? [];
	return (
		<div data-testid="applications-page" className="a-fadeup">
			<header className="mb-6">
				<h1 className="font-heading text-[clamp(22px,2.6vw,30px)] font-bold tracking-[-0.02em]">
					Applications
				</h1>
				<p className="mt-1.5 text-[14px] text-[var(--txt2)]">
					What Archer has applied for on your behalf — what it sent, and where
					each one stands.
				</p>
			</header>

			{items.isPending ? (
				<Note>Loading your applications…</Note>
			) : items.isError ? (
				<InlineErrorState
					testId="applications-error"
					message="Couldn't load your applications just now."
					onRetry={() => items.refetch?.()}
				/>
			) : rows.length === 0 ? (
				<div
					data-testid="applications-empty"
					className="flex flex-col items-center gap-3 rounded-[18px] border border-[var(--line-2)] bg-[var(--card-2)] px-6 py-12 text-center"
				>
					<SendHorizonal className="size-7 text-[var(--txt3)]" />
					<p className="text-[15px] font-semibold text-[var(--txt)]">
						No applications yet
					</p>
					<p className="max-w-[380px] text-[13px] text-[var(--txt3)]">
						Once you approve a cover letter and confirm the apply, Archer sends
						the application and tracks it here. Nothing for you to do in the
						meantime.
					</p>
				</div>
			) : (
				<ul data-testid="applications-feed" className="flex flex-col gap-2.5">
					{rows.map((item) => (
						<ApplicationCard key={item.id} item={item} boardName={boardName} />
					))}
				</ul>
			)}
		</div>
	);
}
