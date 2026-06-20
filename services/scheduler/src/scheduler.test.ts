import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSchedulerDb, DEFAULT_INTERVAL_MINUTES, type SchedulerDb } from "./db.js";
import { msUntilAlignedBoundary, Scheduler, tick } from "./scheduler.js";

let db: SchedulerDb;

beforeEach(() => {
  db = createSchedulerDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("msUntilAlignedBoundary", () => {
  it("aligns a 30-minute interval to the next :00/:30", () => {
    // 11:06:49 → next boundary 11:30:00 (24 min 11 s away)
    expect(msUntilAlignedBoundary(30, new Date(2026, 5, 20, 11, 6, 49))).toBe(
      ((30 - 6) * 60 - 49) * 1000,
    );
    // 11:36:00 → next boundary 12:00:00 (24 min away)
    expect(msUntilAlignedBoundary(30, new Date(2026, 5, 20, 11, 36, 0))).toBe(24 * 60_000);
  });

  it("returns a full step when exactly on a boundary (never 0)", () => {
    expect(msUntilAlignedBoundary(30, new Date(2026, 5, 20, 11, 0, 0))).toBe(30 * 60_000);
  });

  it("aligns a 15-minute interval to quarter hours", () => {
    // 11:05 → next 11:15 (10 min away)
    expect(msUntilAlignedBoundary(15, new Date(2026, 5, 20, 11, 5, 0))).toBe(10 * 60_000);
  });

  it("falls back to the default interval for invalid values", () => {
    const now = new Date(2026, 5, 20, 11, 0, 0);
    expect(msUntilAlignedBoundary(0, now)).toBe(DEFAULT_INTERVAL_MINUTES * 60_000);
    expect(msUntilAlignedBoundary(Number.NaN, now)).toBe(DEFAULT_INTERVAL_MINUTES * 60_000);
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
  it("schedules the first tick at the next aligned wall-clock boundary", () => {
    db.setSchedule({ intervalMinutes: 30 });
    const now = new Date(2026, 5, 20, 11, 6, 49);
    const setTimer = vi.fn().mockReturnValue(1 as unknown as ReturnType<typeof setTimeout>);
    const runCommand = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    const scheduler = new Scheduler({
      db,
      runCommand,
      setTimer,
      clearTimer: vi.fn(),
      now: () => now,
    });
    scheduler.start();

    expect(setTimer).toHaveBeenCalledTimes(1);
    expect(setTimer.mock.calls[0]?.[1]).toBe(msUntilAlignedBoundary(30, now)); // → 11:30:00
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
