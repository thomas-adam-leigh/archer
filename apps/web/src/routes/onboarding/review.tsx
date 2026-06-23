import { createFileRoute } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { ProfileReview } from "#/components/profile-review.tsx";
import { useProposedProfileDraft } from "#/lib/hooks.ts";
import { progressSegmentForRoute } from "#/lib/onboarding-flow.ts";
import { useOnboardingResume } from "#/lib/onboarding-guard.ts";
import { NoProposedVersionError } from "#/lib/profile.ts";
import { toProfileReviewView } from "#/lib/profile-review.ts";
import { OnboardingPending } from "./route.tsx";

export const Route = createFileRoute("/onboarding/review")({
	component: ReviewRoute,
	staticData: { onboardingStep: progressSegmentForRoute("review") },
});

/**
 * The "Here's you, as I understand you" profile review (M6). ARC-107 renders the
 * proposed draft résumé-style; the feedback + approve action dock lands in
 * ARC-108. The stage is wrapped in a single `onboarding-stage-review` testid that
 * is present across every state, so the resume/upload E2Es that only assert the
 * stage stay green regardless of the draft fetch.
 */
function ReviewRoute() {
	const { status } = useOnboardingResume("review");
	const draft = useProposedProfileDraft();

	if (status !== "ready") return <OnboardingPending />;

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
				<ProfileReview view={toProfileReviewView(draft.data)} />
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
