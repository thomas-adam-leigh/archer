import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ResumeDropzone } from "#/components/resume-dropzone.tsx";
import { progressSegmentForRoute, routePath } from "#/lib/onboarding-flow.ts";
import { useOnboardingResume } from "#/lib/onboarding-guard.ts";
import { OnboardingPending } from "./route.tsx";

export const Route = createFileRoute("/onboarding/resume")({
	component: ResumeRoute,
	staticData: { onboardingStep: progressSegmentForRoute("resume") },
});

/**
 * The résumé upload path (M4). ARC-101 lands the intake dropzone; uploading the
 * chosen file + the "reading every line" processing screen arrive in ARC-102.
 */
function ResumeRoute() {
	const navigate = useNavigate();
	const { status } = useOnboardingResume("resume");
	if (status !== "ready") return <OnboardingPending />;
	return (
		<ResumeDropzone
			onTalkInstead={() =>
				navigate({ to: routePath("conversation"), replace: true })
			}
		/>
	);
}
