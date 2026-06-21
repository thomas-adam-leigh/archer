/**
 * Supabase configuration for the Lynx mobile client.
 *
 * We talk to Supabase Auth (GoTrue) over its REST API using Lynx's global
 * `fetch`, rather than `@supabase/supabase-js` — the JS client targets the
 * browser/Node and its session-storage + bundling assumptions don't hold in
 * Lynx's dual-thread runtime. The REST surface is small and well-defined.
 *
 * Only the *publishable* key is used here. Per Supabase guidance, publishable
 * keys are designed for frontend clients; the secret key must never ship in a
 * client bundle.
 */

const url = import.meta.env.PUBLIC_SUPABASE_URL;
const publishableKey = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!url || !publishableKey) {
  throw new Error(
    'Missing Supabase config: set PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_PUBLISHABLE_KEY in apps/mobile/.env',
  );
}

export const SUPABASE_URL: string = url;
export const SUPABASE_PUBLISHABLE_KEY: string = publishableKey;
