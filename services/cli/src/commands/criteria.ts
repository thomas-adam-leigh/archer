import { addNegativeCriterion, listNegativeCriteria, removeNegativeCriterion } from "@archer/db";
import type { Command } from "commander";
import { type GlobalOpts, output, requireUser, run } from "../context.js";

export function registerCriteria(program: Command): void {
  const criteria = program
    .command("criteria")
    .description("Manage negative criteria (the deal-breakers match/readiness key on)");

  criteria
    .command("list")
    .description("List negative criteria for the user")
    .action(async (_opts, cmd) => {
      await run(cmd.optsWithGlobals() as GlobalOpts, async (ctx) => {
        const rows = await listNegativeCriteria(ctx.db, requireUser(ctx));
        output(ctx, rows, (cs) => {
          for (const c of cs) console.log(`${c.id}  ${c.text}`);
        });
      });
    });

  criteria
    .command("add")
    .description("Add a negative criterion")
    .argument("<text>", "deal-breaker text")
    .action(async (text: string, _opts, cmd) => {
      await run(cmd.optsWithGlobals() as GlobalOpts, async (ctx) => {
        const c = await addNegativeCriterion(ctx.db, requireUser(ctx), text);
        output(ctx, c, (x) => console.log(`added ${x.id}: ${x.text}`));
      });
    });

  criteria
    .command("rm")
    .description("Remove a negative criterion by id")
    .argument("<id>", "negative-criterion id")
    .action(async (id: string, _opts, cmd) => {
      await run(cmd.optsWithGlobals() as GlobalOpts, async (ctx) => {
        await removeNegativeCriterion(ctx.db, id);
        output(ctx, { removed: id }, () => console.log(`removed ${id}`));
      });
    });
}
