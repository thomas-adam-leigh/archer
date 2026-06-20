import { createSchedulerDb } from "./db.js";
import { runCommand } from "./runner.js";
import { Scheduler } from "./scheduler.js";

const log = (msg: string) => console.log(`[scheduler] ${msg}`);

const db = createSchedulerDb();
const schedule = db.getSchedule();
log(
  `starting — every ${schedule.intervalMinutes} min, ` +
    `${schedule.enabled ? "enabled" : "disabled"}: ${schedule.command}`,
);

const scheduler = new Scheduler({ db, runCommand, log });
scheduler.start();

function shutdown(signal: string): void {
  log(`${signal} — stopping`);
  scheduler.stop();
  db.close();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
