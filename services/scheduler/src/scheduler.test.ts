import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSchedulerDb, DEFAULT_INTERVAL_MINUTES, type SchedulerDb } from "./db.js";
import { nextDelayMs, Scheduler, tick } from "./scheduler.js";

let db: SchedulerDb;

beforeEach(() => {
  db = createSchedulerDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("nextDelayMs", () => {
  it("converts minutes to milliseconds", () => {
    expect(nextDelayMs(30)).toBe(30 * 60_000);
    expect(nextDelayMs(1)).toBe(60_000);
  });

  it("falls back to the default for non-positive or invalid values", () => {
    const fallback = DEFAULT_INTERVAL_MINUTES * 60_000;
    expect(nextDelayMs(0)).toBe(fallback);
    expect(nextDelayMs(-5)).toBe(fallback);
    expect(nextDelayMs(Number.NaN)).toBe(fallback);
  });
});

describe("tick", () => {
  it("runs the configured command and records the run when enabled", async () => {
    db.setSchedule({ command: "echo from-tick" });
    const runCommand = vi.fn().mockResolvedValue({ code: 0, stdout: "from-tick\n", stderr: "" });

    const id = await tick(db, runCommand);

    expect(runCommand).toHaveBeenCalledWith("echo from-tick");
    expect(id).not.toBeNull();
    const [run] = db.listRuns(1);
    expect(run?.command).toBe("echo from-tick");
    expect(run?.exitCode).toBe(0);
    expect(run?.stdout).toBe("from-tick\n");
  });

  it("skips and records nothing when disabled", async () => {
    db.setSchedule({ enabled: false });
    const runCommand = vi.fn();

    const id = await tick(db, runCommand);

    expect(id).toBeNull();
    expect(runCommand).not.toHaveBeenCalled();
    expect(db.listRuns()).toHaveLength(0);
  });
});

describe("Scheduler loop", () => {
  it("schedules the first tick using the configured interval", () => {
    db.setSchedule({ intervalMinutes: 7 });
    const setTimer = vi.fn().mockReturnValue(1 as unknown as ReturnType<typeof setTimeout>);
    const runCommand = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    const scheduler = new Scheduler({ db, runCommand, setTimer, clearTimer: vi.fn() });
    scheduler.start();

    expect(setTimer).toHaveBeenCalledTimes(1);
    expect(setTimer.mock.calls[0]?.[1]).toBe(7 * 60_000);
  });

  it("runs the command when its timer fires, then reschedules", async () => {
    let fire: (() => void) | undefined;
    const setTimer = vi.fn((cb: () => void) => {
      fire = cb;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    const runCommand = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    const scheduler = new Scheduler({ db, runCommand, setTimer, clearTimer: vi.fn() });
    scheduler.start();

    expect(fire).toBeDefined();
    fire?.();
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledTimes(1));
    // After the tick settles, a second timer is queued for the next cycle.
    await vi.waitFor(() => expect(setTimer).toHaveBeenCalledTimes(2));
  });

  it("stops scheduling after stop()", () => {
    const clearTimer = vi.fn();
    const setTimer = vi.fn().mockReturnValue(42 as unknown as ReturnType<typeof setTimeout>);
    const runCommand = vi.fn();

    const scheduler = new Scheduler({ db, runCommand, setTimer, clearTimer });
    scheduler.start();
    scheduler.stop();

    expect(clearTimer).toHaveBeenCalledWith(42);
  });
});
