import { readFileSync } from "node:fs";
import {
  failActivity,
  getBoard,
  insertCandidacy,
  listTargetTitles,
  startActivity,
  succeedActivity,
  upsertCompany,
  upsertPosting,
} from "@archer/db";
import type { Command } from "commander";
import { getAdapter } from "../adapters/index.js";
import { NotIntegratedError, type ScrapedPosting } from "../adapters/types.js";
import { CliError, type GlobalOpts, output, requireUser, run } from "../context.js";

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
            return JSON.parse(readFileSync(opts.fixture, "utf8")) as ScrapedPosting[];
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
        const activity = await startActivity(ctx.db, {
          type: "collect",
          boardSlug: board,
          userId,
          detail: { titles, fixture: Boolean(opts.fixture) },
        });
        try {
          const scraped = await gather();
          let postingsNew = 0;
          let candidaciesNew = 0;
          for (const s of scraped) {
            const companyId = s.companyName ? await upsertCompany(ctx.db, s.companyName) : null;
            const posting = await upsertPosting(ctx.db, {
              boardSlug: board,
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
            const candidacy = await insertCandidacy(ctx.db, userId, posting.id);
            if (candidacy) candidaciesNew++;
          }
          const summary = {
            board,
            scraped: scraped.length,
            postingsNew,
            candidaciesNew,
            activityId: activity.id,
          };
          await succeedActivity(ctx.db, activity.id, summary);
          output(ctx, summary, (s) =>
            console.log(
              `${board}: scraped ${s.scraped}, ${s.postingsNew} new postings, ${s.candidaciesNew} new candidacies`,
            ),
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await failActivity(ctx.db, activity.id, msg);
          if (err instanceof NotIntegratedError) throw new CliError(msg);
          throw err;
        }
      });
    });
}
