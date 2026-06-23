import { createFileRoute } from "@tanstack/react-router";
import { OnboardingStagePlaceholder } from "#/components/onboarding-stage-placeholder.tsx";
import { progressSegmentForRoute } from "#/lib/onboarding-flow.ts";
import { useOnboardingResume } from "#/lib/onboarding-guard.ts";
import { OnboardingPending } from "./route.tsx";

export const Route = createFileRoute("/onboarding/home")({
	component: HomeRoute,
	// `home` returns `undefined` → the progress indicator hides post-onboarding.
	staticData: { onboardingStep: progressSegmentForRoute("home") },
});

/** The post-onboarding home the candidate is handed off to (M8: ARC-113/114). */
function HomeRoute() {
	const { status } = useOnboardingResume("home");
	if (status !== "ready") return <OnboardingPending />;
	return (
		<OnboardingStagePlaceholder
			stage="home"
			title="You're all set"
			issue="M8 (ARC-113/114)"
		/>
	);
}
