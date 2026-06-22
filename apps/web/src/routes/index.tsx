import { createFileRoute } from "@tanstack/react-router";
import { Button } from "#/components/ui/button.tsx";
import { useAuthRedirect } from "#/lib/auth-guard.ts";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
	// The onboarding root is gated: signed-out visitors are sent to /auth, and
	// nothing guarded renders until hydration settles. The per-stage resume
	// (reading /onboarding/progress to land on the exact step) arrives with the
	// onboarding router in ARC-99 once the stage routes exist.
	const { ready } = useAuthRedirect("protected");
	if (!ready) return <HomePending />;

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
			<Button variant="brand" size="lg" className="mt-10 rounded-xl px-7">
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
