import { createFileRoute } from "@tanstack/react-router";
import { ScriptedConversation } from "#/components/scripted-conversation.tsx";
import { progressSegmentForRoute } from "#/lib/onboarding-flow.ts";
import { useOnboardingResume } from "#/lib/onboarding-guard.ts";
import { OnboardingGate } from "./route.tsx";

export const Route = createFileRoute("/onboarding/conversation")({
	component: ConversationRoute,
	staticData: { onboardingStep: progressSegmentForRoute("conversation") },
});

/**
 * The start-from-scratch path (M5): the scripted, preset onboarding sequence
 * (ARC-104). Voice capture (ARC-119) and per-answer AI extraction + the finalize
 * → profile-review hand-off (ARC-105) build on the step machine this screen drives.
 */
function ConversationRoute() {
	const resume = useOnboardingResume("conversation");
	if (resume.status !== "ready") return <OnboardingGate resume={resume} />;
	return <ScriptedConversation />;
}
