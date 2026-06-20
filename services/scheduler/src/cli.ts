#!/usr/bin/env node
import { Command } from "commander";
import { createSchedulerDb } from "./db.js";

/** Open the db, run a callback, and always close. */
function withDb<T>(fn: (db: ReturnType<typeof createSchedulerDb>) => T): T {
  const db = createSchedulerDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const program = new Command();
program
  .name("archer-scheduler")
  .description("Configure the Archer scheduler (interval, command, enabled) and inspect runs.");

program
  .command("status")
  .description("Show the current schedule and the most recent run")
  .action(() => {
    withDb((db) => {
      const s = db.getSchedule();
      console.log(`interval : ${s.intervalMinutes} min`);
      console.log(`command  : ${s.command}`);
      console.log(`enabled  : ${s.enabled}`);
      console.log(`updated  : ${s.updatedAt ?? "—"}`);
      const [last] = db.listRuns(1);
      if (last) {
        console.log(
          `last run : #${last.id} started ${last.startedAt}, ` +
            `${last.finishedAt ? `exit ${last.exitCode}` : "in progress"}`,
        );
      }
    });
  });

program
  .command("set-interval <minutes>")
  .description("Set the tick interval, in minutes")
  .action((minutes: string) => {
    const n = Number(minutes);
    if (!Number.isInteger(n) || n <= 0) {
      console.error(`invalid interval: ${minutes} (must be a positive integer)`);
      process.exitCode = 1;
      return;
    }
    withDb((db) => db.setSchedule({ intervalMinutes: n }));
    console.log(`interval set to ${n} min`);
  });

program
  .command("set-command <command>")
  .description(
    "Set the command to run each tick (e.g. 'claude -p \"@./services/scheduler/prompt.md\"')",
  )
  .action((command: string) => {
    withDb((db) => db.setSchedule({ command }));
    console.log(`command set to: ${command}`);
  });

program
  .command("enable")
  .description("Enable the schedule")
  .action(() => {
    withDb((db) => db.setSchedule({ enabled: true }));
    console.log("enabled");
  });

program
  .command("disable")
  .description("Disable the schedule (ticks are skipped)")
  .action(() => {
    withDb((db) => db.setSchedule({ enabled: false }));
    console.log("disabled");
  });

program
  .command("runs")
  .description("List recent runs")
  .option("-l, --limit <n>", "how many to show", "20")
  .action((opts: { limit: string }) => {
    withDb((db) => {
      const runs = db.listRuns(Number(opts.limit));
      if (runs.length === 0) {
        console.log("no runs yet");
        return;
      }
      for (const r of runs) {
        const status = r.finishedAt ? `exit ${r.exitCode}` : "running";
        console.log(`#${r.id}  ${r.startedAt}  ${status}  ${r.command}`);
      }
    });
  });

program.parse();
