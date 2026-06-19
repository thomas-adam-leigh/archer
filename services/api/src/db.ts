import { createDb, type Db } from "@archer/db";

let pool: Db | undefined;

/** Lazily create and memoize the service DB pool, so /health needs no DATABASE_URL. */
export function getDb(): Db {
  if (!pool) pool = createDb();
  return pool;
}
