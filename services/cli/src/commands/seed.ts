import { clearDemo, seedDemo } from "@archer/db";
import type { Command } from "commander";
import { type GlobalOpts, output, requireUser, run } from "../context.js";

interface SeedDemoOpts {
  clear?: boolean;
}

/** `archer seed:demo` (ARC-162) — owner-only, idempotent demo data so the real
 *  dashboard renders populated home / jobs / companies / cover-letters states
 *  before live scraping is wired up. `--clear` tears the demo data back down.
 *  A hand-run dev/owner step; it never auto-runs anywhere. */
export function registerSeed(program: Command): void {
  program
    .command("seed:demo")
    .description("Seed (or clear) owner-only demo dashboard data — idempotent")
    .option("--clear", "remove the demo data instead of seeding it")
    .action(async (opts: SeedDemoOpts, cmd) => {
      await run(cmd.optsWithGlobals() as GlobalOpts, async (ctx) => {
        const userId = requireUser(ctx);
        if (opts.clear) {
          const summary = await clearDemo(ctx.db, userId);
          output(ctx, summary, (s) =>
            console.log(
              `cleared demo data: ${s.postings} postings, ${s.companies} companies, ` +
                `${s.proposals} proposals, ${s.activities} activities`,
            ),
          );
          return;
        }
        const summary = await seedDemo(ctx.db, userId);
        output(ctx, summary, (s) =>
          console.log(
            `seeded demo data: ${s.companies} companies (${s.contacts} contacts), ` +
              `${s.postings} postings, ${s.candidacies} candidacies, ` +
              `${s.coverLetterVersions} cover-letter draft, ${s.activities} activities`,
          ),
        );
      });
    });
}
