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

/** Print JSON when --json is set, otherwise render a human view. */
export function output<T>(ctx: CliContext, data: T, human: (d: T) => void): void {
  if (ctx.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    human(data);
  }
}
