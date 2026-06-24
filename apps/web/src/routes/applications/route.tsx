import { createFileRoute, Outlet } from "@tanstack/react-router";
import { DashboardShell } from "#/components/dashboard-shell.tsx";
import { useAuthRedirect } from "#/lib/auth-guard.ts";
import { useSignOut } from "#/lib/hooks.ts";

export const Route = createFileRoute("/applications")({
	component: ApplicationsLayout,
	// `dashboard` swaps the onboarding chrome for the dashboard sidebar shell (the
	// same shell home + jobs + cover-letters use).
	staticData: { dashboard: true },
});

/**
 * The `/applications/*` group — the apply-lifecycle view (ARC-166), the apply-side
 * companion to the jobs feed and cover-letters cockpit. Gated behind a session like
 * the other dashboard groups: signed-out visitors are sent to `/auth` and nothing
 * renders until hydration settles. The layout owns the shared dashboard shell so the
 * list route is just its content.
 */
function ApplicationsLayout() {
	const { ready } = useAuthRedirect("protected");
	const signOut = useSignOut();
	if (!ready) return <ApplicationsPending />;
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
function ApplicationsPending() {
	return (
		<div
			className="flex min-h-[70vh] items-center justify-center"
			aria-busy="true"
		>
			<span className="text-sm text-muted-foreground">Loading…</span>
		</div>
	);
}
