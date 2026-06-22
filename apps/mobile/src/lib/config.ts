/**
 * Archer backend configuration for the Lynx client.
 *
 * The base URL of the Hono API (`services/api`). Actions (run an agent,
 * approve a draft, submit for review) go through this API; reads come straight
 * from Supabase under RLS. Only `PUBLIC_`-prefixed vars are exposed to the
 * client bundle via `import.meta.env`.
 */

const apiUrl = import.meta.env.PUBLIC_ARCHER_API_URL;

if (!apiUrl) {
  throw new Error(
    'Missing Archer API config: set PUBLIC_ARCHER_API_URL in apps/mobile/.env',
  );
}

export const ARCHER_API_URL: string = apiUrl;
