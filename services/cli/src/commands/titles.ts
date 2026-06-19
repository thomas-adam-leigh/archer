import { addTargetTitle, listTargetTitles, removeTargetTitle } from "@archer/db";
import type { Command } from "commander";
import { type GlobalOpts, output, requireUser, run } from "../context.js";

export function registerTitles(program: Command): void {
  const titles = program
    .command("titles")
    .description("Manage target job titles (the collect search keys)");

  titles
    .command("list")
    .description("List target titles for the user")
    .option("--all", "include inactive titles")
    .action(async (opts: { all?: boolean }, cmd) => {
      await run(cmd.optsWithGlobals() as GlobalOpts, async (ctx) => {
        const rows = await listTargetTitles(ctx.db, requireUser(ctx), { activeOnly: !opts.all });
        output(ctx, rows, (ts) => {
          for (const t of ts) console.log(`${t.id}  ${t.is_active ? "●" : "○"} ${t.title}`);
        });
      });
    });

  titles
    .command("add")
    .description("Add a target title")
    .argument("<title>", "job title to search under")
    .action(async (title: string, _opts, cmd) => {
      await run(cmd.optsWithGlobals() as GlobalOpts, async (ctx) => {
        const t = await addTargetTitle(ctx.db, requireUser(ctx), title);
        output(ctx, t, (x) => console.log(`added ${x.id}: ${x.title}`));
      });
    });

  titles
    .command("rm")
    .description("Remove a target title by id")
    .argument("<id>", "target-title id")
    .action(async (id: string, _opts, cmd) => {
      await run(cmd.optsWithGlobals() as GlobalOpts, async (ctx) => {
        await removeTargetTitle(ctx.db, id);
        output(ctx, { removed: id }, () => console.log(`removed ${id}`));
      });
    });
}
