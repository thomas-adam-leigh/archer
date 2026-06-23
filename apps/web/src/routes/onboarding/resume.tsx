import { createFileRoute } from "@tanstack/react-router";
import { OnboardingStagePlaceholder } from "#/components/onboarding-stage-placeholder.tsx";
import { progressSegmentForRoute } from "#/lib/onboarding-flow.ts";
import { useOnboardingResume } from "#/lib/onboarding-guard.ts";
import { OnboardingPending } from "./route.tsx";

export const Route = createFileRoute("/onboarding/resume")({
	component: ResumeRoute,
	staticData: { onboardingStep: progressSegmentForRoute("resume") },
});

/** The résumé upload + "reading every line" processing path (M4: ARC-101/102). */
function ResumeRoute() {
	const { status } = useOnboardingResume("resume");
	if (status !== "ready") return <OnboardingPending />;
	return (
		<OnboardingStagePlaceholder
			stage="resume"
			title="Drop in your résumé"
			issue="M4 (ARC-101/102)"
		/>
	);
}
