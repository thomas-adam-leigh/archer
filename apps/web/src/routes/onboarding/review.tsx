import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Loader2, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ProfileReview } from "#/components/profile-review.tsx";
import {
	ProfileReviewActions,
	type ReviewBusy,
} from "#/components/profile-review-actions.tsx";
import { ProfileRevising } from "#/components/profile-revising.tsx";
import { Button } from "#/components/ui/button.tsx";
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
import { OnboardingGate } from "./route.tsx";

export const Route = createFileRoute("/onboarding/review")({
	component: ReviewRoute,
	staticData: { onboardingStep: progressSegmentForRoute("review") },
});

/** How often to poll `/onboarding/progress` as the revise reconnect/fallback signal. */
const POLL_MS = 2000;
/** A last-resort backstop: a revise that never streams a phase nor lands a new
 *  proposed version falls back to a recoverable error rather than spinning forever.
 *  The live AG-UI stream (`run_error` / `state.phase === 'error'`) is the primary
 *  failure signal now (ARC-129); this only catches a wholly silent stall. */
const MAX_WAIT_MS = 90_000;
/** How long the "revision landed" indicator lingers before fading out. */
const REVISED_BADGE_MS = 4000;

/**
 * The "Here's you, as I understand you" profile review (M6). ARC-107 renders the
 * proposed draft résumé-style; ARC-108 adds the decision dock: send free-text
 * feedback that re-runs the draft, or approve it and advance.
 *
 * Approving self-approves the open proposal (resolved from `/onboarding/progress`)
 * — the backend then advances the step, and refreshing progress lets the resume
 * guard carry the candidate to negative criteria. Feedback resolves the user's
 * thread, kicks off a streamed revise run, and (ARC-129) shows the live "Archer is
 * reworking your draft" overlay — driven by the run's real AG-UI `state.phase`
 * (`reading → revising → complete`) via {@link ProfileRevising}. When a FRESH
 * proposed version lands the updated draft animates in (the version bump is
 * visible, plus a transient "revision landed" cue). `/onboarding/progress` is still
 * polled as a reconnect/fallback — the step stays `review`, so the proposed version
 * id flipping is the fallback ready signal if the live socket drops.
 *
 * The stage is wrapped in a single `onboarding-stage-review` testid present across
 * every state, so the résumé/scratch E2Es that only assert the stage stay green.
 */
function ReviewRoute() {
	const session = useSession();
	const queryClient = useQueryClient();
	const resume = useOnboardingResume("review");
	const { progress } = resume;
	const draft = useProposedProfileDraft();
	const approve = useApproveDraft();
	const revise = useReviseDraft();

	const [action, setAction] = useState<ReviewBusy>(null);
	const [error, setError] = useState<string | null>(null);
	// Non-null while a revise run is in flight: the run's thread plus the proposed
	// version id that was on screen when feedback was sent, so the live overlay can
	// stream that thread and detect when a fresh version supersedes the old one.
	const [reviseFrom, setReviseFrom] = useState<{
		threadId: string;
		version: string | null;
	} | null>(null);
	// Briefly true right after a fresh version lands, driving the "revision landed" cue.
	const [revisionLanded, setRevisionLanded] = useState(false);

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

	// A fresh proposed version landed (from the live stream or the poll fallback):
	// pull in the new draft + proposal, return to the résumé view, and flag the
	// "revision landed" cue so the new version animates in with a visible bump.
	const finishRevision = useCallback(() => {
		queryClient.invalidateQueries({ queryKey: progressKey });
		if (session) {
			queryClient.invalidateQueries({
				queryKey: queryKeys.proposedProfileDraft(session.user.id),
			});
		}
		setReviseFrom(null);
		setAction(null);
		setError(null);
		setRevisionLanded(true);
	}, [queryClient, progressKey, session]);

	// A terminal revise run failure surfaces a recoverable error and ends the wait.
	const onReviseError = useCallback(() => {
		setError("Couldn't rework your profile. Please try again.");
		setReviseFrom(null);
		setAction(null);
	}, []);

	// Reconnect/fallback: the progress poll lands the revision if the live socket
	// dropped before delivering the run's completion.
	useEffect(() => {
		if (!reviseFrom || !pollQuery.data) return;
		if (isRevisionReady(pollQuery.data, reviseFrom.version)) finishRevision();
	}, [reviseFrom, pollQuery.data, finishRevision]);

	// Backstop: a wholly silent revise (no phase stream, no progress update) falls
	// back to a recoverable error rather than spinning forever.
	useEffect(() => {
		if (!reviseFrom) return;
		const id = setTimeout(() => {
			setError("That took longer than expected. Please try again.");
			setReviseFrom(null);
			setAction(null);
		}, MAX_WAIT_MS);
		return () => clearTimeout(id);
	}, [reviseFrom]);

	// The "revision landed" cue is transient — fade it out after a beat.
	useEffect(() => {
		if (!revisionLanded) return;
		const id = setTimeout(() => setRevisionLanded(false), REVISED_BADGE_MS);
		return () => clearTimeout(id);
	}, [revisionLanded]);

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
			setRevisionLanded(false);
			setAction("revising");
			const from = progress?.proposedVersionId ?? null;
			fetchPrimaryThreadId(session)
				.then((threadId) =>
					revise
						.mutateAsync({ threadId, feedback: text })
						.then((started) => started.threadId),
				)
				.then((threadId) => setReviseFrom({ threadId, version: from }))
				.catch(() => {
					setError("Couldn't send your feedback to Archer. Please try again.");
					setAction(null);
				});
		},
		[action, session, progress?.proposedVersionId, revise],
	);

	if (resume.status !== "ready") return <OnboardingGate resume={resume} />;

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
						<p className="max-w-sm text-sm text-[var(--txt2)]" role="alert">
							Something went wrong fetching your draft. Please try again.
						</p>
						<Button
							type="button"
							variant="outline"
							className="mt-1"
							data-testid="review-retry"
							onClick={() => draft.refetch()}
						>
							Try again
						</Button>
					</ReviewState>
				)
			) : (
				<>
					<div className="relative">
						{revisionLanded ? (
							<output
								data-testid="profile-revision-landed"
								className="a-fadeup absolute -top-2 right-0 z-20 inline-flex items-center gap-1.5 rounded-full border border-brand/45 bg-[var(--card)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-2)] shadow-[0_8px_24px_var(--glow)]"
							>
								<Sparkles className="size-3.5" />
								Updated to v{toProfileReviewView(draft.data).versionNo ?? "—"}
							</output>
						) : null}
						{/* Key the document by version id so a landed revision re-mounts and
						    animates in — the version bump in the header makes "new version" felt. */}
						<div key={draft.data.version.id} className="a-fadeup">
							<ProfileReview view={toProfileReviewView(draft.data)} />
						</div>
						{reworking && reviseFrom ? (
							<ProfileRevising
								session={session as Session}
								threadId={reviseFrom.threadId}
								fromVersion={reviseFrom.version}
								onComplete={finishRevision}
								onError={onReviseError}
							/>
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
