// The database is Archer's contract. Generated TS types are the TypeScript-side
// projection of the Postgres schema in ../supabase/migrations. Python services
// generate their own models from the same migrations — see the architecture doc.
export type { Database, Json } from "./database.types.js";
// Runtime enum values (e.g. Constants.public.Enums.candidacy_status) — the
// contract's allowed values, usable for validation.
export { Constants } from "./database.types.js";

import type { Database } from "./database.types.js";

/** Row type for a public table, e.g. `Tables<"users">`. */
export type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];

/** Insert type for a public table. */
export type TablesInsert<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Insert"];

/** Update type for a public table. */
export type TablesUpdate<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Update"];

/** A public enum, e.g. `Enums<"candidacy_status">`. */
export type Enums<T extends keyof Database["public"]["Enums"]> = Database["public"]["Enums"][T];

export * from "./apply-confirm.js";
export * from "./candidacy-status.js";
// Runtime: the service-level Postgres client + typed data-access layer.
export { createDb, type Db, type DbEnv } from "./client.js";
export * from "./collection-schedule.js";
export * from "./queries.js";
export * from "./seed-demo.js";
