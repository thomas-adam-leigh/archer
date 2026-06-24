import { createFileRoute, Outlet } from "@tanstack/react-router";
import { DashboardShell } from "#/components/dashboard-shell.tsx";
import { useAuthRedirect } from "#/lib/auth-guard.ts";
import { useSignOut } from "#/lib/hooks.ts";

export const Route = createFileRoute("/cover-letters")({
	component: CoverLettersLayout,
	// `dashboard` swaps the onboarding chrome for the dashboard sidebar shell (the
	// same shell home + jobs use) — set on the layout so the list + review both
	// render inside it.
	staticData: { dashboard: true },
});

/**
 * The `/cover-letters/*` group — the cover-letter review cockpit (ARC-150), the
 * daily heartbeat / one human gate before Archer applies. Gated behind a session
 * like the jobs group: signed-out visitors are sent to `/auth` and nothing renders
 * until hydration settles. The layout owns the shared dashboard shell so the list
 * and review routes are just their content.
 */
function CoverLettersLayout() {
	const { ready } = useAuthRedirect("protected");
	const signOut = useSignOut();
	if (!ready) return <CoverLettersPending />;
	return (
		<DashboardShell
			onSignOut={() => signOut.mutate()}
			signingOut={signOut.isPending}
		>
			<Outlet />
		</DashboardShell>
	);
}

/** Neutral placeholder while the session hydrates or a redirect resolves. */
function CoverLettersPending() {
	return (
		<div
			className="flex min-h-[70vh] items-center justify-center"
			aria-busy="true"
		>
			<span className="text-sm text-muted-foreground">Loading…</span>
		</div>
	);
}
