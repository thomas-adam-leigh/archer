import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSchedulerDb,
  DEFAULT_COMMAND,
  DEFAULT_INTERVAL_MINUTES,
  type SchedulerDb,
} from "./db.js";

let db: SchedulerDb;

beforeEach(() => {
  db = createSchedulerDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("createSchedulerDb", () => {
  it("seeds a default schedule on first open", () => {
    const s = db.getSchedule();
    expect(s.intervalMinutes).toBe(DEFAULT_INTERVAL_MINUTES);
    expect(s.command).toBe(DEFAULT_COMMAND);
    expect(s.enabled).toBe(true);
  });

  it("setSchedule updates only the given fields", () => {
    db.setSchedule({ intervalMinutes: 5 });
    expect(db.getSchedule().intervalMinutes).toBe(5);
    expect(db.getSchedule().command).toBe(DEFAULT_COMMAND);

    db.setSchedule({ command: "echo hi", enabled: false });
    const s = db.getSchedule();
    expect(s.intervalMinutes).toBe(5);
    expect(s.command).toBe("echo hi");
    expect(s.enabled).toBe(false);
    expect(s.updatedAt).not.toBeNull();
  });

  it("records and lists runs newest-first", () => {
    const id1 = db.startRun("echo a");
    db.finishRun(id1, { code: 0, stdout: "a\n", stderr: "" });
    const id2 = db.startRun("echo b");

    const runs = db.listRuns();
    expect(runs).toHaveLength(2);
    expect(runs[0]?.id).toBe(id2);
    expect(runs[0]?.finishedAt).toBeNull(); // still running
    expect(runs[1]?.id).toBe(id1);
    expect(runs[1]?.exitCode).toBe(0);
    expect(runs[1]?.stdout).toBe("a\n");
  });

  it("respects the listRuns limit", () => {
    for (let i = 0; i < 5; i++) db.startRun(`echo ${i}`);
    expect(db.listRuns(2)).toHaveLength(2);
  });
});
