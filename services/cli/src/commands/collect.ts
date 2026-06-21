import {
  type Db,
  type Enums,
  failActivity,
  getBoard,
  insertCandidacy,
  listTargetTitles,
  setBoardStatus,
  startActivity,
  succeedActivity,
  upsertCompany,
  upsertPosting,
} from "@archer/db";
import type { Command } from "commander";
import { getAdapter } from "../adapters/index.js";
import { NotIntegratedError, type ScrapedPosting } from "../adapters/types.js";
import {
  CliError,
  type GlobalOpts,
  output,
  readJsonFixture,
  requireUser,
  run,
} from "../context.js";
import { pushHeartbeat } from "../heartbeat.js";

/** The structured detail a collect run records on its Activity and prints. */
export interface CollectSummary {
  board: string;
  scraped: number;
  postingsNew: number;
  candidaciesNew: number;
  activityId: string;
}

export interface RunCollectArgs {
  board: string;
  userId: string;
  titles: string[];
  /** Whether the postings came from a fixture file (recorded on the Activity). */
  fixture: boolean;
  /** The browser/fixture boundary: produces the postings to ingest. */
  gather: () => Promise<ScrapedPosting[]>;
}

type IntegrationStatus = Enums<"integration_status">;

/**
 * Decide the board `collect_status` a live collect run should leave behind, or
 * null when no write is needed. A clean run proves the adapter healthy, so it
 * (re)integrates the board — restoring a `broken` one and flipping a board that
 * was still wiring up. A failure breaks the board ONLY if it was actually
 * `integrated`: a run that merely refused because the board was never integrated
 * (`not_integrated` / still `in_progress`) leaves its status untouched, never
 * masquerading as a breakage. Pure so the lifecycle is testable without a DB.
 */
export function nextCollectStatus(
  failed: boolean,
  current: IntegrationStatus,
): IntegrationStatus | null {
  if (!failed) return current === "integrated" ? null : "integrated";
  return current === "integrated" ? "broken" : null;
}

/**
 * Run one collect as the universal Activity primitive: open an `activities` row,
 * gather postings (the only place the live-browser/fixture boundary lives), upsert
 * companies + postings idempotently, fan a candidacy out per user-per-posting, and
 * record the run as succeeded/failed. A thrown `gather` (e.g. `NotIntegratedError`)
 * still leaves a `failed` Activity behind — the signal the self-heal Mechanic reacts
 * to — before the error propagates. Exercised end-to-end via `--fixture`, no browser.
 *
 * A LIVE run (not `--fixture`) also reconciles the board's `collect_status` to its
 * outcome (see `nextCollectStatus`), so the board lifecycle reflects reality without
 * touching its independent `apply_status`. Fixture runs bypass the live adapter and
 * so never claim a board is integrated/broken.
 */
export async function runCollect(db: Db, args: RunCollectArgs): Promise<CollectSummary> {
  const activity = await startActivity(db, {
    type: "collect",
    boardSlug: args.board,
    userId: args.userId,
    detail: { titles: args.titles, fixture: args.fixture },
  });
  try {
    const scraped = await args.gather();
    let postingsNew = 0;
    let candidaciesNew = 0;
    for (const s of scraped) {
      const companyId = s.companyName ? await upsertCompany(db, s.companyName) : null;
      const posting = await upsertPosting(db, {
        boardSlug: args.board,
        url: s.url,
        title: s.title,
        companyId,
        companyNameRaw: s.companyName ?? null,
        externalId: s.externalId ?? null,
        location: s.location ?? null,
        workMode: s.workMode,
        salaryRaw: s.salaryRaw ?? null,
        description: s.description ?? null,
        postedOn: s.postedOn ?? null,
      });
      if (posting.inserted) postingsNew++;
      const candidacy = await insertCandidacy(db, args.userId, posting.id);
      if (candidacy) candidaciesNew++;
    }
    const summary = {
      board: args.board,
      scraped: scraped.length,
      postingsNew,
      candidaciesNew,
      activityId: activity.id,
    };
    await succeedActivity(db, activity.id, summary);
    await reconcileBoardStatus(db, args, false);
    return summary;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failActivity(db, activity.id, msg);
    await reconcileBoardStatus(db, args, true);
    throw err;
  }
}

/** Drive a board's `collect_status` to match a live run's outcome. A no-op for
 *  fixture runs (they never exercise the live adapter) and whenever no transition
 *  is warranted; only ever writes `collect_status`, never `apply_status`. */
async function reconcileBoardStatus(db: Db, args: RunCollectArgs, failed: boolean): Promise<void> {
  if (args.fixture) return;
  const board = await getBoard(db, args.board);
  if (!board) return;
  const next = nextCollectStatus(failed, board.collect_status);
  if (next) await setBoardStatus(db, args.board, { collect: next });
}

interface CollectOpts {
  titles?: string;
  since: string;
  dryRun?: boolean;
  fixture?: string;
  headless?: boolean;
}

export function registerCollect(program: Command): void {
  program
    .command("collect")
    .description("Collect today's postings from a board into the database")
    .argument("<board>", "board slug")
    .option("--titles <list>", "comma-separated titles (default: the user's active target titles)")
    .option("--since <when>", "only postings since this date or 'today'", "today")
    .option("--dry-run", "scrape but do not write")
    .option(
      "--fixture <path>",
      "read ScrapedPosting[] from a JSON file instead of scraping (dev/testing)",
    )
    .option("--headless", "run the browser headless (default: headful, for VNC)")
    .action(async (board: string, opts: CollectOpts, cmd) => {
      await run(cmd.optsWithGlobals() as GlobalOpts, async (ctx) => {
        const boardRow = await getBoard(ctx.db, board);
        if (!boardRow) throw new CliError(`unknown board: ${board}`);
        const userId = requireUser(ctx);

        const titles = opts.titles
          ? opts.titles
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : (await listTargetTitles(ctx.db, userId, { activeOnly: true })).map((t) => t.title);

        const gather = async (): Promise<ScrapedPosting[]> => {
          if (opts.fixture) {
            return readJsonFixture<ScrapedPosting[]>(opts.fixture, "--fixture");
          }
          const adapter = getAdapter(board);
          if (!adapter) {
            throw new CliError(
              `board '${board}' has no collect adapter yet (collect_status=${boardRow.collect_status})`,
            );
          }
          const prefix = boardRow.cred_env_prefix;
          return adapter.collect({
            titles,
            since: opts.since,
            creds: {
              email: process.env[`${prefix}_EMAIL`],
              password: process.env[`${prefix}_PASSWORD`],
            },
            proxy: process.env.DECODO_PROXY,
            headful: !opts.headless,
            log: (m) => console.error(m),
          });
        };

        // Dry-run previews without recording an Activity.
        if (opts.dryRun) {
          let scraped: ScrapedPosting[];
          try {
            scraped = await gather();
          } catch (err) {
            if (err instanceof NotIntegratedError) throw new CliError(err.message);
            throw err;
          }
          output(ctx, { board, scraped: scraped.length, postings: scraped }, (r) =>
            console.log(`[dry-run] ${board}: ${r.scraped} postings (not written)`),
          );
          return;
        }

        // Write path: wrap collection in an Activity so failures are recorded
        // (a failed collect is what the self-heal Mechanic reacts to).
        try {
          const summary = await runCollect(ctx.db, {
            board,
            userId,
            titles,
            fixture: Boolean(opts.fixture),
            gather,
          });
          // Dead-man's-switch (ARC-12): a successful collect pings the Uptime Kuma
          // Push monitor so its ABSENCE — not its failure — is what alerts. The
          // helper is best-effort (no-op unless UPTIME_KUMA_PUSH_URL is set, never
          // throws); a configured-but-failed push is a stderr warning only, so it
          // can't pollute the --json summary on stdout or fail the run.
          const hb = await pushHeartbeat({ msg: `collect-ok:${board}` });
          if (hb.pushed && !hb.ok) console.error(`collect: heartbeat push failed: ${hb.error}`);
          output(ctx, summary, (s) =>
            console.log(
              `${board}: scraped ${s.scraped}, ${s.postingsNew} new postings, ${s.candidaciesNew} new candidacies`,
            ),
          );
        } catch (err) {
          // runCollect already recorded the failed Activity; surface NotIntegratedError
          // as a user-facing CliError (exit 2), anything else as an unexpected crash.
          if (err instanceof NotIntegratedError) throw new CliError(err.message);
          throw err;
        }
      });
    });
}
