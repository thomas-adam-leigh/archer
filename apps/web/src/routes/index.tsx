import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Button } from "#/components/ui/button.tsx";
import { useAuthRedirect } from "#/lib/auth-guard.ts";
import { useOnboardingProgress } from "#/lib/hooks.ts";
import { routePath } from "#/lib/onboarding-flow.ts";

export const Route = createFileRoute("/")({
	component: Home,
	// The welcome screen sits at the start of the flow (segment 1); "Get started"
	// hands off to /onboarding, which resumes the candidate at their live step.
	staticData: { onboardingStep: 1 },
});

function Home() {
	// The onboarding root is gated: signed-out visitors are sent to /auth, and
	// nothing guarded renders until hydration settles. "Get started" enters the
	// onboarding router (/onboarding), which reads /onboarding/progress and lands
	// the candidate on their exact stage (ARC-99).
	const navigate = useNavigate();
	const { ready } = useAuthRedirect("protected");
	// A candidate who has finished onboarding is "directed out of onboarding"
	// (ARC-114): rather than the welcome / "Get started" screen, the landing route
	// forwards a completed account straight to home, so re-login and any return to
	// `/` lands on the running product. Progress only loads once signed in; while it
	// is still pending or errors (e.g. a fresh sign-up before its first poll
	// resolves) `completed` stays false and the welcome renders as before.
	const { data: progress } = useOnboardingProgress();
	const completed = ready && progress?.completed === true;

	useEffect(() => {
		if (completed) navigate({ to: routePath("home"), replace: true });
	}, [completed, navigate]);

	if (!ready || completed) return <HomePending />;

	return (
		<div className="flex min-h-[70vh] flex-col items-center justify-center text-center">
			<h1 className="max-w-2xl font-heading text-5xl font-bold leading-[1.05] text-balance">
				Never apply for a job <span className="text-brand">on your own</span>{" "}
				again.
			</h1>
			<p className="mt-6 max-w-md text-lg leading-relaxed text-muted-foreground">
				Archer reads your résumé, learns what you want, and hunts for roles so
				you don't have to.
			</p>
			<Button
				variant="brand"
				size="lg"
				className="mt-10 rounded-xl px-7"
				onClick={() => navigate({ to: "/onboarding" })}
			>
				Get started
			</Button>
		</div>
	);
}

/** Neutral placeholder shown while the session hydrates or a redirect resolves. */
function HomePending() {
	return (
		<div
			className="flex min-h-[70vh] items-center justify-center"
			aria-busy="true"
		>
			<span className="text-sm text-muted-foreground">Loading…</span>
		</div>
	);
}
