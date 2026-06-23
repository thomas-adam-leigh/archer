import { createFileRoute, Outlet } from "@tanstack/react-router";
import { ErrorState } from "#/components/ui/error-state.tsx";
import { useAuthRedirect } from "#/lib/auth-guard.ts";
import type { ResumeState } from "#/lib/onboarding-guard.ts";

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

/** Recoverable error shown when the resume-at-step progress read fails. */
export function OnboardingError({ onRetry }: { onRetry: () => void }) {
	return (
		<ErrorState
			testId="onboarding-error"
			title="I couldn't pick up where you left off."
			message="Something went wrong reaching Archer. Please try again."
			onRetry={onRetry}
		/>
	);
}

/**
 * The shared fallback for an onboarding route's resume gate: the recoverable
 * error (with retry) when progress fails to load, else the neutral pending
 * state while it resolves. A route renders this whenever its resume gate isn't
 * `ready`, so loading + error + retry stay consistent across every stage.
 */
export function OnboardingGate({ resume }: { resume: ResumeState }) {
	if (resume.status === "error") {
		return <OnboardingError onRetry={resume.retry} />;
	}
	return <OnboardingPending />;
}
