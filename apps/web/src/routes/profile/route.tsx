import { createFileRoute, Outlet } from "@tanstack/react-router";
import { DashboardShell } from "#/components/dashboard-shell.tsx";
import { useAuthRedirect } from "#/lib/auth-guard.ts";
import { useSignOut } from "#/lib/hooks.ts";

export const Route = createFileRoute("/profile")({
	component: ProfileLayout,
	// `dashboard` swaps the onboarding chrome for the dashboard sidebar shell (the
	// same shell the home + jobs + companies routes use).
	staticData: { dashboard: true },
});

/**
 * The `/profile/*` group — the post-onboarding profile route (ARC-152). Gated
 * behind a session like the other dashboard groups: signed-out visitors are sent
 * to `/auth` and nothing renders until hydration settles. The layout owns the
 * shared dashboard shell (sidebar + header + sign-out).
 */
function ProfileLayout() {
	const { ready } = useAuthRedirect("protected");
	const signOut = useSignOut();
	if (!ready) return <ProfilePending />;
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
function ProfilePending() {
	return (
		<div
			className="flex min-h-[70vh] items-center justify-center"
			aria-busy="true"
		>
			<span className="text-sm text-muted-foreground">Loading…</span>
		</div>
	);
}
