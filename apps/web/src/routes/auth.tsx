import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { AuthScreen } from "#/components/auth-screen.tsx";
import { setSession } from "#/lib/session.ts";

export const Route = createFileRoute("/auth")({ component: AuthRoute });

function AuthRoute() {
	const navigate = useNavigate();
	return (
		<AuthScreen
			onAuthed={(session) => {
				setSession(session);
				// ARC-96 makes this resume the candidate at their onboarding step
				// (GET /onboarding/progress) and adds the route guards; for now a
				// successful auth lands on home.
				navigate({ to: "/" });
			}}
		/>
	);
}
