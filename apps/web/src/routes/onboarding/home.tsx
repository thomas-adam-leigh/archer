import { createFileRoute } from "@tanstack/react-router";
import { DashboardShell } from "#/components/dashboard-shell.tsx";
import { HomeDashboard } from "#/components/home-dashboard.tsx";
import {
	useNegativeCriteria,
	useSignOut,
	useSuggestedTitles,
} from "#/lib/hooks.ts";
import { nextRun } from "#/lib/next-run.ts";
import { progressSegmentForRoute } from "#/lib/onboarding-flow.ts";
import { useOnboardingResume } from "#/lib/onboarding-guard.ts";
import { OnboardingGate } from "./route.tsx";

export const Route = createFileRoute("/onboarding/home")({
	component: HomeRoute,
	// `home` returns `undefined` → the progress indicator hides post-onboarding.
	// `dashboard` swaps the onboarding chrome for the dashboard sidebar shell.
	staticData: {
		onboardingStep: progressSegmentForRoute("home"),
		dashboard: true,
	},
});

/**
 * The post-onboarding home the candidate is handed off to (M8: ARC-113). Reads
 * the onboarding outputs Archer hunts with — the approved target titles and the
 * captured rule-outs — and shows the resting dashboard with the next scheduled
 * run. "Start over" ends the session and returns to sign-in: the backend has no
 * onboarding-reset endpoint (the account only moves forward through the
 * Acceptance Gate), so re-onboarding means a fresh account; the auth guard
 * forwards the now-signed-out user to `/auth`.
 */
function HomeRoute() {
	const resume = useOnboardingResume("home");
	const titles = useSuggestedTitles();
	const criteria = useNegativeCriteria();
	const signOut = useSignOut();

	if (resume.status !== "ready") return <OnboardingGate resume={resume} />;

	return (
		<DashboardShell
			onSignOut={() => signOut.mutate()}
			signingOut={signOut.isPending}
		>
			<HomeDashboard
				nextRun={nextRun(new Date())}
				titles={titles.data ?? []}
				ruleOuts={criteria.data ?? []}
				onStartOver={() => signOut.mutate()}
				startingOver={signOut.isPending}
			/>
		</DashboardShell>
	);
}
