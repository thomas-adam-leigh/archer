import { createFileRoute } from "@tanstack/react-router";
import { OnboardingStagePlaceholder } from "#/components/onboarding-stage-placeholder.tsx";
import { progressSegmentForRoute } from "#/lib/onboarding-flow.ts";
import { useOnboardingResume } from "#/lib/onboarding-guard.ts";
import { OnboardingPending } from "./route.tsx";

export const Route = createFileRoute("/onboarding/review")({
	component: ReviewRoute,
	staticData: { onboardingStep: progressSegmentForRoute("review") },
});

/** The "Here's you, as I understand you" profile review (M6: ARC-107/108). */
function ReviewRoute() {
	const { status } = useOnboardingResume("review");
	if (status !== "ready") return <OnboardingPending />;
	return (
		<OnboardingStagePlaceholder
			stage="review"
			title="Here's you, as I understand you"
			issue="M6 (ARC-107/108)"
		/>
	);
}
