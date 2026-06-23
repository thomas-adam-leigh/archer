/**
 * Supabase configuration for the web client.
 *
 * We talk to Supabase Auth (GoTrue), Storage and the `transcribe` edge function
 * over their REST surfaces with the browser `fetch` rather than
 * `@supabase/supabase-js` — the surface onboarding needs is small and
 * well-defined, and this keeps the bundle lean and the SSR story simple.
 *
 * Only the *publishable* key is used here. Per Supabase guidance, publishable
 * keys are designed for frontend clients; the secret key must never ship in a
 * client bundle. Both values are read from `env` (kept optional there so a
 * secret-less CI build never throws on import) and asserted at call time.
 *
 * It also exposes the project's **Realtime** transport (ARC-125): the shared
 * AG-UI client streams a thread's `events` over Supabase Realtime, and
 * `getRealtimeTransport` binds that package's transport to this project's URL +
 * publishable key (falling back to a no-op when no `WebSocket` is present, e.g.
 * during SSR or under jsdom).
 */

import { type RealtimeTransport, resolveRealtime } from "@archer/agui-client";
import { env } from "#/env.ts";

/** The Supabase project URL, or a thrown error when it isn't configured. */
export function getSupabaseUrl(): string {
	const url = env.VITE_SUPABASE_URL;
	if (!url) {
		throw new Error(
			"Missing Supabase config: set VITE_SUPABASE_URL in apps/web/.env.local",
		);
	}
	return url;
}

/** The Supabase publishable key, or a thrown error when it isn't configured. */
export function getSupabasePublishableKey(): string {
	const key = env.VITE_SUPABASE_PUBLISHABLE_KEY;
	if (!key) {
		throw new Error(
			"Missing Supabase config: set VITE_SUPABASE_PUBLISHABLE_KEY in apps/web/.env.local",
		);
	}
	return key;
}

/**
 * The Supabase Realtime transport for streaming a thread's `events` (ARC-125).
 * Resolves the shared AG-UI client's transport against this project's URL +
 * publishable key; when the host has no `WebSocket` (SSR, jsdom) it degrades to a
 * no-op so callers fall back to history-restore + the `/onboarding/progress` poll.
 */
export function getRealtimeTransport(): RealtimeTransport {
	return resolveRealtime({
		url: getSupabaseUrl(),
		apikey: getSupabasePublishableKey(),
	});
}
