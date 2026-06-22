/**
 * Archer backend configuration for the web client.
 *
 * The base URL of the Hono API (`services/api`). Actions (start an ingest run,
 * approve a draft, capture criteria) go through this API; reads come straight
 * from Supabase under RLS. The value is read from `env` (T3Env), which keeps it
 * optional so a secret-less CI build never throws on import — so we assert its
 * presence here, at call time, with a clear message for dev/prod.
 */

import { env } from "#/env.ts";

/** The Archer API base URL, or a thrown error when it isn't configured. */
export function getArcherApiUrl(): string {
	const url = env.VITE_ARCHER_API_URL;
	if (!url) {
		throw new Error(
			"Missing Archer API config: set VITE_ARCHER_API_URL in apps/web/.env.local",
		);
	}
	return url;
}
