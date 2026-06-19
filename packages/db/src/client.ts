import postgres from "postgres";

/**
 * A service-level Postgres connection (connects as the service role via the
 * Supabase pooler, so it bypasses RLS) — for Scout, the API, and agents.
 * Clients (mobile/admin) talk to Supabase/PostgREST directly instead.
 */
export type Db = postgres.Sql;

export interface DbEnv {
  DATABASE_URL?: string;
}

/**
 * Connect to the Archer database via DATABASE_URL. `prepare: false` keeps it
 * compatible with Supabase's transaction pooler. Callers own the lifecycle —
 * call `await db.end()` when a one-shot run (e.g. a CLI command) finishes.
 */
export function createDb(env: DbEnv = process.env): Db {
  const url = env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required to connect to the Archer database");
  }
  return postgres(url, { prepare: false, max: 5, idle_timeout: 20 });
}
