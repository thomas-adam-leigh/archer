import { readFileSync } from "node:fs";
import { createDb, type Db } from "@archer/db";

export interface GlobalOpts {
  json?: boolean;
  user?: string;
}

/** A user-facing failure (exit code 2) vs. an unexpected crash (exit code 1). */
export class CliError extends Error {}

export interface CliContext {
  db: Db;
  json: boolean;
  userId: string | null;
}

/** Build a context, run the command body, and always close the DB connection. */
export async function run(g: GlobalOpts, fn: (ctx: CliContext) => Promise<void>): Promise<void> {
  const ctx: CliContext = {
    db: createDb(),
    json: !!g.json,
    userId: g.user ?? process.env.ARCHER_USER_ID ?? null,
  };
  try {
    await fn(ctx);
  } finally {
    await ctx.db.end({ timeout: 5 });
  }
}

export function requireUser(ctx: CliContext): string {
  if (!ctx.userId) {
    throw new CliError("no user: pass --user <uuid> or set ARCHER_USER_ID");
  }
  return ctx.userId;
}

/** Read and JSON-parse a file named by a CLI flag (e.g. `--fixture`), turning a
 *  missing/unreadable file or malformed JSON into a clean CliError (exit 2) instead
 *  of a raw ENOENT/SyntaxError crash. Mirrors `parseJsonFlag`'s fail-closed contract;
 *  the caller still owns the shape it casts the parsed value to. */
export function readJsonFixture<T>(path: string, flag: string): T {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new CliError(`${flag} file is missing or unreadable: ${path}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new CliError(`${flag} must be a valid JSON file: ${path}`);
  }
}

/** Print JSON when --json is set, otherwise render a human view. */
export function output<T>(ctx: CliContext, data: T, human: (d: T) => void): void {
  if (ctx.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    human(data);
  }
}
