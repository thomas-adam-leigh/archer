import { DEFAULT_INTERVAL_MINUTES, type RunResult, type SchedulerDb } from "./db.js";

/** Convert a configured interval (minutes) to a timer delay (ms), guarding bad values. */
export function nextDelayMs(intervalMinutes: number): number {
  const minutes =
    Number.isFinite(intervalMinutes) && intervalMinutes > 0
      ? intervalMinutes
      : DEFAULT_INTERVAL_MINUTES;
  return minutes * 60_000;
}

/**
 * Run a single tick: read the current schedule and, if enabled, execute its
 * command and record the run. Returns the run's id, or `null` when the schedule
 * is disabled (nothing ran). Re-reading the schedule here is what lets live
 * config edits take effect on the very next tick.
 */
export async function tick(
  db: SchedulerDb,
  runCommand: (command: string) => Promise<RunResult>,
  log: (msg: string) => void = () => {},
): Promise<number | null> {
  const schedule = db.getSchedule();
  if (!schedule.enabled) {
    log("disabled — skipping tick");
    return null;
  }
  const id = db.startRun(schedule.command);
  log(`run #${id}: ${schedule.command}`);
  const result = await runCommand(schedule.command);
  db.finishRun(id, result);
  log(`run #${id} finished (exit ${result.code})`);
  return id;
}

export interface SchedulerDeps {
  db: SchedulerDb;
  runCommand: (command: string) => Promise<RunResult>;
  /** Injectable timer (defaults to setTimeout) so the loop is testable. */
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
  log?: (msg: string) => void;
}

/**
 * The recurring loop. Uses a recursive timer (not setInterval) so each cycle
 * re-reads the interval from the DB and runs never overlap: the next tick is
 * scheduled only after the current one settles.
 */
export class Scheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly setTimer: NonNullable<SchedulerDeps["setTimer"]>;
  private readonly clearTimer: NonNullable<SchedulerDeps["clearTimer"]>;
  private readonly log: (msg: string) => void;

  constructor(private readonly deps: SchedulerDeps) {
    this.setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t));
    this.log = deps.log ?? (() => {});
  }

  /** Begin the loop. The first tick fires after one interval, not immediately. */
  start(): void {
    this.stopped = false;
    this.scheduleNext();
  }

  /** Stop the loop. Any in-flight tick still completes; no new one is scheduled. */
  stop(): void {
    this.stopped = true;
    if (this.timer) this.clearTimer(this.timer);
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const delay = nextDelayMs(this.deps.db.getSchedule().intervalMinutes);
    this.timer = this.setTimer(() => {
      void this.runAndReschedule();
    }, delay);
  }

  private async runAndReschedule(): Promise<void> {
    try {
      await tick(this.deps.db, this.deps.runCommand, this.log);
    } catch (err) {
      this.log(`tick error: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.scheduleNext();
  }
}
