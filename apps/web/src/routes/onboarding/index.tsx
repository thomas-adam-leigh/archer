import { createFileRoute } from "@tanstack/react-router";
import { useOnboardingResume } from "#/lib/onboarding-guard.ts";
import { OnboardingPending } from "./route.tsx";

export const Route = createFileRoute("/onboarding/")({
	component: OnboardingResolver,
});

/**
 * The flow entry point: reads `/onboarding/progress` and forwards to the route
 * for the candidate's live step (`useOnboardingResume(null)` always redirects).
 * Renders nothing of its own — just the pending state until the redirect lands.
 */
function OnboardingResolver() {
	useOnboardingResume(null);
	return <OnboardingPending />;
}
