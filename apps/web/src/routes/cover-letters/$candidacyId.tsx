import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import {
	CoverLetterReviewView,
	type ReviewBusy,
} from "#/components/cover-letter-review.tsx";
import { CoverLetterRevising } from "#/components/cover-letter-revising.tsx";
import {
	queryKeys,
	useApproveCoverLetter,
	useCoverLetterReview,
	useReviseCoverLetter,
} from "#/lib/hooks.ts";
import { useSession } from "#/lib/session.ts";

export const Route = createFileRoute("/cover-letters/$candidacyId")({
	component: CoverLetterReviewRoute,
});

/** A last-resort backstop: a rework whose fresh draft hasn't landed yet settles into
 *  a calm "feedback sent, a new draft is coming" notice rather than spinning forever.
 *  Archer's rework runs on the daily pipeline, so a fresh proposal may only land on
 *  the next run — the poll keeps watching, and re-presents it whenever it arrives. */
const REWORK_SETTLE_MS = 12_000;
/** How long the "updated to vN" cue lingers after a reworked draft re-presents. */
const LANDED_BADGE_MS = 4000;

/**
 * The cover-letter review (ARC-150) — the one human gate before Archer applies.
 * Reusing the onboarding review→revise→approve pattern (ARC-129): present the
 * proposed letter with its version history + spoken-note playback, then either
 * **approve** (self-decide the open proposal → the candidacy advances toward apply)
 * or send **feedback** (reject with the note → the candidacy returns to drafting so
 * Archer reworks it). After feedback the "Archer is reworking your letter" overlay
 * shows while the cockpit polls for the reworked draft's fresh proposal; when one
 * lands the new letter re-presents with a visible version bump. Completion keys on a
 * real new proposal (the same fallback the profile review uses), never a timer.
 */
function CoverLetterReviewRoute() {
	const { candidacyId } = Route.useParams();
	const session = useSession();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const approve = useApproveCoverLetter();
	const revise = useReviseCoverLetter();

	const [action, setAction] = useState<ReviewBusy>(null);
	const [error, setError] = useState<string | null>(null);
	// The proposal id we just rejected: non-null while a rework is awaited, so the
	// review read polls and a fresh (different, non-null) open proposal reads as done.
	const [revisingFrom, setRevisingFrom] = useState<string | null>(null);
	// A calm terminal note shown when feedback was sent but the fresh draft hasn't
	// landed within the settle window (the rework runs on the daily pipeline).
	const [feedbackSent, setFeedbackSent] = useState(false);
	// Briefly true right after a reworked draft re-presents, driving the "updated" cue.
	const [landed, setLanded] = useState(false);

	const review = useCoverLetterReview(candidacyId, {
		poll: revisingFrom !== null,
	});

	const reviewKey = session
		? queryKeys.coverLetterReview(session.user.id, candidacyId)
		: (["cover-letters", "review", "anonymous", candidacyId] as const);

	// A reworked draft landed: a fresh (non-null, different) open proposal appeared.
	// Pull it in, leave the reworking overlay, and flag the "updated" cue.
	useEffect(() => {
		if (!revisingFrom || !review.data) return;
		const open = review.data.openProposalId;
		if (open && open !== revisingFrom) {
			setRevisingFrom(null);
			setAction(null);
			setError(null);
			setFeedbackSent(false);
			setLanded(true);
		}
	}, [revisingFrom, review.data]);

	// Backstop: a rework whose fresh draft hasn't landed within the window settles
	// into a calm "feedback sent" notice (the poll keeps watching in the background).
	useEffect(() => {
		if (!revisingFrom) return;
		const id = setTimeout(() => {
			setAction(null);
			setFeedbackSent(true);
		}, REWORK_SETTLE_MS);
		return () => clearTimeout(id);
	}, [revisingFrom]);

	// The "updated" cue is transient — fade it out after a beat.
	useEffect(() => {
		if (!landed) return;
		const id = setTimeout(() => setLanded(false), LANDED_BADGE_MS);
		return () => clearTimeout(id);
	}, [landed]);

	const onApprove = useCallback(() => {
		const proposalId = review.data?.openProposalId;
		if (!proposalId || action !== null) return;
		setError(null);
		setAction("approving");
		approve.mutate(
			{ proposalId },
			{
				onSuccess: () => {
					if (session) {
						queryClient.invalidateQueries({
							queryKey: queryKeys.coverLetters(session.user.id),
						});
					}
					navigate({ to: "/cover-letters" });
				},
				onError: () => {
					setError("Couldn't approve your letter. Please try again.");
					setAction(null);
				},
			},
		);
	}, [
		review.data?.openProposalId,
		action,
		approve,
		session,
		queryClient,
		navigate,
	]);

	const onSubmitFeedback = useCallback(
		(text: string) => {
			const proposalId = review.data?.openProposalId;
			if (!proposalId || action !== null) return;
			setError(null);
			setLanded(false);
			setFeedbackSent(false);
			setAction("revising");
			revise.mutate(
				{ proposalId, feedback: text },
				{
					// Rejected with the feedback captured; the candidacy is back in drafting.
					// Start polling for the reworked draft's fresh proposal.
					onSuccess: () => {
						queryClient.invalidateQueries({ queryKey: reviewKey });
						setRevisingFrom(proposalId);
					},
					onError: () => {
						setError(
							"Couldn't send your feedback to Archer. Please try again.",
						);
						setAction(null);
					},
				},
			);
		},
		[review.data?.openProposalId, action, revise, queryClient, reviewKey],
	);

	return (
		<CoverLetterReviewView
			review={review}
			busy={action}
			error={error}
			landed={landed}
			feedbackSent={feedbackSent}
			onApprove={onApprove}
			onSubmitFeedback={onSubmitFeedback}
			overlay={
				revisingFrom !== null && !feedbackSent ? <CoverLetterRevising /> : null
			}
		/>
	);
}
