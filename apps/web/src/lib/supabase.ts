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
 */

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
