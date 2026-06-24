import { Link } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Check, Loader2, Sparkles } from "lucide-react";
import { type ReactNode, useState } from "react";
import { InlineErrorState } from "#/components/ui/error-state.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import type {
	CoverLetterReview,
	CoverLetterVersionStatus,
	SpokenNote,
} from "#/lib/cover-letters.ts";

/**
 * The cover-letter review view (ARC-150) — present the proposed letter with its
 * version history and spoken-note (TTS) playback, then approve it or send feedback
 * for a rework. Reuses the onboarding profile-review pattern (ARC-129): the route
 * owns the reads/writes + busy/error state and the live "reworking" overlay; this is
 * presentational, rendering calm loading / empty / error states around the letter.
 */

/** Which action, if any, is currently in flight. */
export type ReviewBusy = "approving" | "revising" | null;

/** A read the view renders, narrowed from a TanStack Query result. */
interface QueryView<T> {
	data?: T;
	isPending: boolean;
	isError: boolean;
	refetch?: () => void;
}

/** How a version's status reads as a small label on the history rail. */
const VERSION_STATUS_LABEL: Record<CoverLetterVersionStatus, string> = {
	draft: "Draft",
	proposed: "In review",
	approved: "Approved",
	rejected: "Reworked",
	superseded: "Replaced",
};

/** The "← Back to cover letters" link shown above every state. */
function BackLink() {
	return (
		<Link
			to="/cover-letters"
			data-testid="cover-letter-back"
			className="mb-5 inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--txt2)] transition-colors hover:text-[var(--txt)]"
		>
			<ArrowLeft className="size-[15px]" />
			Back to cover letters
		</Link>
	);
}

/** A titled card section. */
function Card({
	title,
	children,
	testId,
}: {
	title: string;
	children: ReactNode;
	testId?: string;
}) {
	return (
		<section
			data-testid={testId}
			className="rounded-[18px] border border-[var(--line-2)] bg-[var(--card-2)] px-[18px] py-4"
		>
			<div className="mb-3 text-[11px] font-bold uppercase tracking-[0.09em] text-[var(--txt3)]">
				{title}
			</div>
			{children}
		</section>
	);
}

/** Archer's spoken note for the letter — an inline audio player. */
function SpokenNotePlayer({ note }: { note: SpokenNote }) {
	return (
		<Card title="Archer's spoken note">
			{/* biome-ignore lint/a11y/useMediaCaption: a synthesized TTS note has no caption track. */}
			<audio
				data-testid="cover-letter-spoken-note"
				controls
				src={note.audioUrl}
				className="w-full"
			>
				Your browser can't play this note.
			</audio>
		</Card>
	);
}

/** The version-history rail — every version, newest first, with its status + date. */
function History({ review }: { review: CoverLetterReview }) {
	return (
		<Card title="Version history" testId="cover-letter-history">
			<ul className="flex flex-col gap-2">
				{review.versions.map((v) => {
					const isCurrent = v.id === review.current?.id;
					return (
						<li
							key={v.id}
							className="flex items-center justify-between gap-3 text-[13px]"
						>
							<span
								className={
									isCurrent
										? "font-semibold text-[var(--txt)]"
										: "text-[var(--txt2)]"
								}
							>
								v{v.version_no}
								{v.label ? ` · ${v.label}` : ""}
							</span>
							<span className="shrink-0 text-[12px] text-[var(--txt3)]">
								{VERSION_STATUS_LABEL[v.status]}
							</span>
						</li>
					);
				})}
			</ul>
		</Card>
	);
}

/** The two ways out of a review: send feedback for a rework, or approve the letter. */
function ActionsDock({
	busy,
	error,
	onApprove,
	onSubmitFeedback,
}: {
	busy: ReviewBusy;
	error: string | null;
	onApprove: () => void;
	onSubmitFeedback: (text: string) => void;
}) {
	const [feedback, setFeedback] = useState("");
	const trimmed = feedback.trim();
	const working = busy !== null;

	function submit(e: React.FormEvent) {
		e.preventDefault();
		if (trimmed === "" || working) return;
		onSubmitFeedback(trimmed);
		setFeedback("");
	}

	return (
		<div
			data-testid="cover-letter-actions"
			className="mt-7 flex flex-col gap-4"
		>
			<form onSubmit={submit} className="flex flex-col gap-3">
				<Textarea
					data-testid="cover-letter-feedback-input"
					value={feedback}
					onChange={(e) => setFeedback(e.target.value)}
					disabled={working}
					placeholder="If anything's off, tell me — e.g. make it warmer, mention my fintech experience, shorten the opening."
					className="min-h-[88px] resize-none rounded-2xl border-[var(--line)] bg-[var(--card-2)] px-4 py-3.5 text-base"
				/>
				<div className="flex flex-wrap items-center justify-end gap-3">
					<button
						type="submit"
						data-testid="cover-letter-send"
						disabled={trimmed === "" || working}
						className="flex items-center gap-1.5 rounded-xl border border-brand/35 bg-[var(--card)] px-5 py-2.5 text-sm font-bold text-[var(--accent-2)] transition-colors hover:border-brand/55 disabled:cursor-not-allowed disabled:opacity-50"
					>
						{busy === "revising" ? (
							<Loader2 className="size-4 animate-spin" />
						) : null}
						Send to Archer
						<ArrowRight className="size-4" />
					</button>
					<button
						type="button"
						data-testid="cover-letter-approve"
						onClick={onApprove}
						disabled={working}
						className="flex items-center gap-2 rounded-xl bg-[linear-gradient(135deg,var(--accent-2),var(--accent))] px-6 py-3 text-[15px] font-bold text-[#160a02] shadow-[0_10px_28px_var(--glow)] transition-transform hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
					>
						{busy === "approving" ? (
							<Loader2 className="size-[18px] animate-spin" />
						) : (
							<Check className="size-[18px]" strokeWidth={2.4} />
						)}
						Approve &amp; send
					</button>
				</div>
			</form>
			{error ? (
				<p
					data-testid="cover-letter-error"
					className="text-right text-xs text-[#f0936c]"
					role="alert"
				>
					{error}
				</p>
			) : null}
		</div>
	);
}

/** A muted single-line note (read-only states under the letter). */
function FootNote({ children, testId }: { children: string; testId?: string }) {
	return (
		<p
			data-testid={testId}
			className="mt-7 rounded-2xl border border-[var(--line-2)] bg-[var(--card-2)] px-4 py-3.5 text-center text-[13px] text-[var(--txt2)]"
		>
			{children}
		</p>
	);
}

/** The read-only footer when there's no open proposal to decide. */
function ReadOnlyNote({ status }: { status: CoverLetterVersionStatus }) {
	if (status === "approved") {
		return (
			<FootNote testId="cover-letter-approved-note">
				This letter is approved — it's on its way out with your application.
			</FootNote>
		);
	}
	return (
		<FootNote testId="cover-letter-drafting-note">
			Archer is working on this letter — a draft will be here for your review
			shortly.
		</FootNote>
	);
}

function ReviewBody({
	review,
	busy,
	error,
	landed,
	feedbackSent,
	onApprove,
	onSubmitFeedback,
	overlay,
}: {
	review: CoverLetterReview;
	busy: ReviewBusy;
	error: string | null;
	landed: boolean;
	feedbackSent: boolean;
	onApprove: () => void;
	onSubmitFeedback: (text: string) => void;
	overlay: ReactNode;
}) {
	const current = review.current;
	if (!current) {
		return (
			<p
				data-testid="cover-letter-empty"
				className="text-[13px] text-[var(--txt3)]"
			>
				No cover letter has been drafted for this job yet.
			</p>
		);
	}
	const canDecide = Boolean(review.openProposalId);
	const reworking = overlay !== null;

	return (
		<div data-testid="cover-letter-review">
			<div className="relative">
				{landed ? (
					<output
						data-testid="cover-letter-landed"
						className="a-fadeup absolute -top-2 right-0 z-20 inline-flex items-center gap-1.5 rounded-full border border-brand/45 bg-[var(--card)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-2)] shadow-[0_8px_24px_var(--glow)]"
					>
						<Sparkles className="size-3.5" />
						Updated to v{current.version_no}
					</output>
				) : null}
				{/* Key the letter by version id so a reworked draft re-mounts and animates
				    in — the version bump makes "new version" felt. */}
				<div key={current.id} className="a-fadeup flex flex-col gap-3.5">
					<Card title="Cover letter" testId="cover-letter-content">
						<p className="whitespace-pre-line text-[14px] leading-[1.7] text-[var(--txt)]">
							{current.content}
						</p>
					</Card>
					{current.spokenNote ? (
						<SpokenNotePlayer note={current.spokenNote} />
					) : null}
					<History review={review} />
				</div>
				{overlay}
			</div>

			{reworking ? null : feedbackSent ? (
				<FootNote testId="cover-letter-feedback-sent">
					Feedback sent — Archer will rework this letter and bring you a new
					draft to review. You can leave this page; it'll be waiting here.
				</FootNote>
			) : canDecide ? (
				<ActionsDock
					busy={busy}
					error={error}
					onApprove={onApprove}
					onSubmitFeedback={onSubmitFeedback}
				/>
			) : (
				<ReadOnlyNote status={current.status} />
			)}
		</div>
	);
}

export function CoverLetterReviewView({
	review,
	busy,
	error,
	landed,
	feedbackSent,
	onApprove,
	onSubmitFeedback,
	overlay,
}: {
	review: QueryView<CoverLetterReview>;
	busy: ReviewBusy;
	error: string | null;
	landed: boolean;
	feedbackSent: boolean;
	onApprove: () => void;
	onSubmitFeedback: (text: string) => void;
	overlay: ReactNode;
}) {
	return (
		<div className="a-fadeup mx-auto max-w-[680px]">
			<BackLink />
			{review.isPending ? (
				<p className="text-[13px] text-[var(--txt3)]">Loading this letter…</p>
			) : review.isError || !review.data ? (
				<InlineErrorState
					testId="cover-letter-error-state"
					message="Couldn't load this cover letter — it may have moved on, or something went wrong reaching Archer."
					onRetry={() => review.refetch?.()}
				/>
			) : (
				<ReviewBody
					review={review.data}
					busy={busy}
					error={error}
					landed={landed}
					feedbackSent={feedbackSent}
					onApprove={onApprove}
					onSubmitFeedback={onSubmitFeedback}
					overlay={overlay}
				/>
			)}
		</div>
	);
}
