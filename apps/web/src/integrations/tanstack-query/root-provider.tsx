import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiError } from "#/lib/api.ts";
import { clearSession } from "#/lib/session.ts";

/** A 401 means the bearer token is expired/invalid — re-auth is required. */
function isUnauthorized(error: unknown): boolean {
	return error instanceof ApiError && error.status === 401;
}

/**
 * Drop the session on a 401 from any read or write. The client-side auth guard
 * (`useAuthRedirect`) reacts to the now-empty session store and forwards the
 * user to `/auth` to sign in again — so an expired session re-authenticates
 * instead of dead-ending behind failing requests.
 */
function onAuthError(error: unknown): void {
	if (isUnauthorized(error)) clearSession();
}

export function getContext() {
	const queryClient = new QueryClient({
		queryCache: new QueryCache({ onError: onAuthError }),
		mutationCache: new MutationCache({ onError: onAuthError }),
		defaultOptions: {
			queries: {
				// Self-heal transient blips (network drop, 5xx) with a couple of
				// retries, but never retry a client error (4xx) — a 401/404 won't fix
				// itself, so surface it immediately. Queries that opt out (e.g. the
				// proposed-draft 404) set their own `retry: false`.
				retry: (failureCount, error) => {
					if (error instanceof ApiError && error.status < 500) return false;
					return failureCount < 2;
				},
				// NB: no global `staleTime` — the onboarding guards refetch
				// `/onboarding/progress` on every route mount to detect step
				// advancement, so they rely on the default "always stale". The
				// daily-dashboard reads opt into caching individually (see
				// `DASHBOARD_QUERY_CACHE` in lib/hooks.ts).
			},
		},
	});

	return {
		queryClient,
	};
}
export default function TanstackQueryProvider() {}
