/**
 * The auth boundary for the onboarding flow.
 *
 * The session lives client-side (localStorage, see `session.ts`) and is restored
 * after mount, so the boundary can't run in a route `beforeLoad` — the server
 * has no session there and would bounce every signed-in user. Instead each route
 * runs {@link useAuthRedirect} on the client: once hydration has settled it
 * sends signed-out users on a protected route to `/auth`, and signed-in users on
 * the auth screen back into the flow.
 *
 * The redirect decision itself is the pure {@link resolveAuthRedirect}, kept
 * separate so it's unit-testable without a router or the DOM.
 */

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useIsHydrated, useSession } from "#/lib/session.ts";

/** A route's relationship to auth: gated behind a session, or the auth screen. */
export type RouteKind = "protected" | "guest";

/** Where the auth boundary should send the user, given the current state. */
export interface AuthState {
	/** Whether the persisted session has been consulted yet. */
	hydrated: boolean;
	/** Whether there is an active session. */
	hasSession: boolean;
	/** What kind of route is being guarded. */
	kind: RouteKind;
}

/**
 * Resolve the redirect target for the auth boundary, or `null` to stay put.
 *
 * Before hydration the session is unknown, so we never redirect (the route shows
 * a pending state). After hydration: a protected route without a session goes to
 * `/auth`; the auth screen with a session goes to `/` (into the onboarding flow,
 * where the router resumes the candidate at their step — ARC-99).
 */
export function resolveAuthRedirect(state: AuthState): "/" | "/auth" | null {
	if (!state.hydrated) return null;
	if (state.kind === "protected") return state.hasSession ? null : "/auth";
	return state.hasSession ? "/" : null;
}

/** Whether this component has mounted on the client (false during SSR + the
 *  first hydration render). */
function useMounted(): boolean {
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);
	return mounted;
}

/**
 * Run the auth boundary for a route. Returns `ready` — `true` only once it's
 * safe to render this route's own content (hydration settled and no redirect
 * pending) — so a protected route can show a neutral pending state until then
 * instead of flashing guarded content.
 *
 * The `mounted` gate keeps the first client render identical to the server's
 * (both render the pending branch): the session store is hydrated by the app
 * root, which can run before a Suspense-nested route first hydrates, so reading
 * it during that render would mismatch the server HTML. We only consult it once
 * this component has mounted.
 */
export function useAuthRedirect(kind: RouteKind): { ready: boolean } {
	const mounted = useMounted();
	const session = useSession();
	const hydrated = useIsHydrated();
	const navigate = useNavigate();

	const target =
		mounted && hydrated
			? resolveAuthRedirect({
					hydrated: true,
					hasSession: session !== null,
					kind,
				})
			: null;

	useEffect(() => {
		if (target) navigate({ to: target, replace: true });
	}, [target, navigate]);

	return { ready: mounted && hydrated && target === null };
}
