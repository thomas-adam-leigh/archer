import { type Enums, getBoard, listBoards, setBoardStatus } from "@archer/db";
import type { Command } from "commander";
import { CliError, type GlobalOpts, output, run } from "../context.js";

type IStatus = Enums<"integration_status">;
const INTEGRATION_STATUSES: readonly string[] = [
  "not_integrated",
  "in_progress",
  "integrated",
  "broken",
];

export function registerBoards(program: Command): void {
  const boards = program.command("boards").description("Manage job-board adapters");

  boards
    .command("list")
    .description("List the configured boards and their integration status")
    .action(async (_opts, cmd) => {
      await run(cmd.optsWithGlobals() as GlobalOpts, async (ctx) => {
        const rows = await listBoards(ctx.db);
        output(ctx, rows, (bs) => {
          for (const b of bs) {
            console.log(
              `${b.slug.padEnd(16)} collect=${b.collect_status.padEnd(14)} ` +
                `apply=${b.apply_status.padEnd(14)} ${b.name}`,
            );
          }
        });
      });
    });

  boards
    .command("show")
    .description("Show one board")
    .argument("<slug>", "board slug")
    .action(async (slug: string, _opts, cmd) => {
      await run(cmd.optsWithGlobals() as GlobalOpts, async (ctx) => {
        const board = await getBoard(ctx.db, slug);
        if (!board) throw new CliError(`unknown board: ${slug}`);
        output(ctx, board, (b) => console.log(JSON.stringify(b, null, 2)));
      });
    });

  boards
    .command("set-status")
    .description("Set a board's collect and/or apply integration status")
    .argument("<slug>", "board slug")
    .option("--collect <status>", `collect status (${INTEGRATION_STATUSES.join("|")})`)
    .option("--apply <status>", `apply status (${INTEGRATION_STATUSES.join("|")})`)
    .action(async (slug: string, opts: { collect?: string; apply?: string }, cmd) => {
      await run(cmd.optsWithGlobals() as GlobalOpts, async (ctx) => {
        if (!opts.collect && !opts.apply) {
          throw new CliError("provide --collect and/or --apply");
        }
        for (const [flag, value] of [
          ["--collect", opts.collect],
          ["--apply", opts.apply],
        ] as const) {
          if (value && !INTEGRATION_STATUSES.includes(value)) {
            throw new CliError(`${flag} must be one of ${INTEGRATION_STATUSES.join(", ")}`);
          }
        }
        const board = await setBoardStatus(ctx.db, slug, {
          collect: opts.collect as IStatus | undefined,
          apply: opts.apply as IStatus | undefined,
        });
        if (!board) throw new CliError(`unknown board: ${slug}`);
        output(ctx, board, (b) =>
          console.log(`${b.slug}: collect=${b.collect_status} apply=${b.apply_status}`),
        );
      });
    });
}
