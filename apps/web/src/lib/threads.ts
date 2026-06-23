/**
 * Reading the user's conversation thread directly from Supabase under RLS
 * (ported from `apps/mobile/src/lib/threads.ts`).
 *
 * Every action the client dispatches to a thread (the résumé ingest run, the
 * conversational onboarding run, redrafts) attaches to a `threadId`. The signup
 * trigger bootstraps the user's first `threads` row in the same transaction as
 * their `users` row (`20260620120000_bootstrap_first_thread.sql`), so a signed-in
 * user always has one to use. Per the client contract, reads come straight from
 * Supabase under RLS — not through the Hono API — so we hit the PostgREST surface
 * with the user's JWT plus the publishable `apikey`; RLS returns only their rows.
 */

import type { Session } from "#/lib/auth.ts";
import { getSupabasePublishableKey, getSupabaseUrl } from "#/lib/supabase.ts";

/** A failure resolving the user's thread, with a message safe to show in the UI. */
export class ThreadLookupError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ThreadLookupError";
	}
}

/**
 * Fetch the user's primary (earliest) thread id — the conversation the bootstrap
 * trigger created at signup, which the onboarding runs attach to. Reads directly
 * from Supabase under RLS with the user's JWT; throws {@link ThreadLookupError} on
 * a non-2xx response or when no thread exists.
 */
export async function fetchPrimaryThreadId(
	session: Session,
	fetchImpl: typeof fetch = fetch,
): Promise<string> {
	const url = `${getSupabaseUrl()}/rest/v1/threads?select=id&order=created_at.asc&limit=1`;
	const res = await fetchImpl(url, {
		headers: {
			apikey: getSupabasePublishableKey(),
			Authorization: `Bearer ${session.accessToken}`,
			Accept: "application/json",
		},
	});

	if (!res.ok) {
		throw new ThreadLookupError(
			`Couldn't load your conversation (${res.status}).`,
		);
	}

	const rows = (await res.json().catch(() => null)) as Array<{
		id?: unknown;
	}> | null;
	const id = Array.isArray(rows) ? rows[0]?.id : undefined;
	if (typeof id !== "string" || id === "") {
		throw new ThreadLookupError("Couldn't find your conversation to continue.");
	}
	return id;
}
