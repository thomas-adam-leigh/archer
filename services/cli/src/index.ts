#!/usr/bin/env node
import { Command } from "commander";
import { api, apiBaseUrl } from "./api.js";
import { registerApply } from "./commands/apply.js";
import { registerBoards } from "./commands/boards.js";
import { registerCollect } from "./commands/collect.js";
import { registerCriteria } from "./commands/criteria.js";
import { registerEnrich } from "./commands/enrich.js";
import { registerJobs } from "./commands/jobs.js";
import { registerMatch } from "./commands/match.js";
import { registerProfile } from "./commands/profile.js";
import { registerTitles } from "./commands/titles.js";
import { CliError } from "./context.js";

const program = new Command();

program
  .name("archer")
  .description("Archer CLI — collect, apply, and manage the job pipeline")
  .version("0.1.0")
  .option("--json", "machine-readable JSON output", false)
  .option("--user <id>", "user id for user-scoped commands (default: $ARCHER_USER_ID)");

registerCollect(program);
registerBoards(program);
registerTitles(program);
registerCriteria(program);
registerProfile(program);
registerJobs(program);
registerMatch(program);
registerEnrich(program);
registerApply(program);

program
  .command("health")
  .description("Check the API health via typed RPC")
  .action(async () => {
    try {
      const res = await api.health.$get();
      const data = await res.json();
      console.log(`API status: ${data.status}`);
    } catch {
      console.error(`archer: failed to reach API at ${apiBaseUrl}`);
      process.exitCode = 1;
    }
  });

program.parseAsync().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  if (program.opts().json) {
    console.error(JSON.stringify({ error: msg }));
  } else {
    console.error(`archer: ${msg}`);
  }
  process.exitCode = err instanceof CliError ? 2 : 1;
});
