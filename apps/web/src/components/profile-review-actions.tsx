import { ArrowRight, Check, Loader2 } from "lucide-react";
import { useState } from "react";
import { Textarea } from "#/components/ui/textarea.tsx";

/** Which action, if any, is currently in flight. */
export type ReviewBusy = "approving" | "revising" | null;

/**
 * The profile-review action dock (ARC-108) — the two ways out of "Here's you, as
 * I understand you.": send free-text feedback that re-runs the draft, or approve
 * it and move on. Presentational: the feedback text is local, but approve/revise
 * and their busy + error state are owned by the route so the network seams stay
 * in one place. Mirrors the mobile review screen's decision loop.
 */
export function ProfileReviewActions({
	canApprove,
	busy,
	error,
	onApprove,
	onSubmitFeedback,
}: {
	/** Whether an open proposal has resolved (approve is disabled until it has). */
	canApprove: boolean;
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
			data-testid="profile-review-actions"
			className="mx-auto mt-7 flex max-w-[880px] flex-col gap-4"
		>
			<form onSubmit={submit} className="flex flex-col gap-3">
				<Textarea
					data-testid="profile-feedback-input"
					value={feedback}
					onChange={(e) => setFeedback(e.target.value)}
					disabled={working}
					placeholder="If anything's off or missing, tell me — e.g. add my 2023 promotion, drop the summary."
					className="min-h-[88px] resize-none rounded-2xl border-[var(--line)] bg-[var(--card-2)] px-4 py-3.5 text-base"
				/>
				<div className="flex flex-wrap items-center justify-end gap-3">
					<button
						type="submit"
						data-testid="profile-feedback-submit"
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
						data-testid="profile-approve"
						onClick={onApprove}
						disabled={!canApprove || working}
						className="flex items-center gap-2 rounded-xl bg-[linear-gradient(135deg,var(--accent-2),var(--accent))] px-6 py-3 text-[15px] font-bold text-[#160a02] shadow-[0_10px_28px_var(--glow)] transition-transform hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
					>
						{busy === "approving" ? (
							<Loader2 className="size-[18px] animate-spin" />
						) : (
							<Check className="size-[18px]" strokeWidth={2.4} />
						)}
						Looks right
					</button>
				</div>
			</form>
			{error ? (
				<p
					data-testid="profile-review-error"
					className="text-right text-xs text-[#f0936c]"
				>
					{error}
				</p>
			) : null}
		</div>
	);
}
