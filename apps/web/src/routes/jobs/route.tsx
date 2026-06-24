import { createFileRoute, Outlet } from "@tanstack/react-router";
import { DashboardShell } from "#/components/dashboard-shell.tsx";
import { useAuthRedirect } from "#/lib/auth-guard.ts";
import { useSignOut } from "#/lib/hooks.ts";

export const Route = createFileRoute("/jobs")({
	component: JobsLayout,
	// `dashboard` swaps the onboarding chrome for the dashboard sidebar shell (the
	// same shell the home route uses) — set on the layout so the list + detail both
	// render inside it.
	staticData: { dashboard: true },
});

/**
 * The `/jobs/*` group — the post-onboarding jobs cockpit (ARC-149). Gated behind a
 * session like the onboarding group: signed-out visitors are sent to `/auth` and
 * nothing renders until hydration settles. The layout owns the shared dashboard
 * shell (sidebar + header + sign-out) so the list and detail routes are just their
 * content.
 */
function JobsLayout() {
	const { ready } = useAuthRedirect("protected");
	const signOut = useSignOut();
	if (!ready) return <JobsPending />;
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
function JobsPending() {
	return (
		<div
			className="flex min-h-[70vh] items-center justify-center"
			aria-busy="true"
		>
			<span className="text-sm text-muted-foreground">Loading…</span>
		</div>
	);
}
