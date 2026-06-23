import { createFileRoute } from "@tanstack/react-router";
import { OnboardingStagePlaceholder } from "#/components/onboarding-stage-placeholder.tsx";
import { progressSegmentForRoute } from "#/lib/onboarding-flow.ts";
import { useOnboardingResume } from "#/lib/onboarding-guard.ts";
import { OnboardingPending } from "./route.tsx";

export const Route = createFileRoute("/onboarding/conversation")({
	component: ConversationRoute,
	staticData: { onboardingStep: progressSegmentForRoute("conversation") },
});

/** The start-from-scratch scripted voice Q&A path (M5: ARC-104/105/119). */
function ConversationRoute() {
	const { status } = useOnboardingResume("conversation");
	if (status !== "ready") return <OnboardingPending />;
	return (
		<OnboardingStagePlaceholder
			stage="conversation"
			title="Let's talk it through"
			issue="M5 (ARC-104/105/119)"
		/>
	);
}
