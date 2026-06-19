import type { Enums } from "@archer/db";

/** One job ad as scraped from a board, before it's written as a Posting. */
export interface ScrapedPosting {
  url: string;
  title: string;
  companyName?: string;
  externalId?: string;
  location?: string;
  workMode?: Enums<"work_mode">;
  salaryRaw?: string;
  description?: string;
  postedOn?: string; // ISO date (YYYY-MM-DD)
}

/** Everything a board adapter needs for a collect run. */
export interface CollectContext {
  titles: string[];
  since: string; // 'today' or an ISO date
  creds: { email?: string; password?: string };
  proxy?: string;
  headful: boolean;
  log: (msg: string) => void;
}

/** A board-specific collect (and, later, apply) implementation. */
export interface BoardAdapter {
  slug: string;
  collect(ctx: CollectContext): Promise<ScrapedPosting[]>;
}

/** Thrown by a board adapter whose collect path hasn't been integrated yet. */
export class NotIntegratedError extends Error {}
