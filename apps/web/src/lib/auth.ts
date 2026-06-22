/**
 * GoTrue auth for the web client (ported from `apps/mobile/src/lib/auth.ts`).
 *
 * Sign up / sign in / sign out hit Supabase Auth's REST surface directly with
 * the browser `fetch` and the publishable `apikey`. The returned {@link Session}
 * carries the tokens plus the user they belong to; persistence lives in
 * `session.ts`.
 */

import { getSupabasePublishableKey, getSupabaseUrl } from "#/lib/supabase.ts";

/** The authenticated user, as returned by Supabase Auth. */
export interface AuthUser {
	id: string;
	email: string | null;
}

/** A signed-in session: the tokens plus the user they belong to. */
export interface Session {
	accessToken: string;
	refreshToken: string;
	user: AuthUser;
}

/** An auth failure carrying a message safe to show in the UI. */
export class AuthError extends Error {}

interface GoTrueSession {
	access_token?: string;
	refresh_token?: string;
	user?: { id: string; email: string | null };
}

interface GoTrueError {
	msg?: string;
	error_description?: string;
	error?: string;
	message?: string;
}

function authHeaders(): Record<string, string> {
	return {
		apikey: getSupabasePublishableKey(),
		"Content-Type": "application/json",
	};
}

async function readError(res: Response, fallback: string): Promise<AuthError> {
	let body: GoTrueError = {};
	try {
		body = (await res.json()) as GoTrueError;
	} catch {
		// non-JSON body — fall through to the generic message
	}
	const message =
		body.msg ??
		body.error_description ??
		body.message ??
		body.error ??
		fallback;
	return new AuthError(message);
}

function toSession(data: GoTrueSession): Session {
	if (!data.access_token || !data.refresh_token || !data.user) {
		throw new AuthError("Unexpected response from the auth server.");
	}
	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		user: { id: data.user.id, email: data.user.email },
	};
}

/**
 * Create an account with email + password. When the project has email
 * confirmation disabled, this returns a ready-to-use {@link Session}. When it is
 * enabled, the server returns no tokens and we report that confirmation is still
 * required so the UI can tell the user to check their inbox.
 */
export async function signUp(
	email: string,
	password: string,
	fetchImpl: typeof fetch = fetch,
): Promise<{ session: Session | null }> {
	const res = await fetchImpl(`${getSupabaseUrl()}/auth/v1/signup`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({ email, password }),
	});
	if (!res.ok) throw await readError(res, "Sign up failed.");

	const data = (await res.json()) as GoTrueSession;
	if (!data.access_token) return { session: null };
	return { session: toSession(data) };
}

/** Sign in with email + password, returning the active session. */
export async function signIn(
	email: string,
	password: string,
	fetchImpl: typeof fetch = fetch,
): Promise<Session> {
	const res = await fetchImpl(
		`${getSupabaseUrl()}/auth/v1/token?grant_type=password`,
		{
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({ email, password }),
		},
	);
	if (!res.ok) throw await readError(res, "Sign in failed.");
	return toSession((await res.json()) as GoTrueSession);
}

/**
 * Sign out, revoking the current access token on the server. We use
 * `scope=local` to invalidate only this session's tokens. Network/server
 * failures are swallowed — the client drops the session regardless.
 */
export async function signOut(
	accessToken: string,
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	try {
		await fetchImpl(`${getSupabaseUrl()}/auth/v1/logout?scope=local`, {
			method: "POST",
			headers: { ...authHeaders(), Authorization: `Bearer ${accessToken}` },
		});
	} catch {
		// best-effort revoke; the UI clears local state either way
	}
}
