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

/** A collect run's terminal outcome. `collected` ran the adapter and ingested
 *  whatever it returned; `not_integrated` is the calm, expected state of a board
 *  whose adapter isn't wired up yet — a visible, non-error result (ARC-140), not a
 *  failure. (Genuine failures aren't an outcome here: they throw.) */
export type CollectOutcome = "collected" | "not_integrated";

/** Default spacing between per-title scrape attempts (ARC-139), in ms. A daily run
 *  searches one title at a time rather than all at once to spread load and reduce
 *  detection; a few seconds apart is enough to avoid a burst without dragging the
 *  run out. Overridable with `collect --title-delay`. */
export const DEFAULT_TITLE_DELAY_MS = 4000;

/** Split a user's active titles into the scrape attempts a collect run makes:
 *  one attempt per title (ARC-139) — "one title at a time" — instead of a single
 *  call carrying every title. With no active titles, a single empty attempt still
 *  probes the board, so a not-integrated stub surfaces its state (and an integrated
 *  board reports "nothing") rather than being skipped. Pure, so it's trivially testable. */
export function titleAttempts(titles: string[]): string[][] {
  return titles.length === 0 ? [[]] : titles.map((t) => [t]);
}

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface CollectAcrossTitlesArgs {
  /** The user's active target titles; fanned out one per scrape attempt. */
  titles: string[];
  /** Run one scrape attempt for the given (single-title) attempt — the live
   *  browser/fixture boundary. */
  collect: (titles: string[]) => Promise<ScrapedPosting[]>;
  /** Spacing between attempts in ms (default {@link DEFAULT_TITLE_DELAY_MS}); 0 disables it. */
  spacingMs?: number;
  /** Injectable for tests so the fan-out is proven without real timers. */
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

/**
 * Fan a collect run out over the user's active titles (ARC-139): issue one scrape
 * attempt per title in sequence — "one title at a time" — pausing `spacingMs`
 * between attempts (never before the first or after the last) to spread load and
 * reduce detection, then concatenate every attempt's postings in order. The same
 * job surfaced by two titles still collapses to one posting/candidacy downstream
 * (board+url and per-user dedup in `runCollect`). Pure over an injected `collect`
 * + `sleep`, so the fan-out is testable without a live browser or a database.
 */
export async function collectAcrossTitles(
  args: CollectAcrossTitlesArgs,
): Promise<ScrapedPosting[]> {
  const spacing = args.spacingMs ?? DEFAULT_TITLE_DELAY_MS;
  const sleep = args.sleep ?? sleepMs;
  const attempts = titleAttempts(args.titles);
  const all: ScrapedPosting[] = [];
  for (let i = 0; i < attempts.length; i++) {
    if (i > 0 && spacing > 0) await sleep(spacing);
    const postings = await args.collect(attempts[i]);
    args.log?.(`collect: '${attempts[i].join(", ") || "(no active titles)"}' → ${postings.length}`);
    all.push(...postings);
  }
  return all;
}

/** The structured detail a collect run records on its Activity and prints. */
export interface CollectSummary {
  board: string;
  outcome: CollectOutcome;
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
 * Classify what a collect run's error MEANS (ARC-140). A `NotIntegratedError` is
 * not a failure — it's a board whose adapter simply isn't wired up yet, an
 * expected, calm state we record as a clean `not_integrated` outcome (a succeeded
 * Activity, board status untouched). Any other error is a genuine `failed` run
 * (login/scrape/proxy), which records a failed Activity and can break an
 * integrated board. Pure so the outcome policy is testable without a DB.
 */
export function classifyCollectError(err: unknown): "not_integrated" | "failed" {
  return err instanceof NotIntegratedError ? "not_integrated" : "failed";
}

/**
 * Run one collect as the universal Activity primitive: open an `activities` row,
 * gather postings (the only place the live-browser/fixture boundary lives), upsert
 * companies + postings idempotently, fan a candidacy out per user-per-posting, and
 * record the run's outcome. A genuine `gather` failure leaves a `failed` Activity
 * behind — the signal the self-heal Mechanic reacts to — before the error
 * propagates. A `NotIntegratedError` is NOT a failure (ARC-140): it records a
 * succeeded Activity tagged `not_integrated` and returns instead of throwing, so a
 * not-wired-up board is a clean, visible outcome. Exercised via `--fixture`, no browser.
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
    const summary: CollectSummary = {
      board: args.board,
      outcome: "collected",
      scraped: scraped.length,
      postingsNew,
      candidaciesNew,
      activityId: activity.id,
    };
    await succeedActivity(db, activity.id, { ...summary });
    await reconcileBoardStatus(db, args, false);
    return summary;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A not-integrated board is a calm, expected state — never a failure (ARC-140).
    // Record a SUCCEEDED Activity tagged `not_integrated` so the run is visible as a
    // clean outcome (not a `failed` row that breaks the board or wakes the Mechanic),
    // leave collect_status untouched, and return a summary rather than throwing.
    if (classifyCollectError(err) === "not_integrated") {
      const summary: CollectSummary = {
        board: args.board,
        outcome: "not_integrated",
        scraped: 0,
        postingsNew: 0,
        candidaciesNew: 0,
        activityId: activity.id,
      };
      await succeedActivity(db, activity.id, { ...summary, message: msg });
      return summary;
    }
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
  titleDelay?: string;
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
    .option(
      "--title-delay <ms>",
      `ms to pause between per-title scrape attempts (default ${DEFAULT_TITLE_DELAY_MS}; 0 to disable)`,
    )
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
            // No adapter yet is the same calm "not integrated" state as a stub
            // adapter that throws NotIntegratedError — surface one unified signal
            // so runCollect records it as a clean outcome, not a failure (ARC-140).
            throw new NotIntegratedError(
              `board '${board}' has no collect adapter yet (collect_status=${boardRow.collect_status})`,
            );
          }
          const prefix = boardRow.cred_env_prefix;
          // ARC-139: one scrape attempt per active title, spaced apart, rather than
          // a single call carrying every title — spreads load and reduces detection.
          // today-only rides through unchanged on `--since` (default 'today').
          const spacingMs = opts.titleDelay !== undefined ? Number(opts.titleDelay) : undefined;
          return collectAcrossTitles({
            titles,
            spacingMs,
            log: (m) => console.error(m),
            collect: (attemptTitles) =>
              adapter.collect({
                titles: attemptTitles,
                since: opts.since,
                creds: {
                  email: process.env[`${prefix}_EMAIL`],
                  password: process.env[`${prefix}_PASSWORD`],
                },
                proxy: process.env.DECODO_PROXY,
                headful: !opts.headless,
                log: (m) => console.error(m),
              }),
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

        // Write path: wrap collection in an Activity so the run is recorded. A
        // genuine failure throws (after runCollect records the failed Activity the
        // Mechanic reacts to); a not-integrated board returns a clean summary
        // instead of throwing (ARC-140), so it is reported, not surfaced as an error.
        const summary = await runCollect(ctx.db, {
          board,
          userId,
          titles,
          fixture: Boolean(opts.fixture),
          gather,
        });
        // Dead-man's-switch (ARC-12): a completed collect pings the Uptime Kuma
        // Push monitor so its ABSENCE — not its failure — is what alerts. A
        // not-integrated run still completed cleanly, so it pings too (otherwise the
        // monitor would false-alarm while every board is still stubbed). The helper
        // is best-effort (no-op unless UPTIME_KUMA_PUSH_URL is set, never throws); a
        // configured-but-failed push is a stderr warning only, so it can't pollute
        // the --json summary on stdout or fail the run.
        const hb = await pushHeartbeat({ msg: `collect-ok:${board}` });
        if (hb.pushed && !hb.ok) console.error(`collect: heartbeat push failed: ${hb.error}`);
        output(ctx, summary, (s) =>
          s.outcome === "not_integrated"
            ? console.log(
                `${board}: not integrated yet — recorded as a clean outcome (nothing collected)`,
              )
            : console.log(
                `${board}: scraped ${s.scraped}, ${s.postingsNew} new postings, ${s.candidaciesNew} new candidacies`,
              ),
        );
      });
    });
}
