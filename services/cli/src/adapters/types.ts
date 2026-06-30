import type { Enums } from "@archer/db";
import type { Applier } from "../commands/apply.js";

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

/** A board-specific collect and (optionally) apply implementation. */
export interface BoardAdapter {
  slug: string;
  collect(ctx: CollectContext): Promise<ScrapedPosting[]>;
  /** Drive the board's application form. Absent until a board's apply path is mapped;
   *  the apply boundary falls back to the stub adapter for boards without one. */
  apply?: Applier;
}

/** Thrown by a board adapter whose collect path hasn't been integrated yet. */
export class NotIntegratedError extends Error {}
