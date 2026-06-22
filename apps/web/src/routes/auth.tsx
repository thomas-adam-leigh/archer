import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { AuthScreen } from "#/components/auth-screen.tsx";
import { useAuthRedirect } from "#/lib/auth-guard.ts";
import { setSession } from "#/lib/session.ts";

export const Route = createFileRoute("/auth")({ component: AuthRoute });

function AuthRoute() {
	const navigate = useNavigate();
	// A signed-in visitor who lands on /auth is sent back into the flow; the
	// form still renders for the common signed-out case (and during hydration).
	useAuthRedirect("guest");

	return (
		<AuthScreen
			onAuthed={(session) => {
				setSession(session);
				// Into the onboarding flow. The router resumes the candidate at the
				// right step from /onboarding/progress once stage routes exist (ARC-99).
				navigate({ to: "/", replace: true });
			}}
		/>
	);
}
