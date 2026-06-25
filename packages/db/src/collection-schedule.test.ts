import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COLLECTION_CRON, cronNextFire, nextCollectionRunAt } from "./collection-schedule.js";

// cronNextFire is the heart of ARC-171's "real next run": pure over an injected `now`,
// so the weekday/weekend rollover is proven without faking the clock or a database.
describe("cronNextFire", () => {
  // 0 6 * * 1-5 = 06:00 UTC on weekdays — the declared collection schedule.
  it("returns later the same weekday when now is before the fire time", () => {
    // Wed 2026-06-24 05:00 UTC → same day 06:00.
    const next = cronNextFire(COLLECTION_CRON, new Date("2026-06-24T05:00:00.000Z"));
    expect(next.toISOString()).toBe("2026-06-24T06:00:00.000Z");
  });

  it("rolls to the next weekday once the day's fire time has passed", () => {
    // Wed 2026-06-24 07:00 UTC → Thu 06:00.
    const next = cronNextFire(COLLECTION_CRON, new Date("2026-06-24T07:00:00.000Z"));
    expect(next.toISOString()).toBe("2026-06-25T06:00:00.000Z");
  });

  it("skips the weekend: Friday-after-fire lands on Monday", () => {
    // Fri 2026-06-26 07:00 UTC → Mon 2026-06-29 06:00.
    const next = cronNextFire(COLLECTION_CRON, new Date("2026-06-26T07:00:00.000Z"));
    expect(next.toISOString()).toBe("2026-06-29T06:00:00.000Z");
  });

  it("skips the weekend: Saturday lands on Monday", () => {
    // Sat 2026-06-27 → Mon 2026-06-29 06:00.
    const next = cronNextFire(COLLECTION_CRON, new Date("2026-06-27T12:00:00.000Z"));
    expect(next.toISOString()).toBe("2026-06-29T06:00:00.000Z");
  });

  it("is strictly after now: exactly at the fire time returns the next occurrence", () => {
    // Wed 06:00 exactly → Thu 06:00 (strictly-after).
    const next = cronNextFire(COLLECTION_CRON, new Date("2026-06-24T06:00:00.000Z"));
    expect(next.toISOString()).toBe("2026-06-25T06:00:00.000Z");
  });

  it("supports lists, ranges and steps in arbitrary expressions", () => {
    // Every 15 minutes: 2026-06-24T05:07 → 05:15.
    expect(cronNextFire("*/15 * * * *", new Date("2026-06-24T05:07:00.000Z")).toISOString()).toBe(
      "2026-06-24T05:15:00.000Z",
    );
    // A fixed daily time, any day: 30 9 * * * from 09:45 → next day 09:30.
    expect(cronNextFire("30 9 * * *", new Date("2026-06-24T09:45:00.000Z")).toISOString()).toBe(
      "2026-06-25T09:30:00.000Z",
    );
  });

  it("rejects a malformed (non-5-field) expression", () => {
    expect(() => cronNextFire("0 6 * *", new Date())).toThrow();
  });

  it("nextCollectionRunAt uses the declared COLLECTION_CRON", () => {
    const now = new Date("2026-06-24T05:00:00.000Z");
    expect(nextCollectionRunAt(now).toISOString()).toBe(
      cronNextFire(COLLECTION_CRON, now).toISOString(),
    );
  });
});

// The API serves COLLECTION_CRON as the dashboard's schedule; the pg_cron migration
// must schedule the SAME expression, or the dashboard would report a time the cron
// doesn't actually run at. Assert the latest migration that (re)schedules
// `archer-collect-daily` uses exactly COLLECTION_CRON — the DoD's "the served schedule
// equals the runner's actual cron", checked mechanically so the two can't drift.
describe("declared schedule ↔ pg_cron migration", () => {
  it("the latest archer-collect-daily schedule equals COLLECTION_CRON", () => {
    const migrationsDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "supabase",
      "migrations",
    );
    const scheduleRe = /cron\.schedule\(\s*'archer-collect-daily'\s*,\s*'([^']+)'/g;
    let latest: string | undefined;
    for (const file of readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      for (const m of sql.matchAll(scheduleRe)) latest = m[1];
    }
    expect(latest).toBe(COLLECTION_CRON);
  });
});
