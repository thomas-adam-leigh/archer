import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useAuthRedirect } from "#/lib/auth-guard.ts";

export const Route = createFileRoute("/onboarding")({
	component: OnboardingLayout,
});

/**
 * The `/onboarding/*` group is gated behind a session: signed-out visitors are
 * sent to `/auth` and nothing renders until hydration settles. Each child route
 * then resumes the candidate at the right stage (see `useOnboardingResume`).
 */
function OnboardingLayout() {
	const { ready } = useAuthRedirect("protected");
	if (!ready) return <OnboardingPending />;
	return <Outlet />;
}

/** Neutral placeholder while the session hydrates or a redirect resolves. */
export function OnboardingPending() {
	return (
		<div
			className="flex min-h-[70vh] items-center justify-center"
			aria-busy="true"
		>
			<span className="text-sm text-muted-foreground">Loading…</span>
		</div>
	);
}
