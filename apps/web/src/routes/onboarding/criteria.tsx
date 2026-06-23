import { createFileRoute } from "@tanstack/react-router";
import { OnboardingStagePlaceholder } from "#/components/onboarding-stage-placeholder.tsx";
import { progressSegmentForRoute } from "#/lib/onboarding-flow.ts";
import { useOnboardingResume } from "#/lib/onboarding-guard.ts";
import { OnboardingPending } from "./route.tsx";

export const Route = createFileRoute("/onboarding/criteria")({
	component: CriteriaRoute,
	staticData: { onboardingStep: progressSegmentForRoute("criteria") },
});

/** Negative-criteria capture + hunt setup → "Send to Archer" (M7: ARC-110/111). */
function CriteriaRoute() {
	const { status } = useOnboardingResume("criteria");
	if (status !== "ready") return <OnboardingPending />;
	return (
		<OnboardingStagePlaceholder
			stage="criteria"
			title="Here's what I'll hunt for"
			issue="M7 (ARC-110/111)"
		/>
	);
}
