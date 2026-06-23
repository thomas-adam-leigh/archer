import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ProfileReview } from "#/components/profile-review.tsx";
import {
	ProfileReviewActions,
	type ReviewBusy,
} from "#/components/profile-review-actions.tsx";
import type { Session } from "#/lib/auth.ts";
import {
	queryKeys,
	useApproveDraft,
	useProposedProfileDraft,
	useReviseDraft,
} from "#/lib/hooks.ts";
import { fetchOnboardingProgress } from "#/lib/onboarding.ts";
import { progressSegmentForRoute } from "#/lib/onboarding-flow.ts";
import { useOnboardingResume } from "#/lib/onboarding-guard.ts";
import { NoProposedVersionError } from "#/lib/profile.ts";
import { toProfileReviewView } from "#/lib/profile-review.ts";
import { isRevisionReady } from "#/lib/profile-review-flow.ts";
import { useSession } from "#/lib/session.ts";
import { fetchPrimaryThreadId } from "#/lib/threads.ts";
import { OnboardingPending } from "./route.tsx";

export const Route = createFileRoute("/onboarding/review")({
	component: ReviewRoute,
	staticData: { onboardingStep: progressSegmentForRoute("review") },
});

/** How often to poll `/onboarding/progress` while a revise run reworks the draft. */
const POLL_MS = 2000;
/** How long to wait for the revised draft before surfacing a recoverable error.
 *  The web client has no Realtime run-error channel, so a revise that never lands
 *  a new proposed version is caught here rather than spinning forever. */
const MAX_WAIT_MS = 90_000;

/**
 * The "Here's you, as I understand you" profile review (M6). ARC-107 renders the
 * proposed draft résumé-style; ARC-108 adds the decision dock: send free-text
 * feedback that re-runs the draft, or approve it and advance.
 *
 * Approving self-approves the open proposal (resolved from `/onboarding/progress`)
 * — the backend then advances the step, and refreshing progress lets the resume
 * guard carry the candidate to negative criteria. Feedback resolves the user's
 * thread, kicks off a streamed revise run, then polls progress until a NEW
 * proposed version lands and re-renders the updated draft (the step stays
 * `review`, so the proposed version id flipping is the only ready signal).
 *
 * The stage is wrapped in a single `onboarding-stage-review` testid present across
 * every state, so the résumé/scratch E2Es that only assert the stage stay green.
 */
function ReviewRoute() {
	const session = useSession();
	const queryClient = useQueryClient();
	const { status, progress } = useOnboardingResume("review");
	const draft = useProposedProfileDraft();
	const approve = useApproveDraft();
	const revise = useReviseDraft();

	const [action, setAction] = useState<ReviewBusy>(null);
	const [error, setError] = useState<string | null>(null);
	// Non-null while a revise run is in flight: the proposed version id that was on
	// screen when feedback was sent, so we can detect when a fresh one supersedes it.
	const [reviseFrom, setReviseFrom] = useState<{
		version: string | null;
	} | null>(null);

	const progressKey = session
		? queryKeys.onboardingProgress(session.user.id)
		: (["onboarding", "progress", "anonymous"] as const);

	// Poll progress only while a revision is being reworked; reuses the shared key
	// so the guard's view stays fresh too.
	const pollQuery = useQuery({
		queryKey: progressKey,
		queryFn: () => fetchOnboardingProgress(session as Session),
		enabled: reviseFrom !== null && Boolean(session),
		refetchInterval: reviseFrom !== null ? POLL_MS : false,
	});

	// A fresh proposed version landed: pull in the new draft + proposal and return
	// to the résumé view.
	useEffect(() => {
		if (!reviseFrom || !pollQuery.data) return;
		if (isRevisionReady(pollQuery.data, reviseFrom.version)) {
			queryClient.invalidateQueries({ queryKey: progressKey });
			if (session) {
				queryClient.invalidateQueries({
					queryKey: queryKeys.proposedProfileDraft(session.user.id),
				});
			}
			setReviseFrom(null);
			setAction(null);
		}
	}, [reviseFrom, pollQuery.data, queryClient, progressKey, session]);

	// Cap the wait: a revise that never lands a new version falls back to a
	// recoverable error rather than spinning forever.
	useEffect(() => {
		if (!reviseFrom) return;
		const id = setTimeout(() => {
			setError("That took longer than expected. Please try again.");
			setReviseFrom(null);
			setAction(null);
		}, MAX_WAIT_MS);
		return () => clearTimeout(id);
	}, [reviseFrom]);

	const onApprove = useCallback(() => {
		const proposalId = progress?.openProposalId;
		if (!proposalId || action !== null) return;
		setError(null);
		setAction("approving");
		approve.mutate(
			{ proposalId },
			{
				// The backend advanced the onboarding step; refreshing progress lets the
				// resume guard move the candidate on to negative criteria. Stay busy —
				// the route unmounts as the redirect resolves.
				onSuccess: () =>
					queryClient.invalidateQueries({ queryKey: progressKey }),
				onError: () => {
					setError("Couldn't approve your profile. Please try again.");
					setAction(null);
				},
			},
		);
	}, [progress?.openProposalId, action, approve, queryClient, progressKey]);

	const onSubmitFeedback = useCallback(
		(text: string) => {
			if (action !== null || !session) return;
			setError(null);
			setAction("revising");
			const from = progress?.proposedVersionId ?? null;
			fetchPrimaryThreadId(session)
				.then((threadId) => revise.mutateAsync({ threadId, feedback: text }))
				.then(() => setReviseFrom({ version: from }))
				.catch(() => {
					setError("Couldn't send your feedback to Archer. Please try again.");
					setAction(null);
				});
		},
		[action, session, progress?.proposedVersionId, revise],
	);

	if (status !== "ready") return <OnboardingPending />;

	const reworking = reviseFrom !== null;

	return (
		<div data-testid="onboarding-stage-review">
			{draft.isPending ? (
				<ReviewState busy>
					<Loader2 className="size-5 animate-spin text-[var(--accent)]" />
					<p className="text-sm text-[var(--txt2)]">
						Pulling your profile together…
					</p>
				</ReviewState>
			) : draft.isError ? (
				draft.error instanceof NoProposedVersionError ? (
					<ReviewState>
						<h1 className="font-heading text-2xl font-bold tracking-tight">
							Nothing to review just yet.
						</h1>
						<p className="max-w-sm text-sm text-[var(--txt2)]">
							Once I've built your profile, this is where you'll check it over.
						</p>
					</ReviewState>
				) : (
					<ReviewState>
						<h1 className="font-heading text-2xl font-bold tracking-tight">
							I couldn't load your profile.
						</h1>
						<p className="max-w-sm text-sm text-[var(--txt2)]">
							Something went wrong fetching your draft. Please refresh to try
							again.
						</p>
					</ReviewState>
				)
			) : (
				<>
					<div className="relative">
						<ProfileReview view={toProfileReviewView(draft.data)} />
						{reworking ? (
							<div
								data-testid="profile-review-reworking"
								className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-[24px] bg-[rgba(8,8,9,0.82)] backdrop-blur-[6px]"
								aria-busy="true"
							>
								<Loader2 className="size-6 animate-spin text-[var(--accent)]" />
								<p className="text-sm text-[var(--txt2)]">
									Reworking your profile…
								</p>
							</div>
						) : null}
					</div>
					<ProfileReviewActions
						canApprove={Boolean(progress?.openProposalId)}
						busy={action}
						error={error}
						onApprove={onApprove}
						onSubmitFeedback={onSubmitFeedback}
					/>
				</>
			)}
		</div>
	);
}

/** A centred state container for the review screen's loading / empty / error views. */
function ReviewState({
	children,
	busy,
}: {
	children: React.ReactNode;
	busy?: boolean;
}) {
	return (
		<div
			className="mx-auto flex min-h-[70vh] max-w-xl flex-col items-center justify-center gap-3 text-center"
			aria-busy={busy}
		>
			{children}
		</div>
	);
}
