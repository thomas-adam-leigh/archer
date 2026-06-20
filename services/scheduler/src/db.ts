import Database from "better-sqlite3";

/** Default tick interval, in minutes. */
export const DEFAULT_INTERVAL_MINUTES = 30;

/** Default command: feed the tracked prompt file to `claude -p` via @-reference. */
export const DEFAULT_COMMAND = 'claude -p "@./services/scheduler/prompt.md"';

/** Where the SQLite file lives, unless overridden by `SCHEDULER_DB_PATH`. */
export const DEFAULT_DB_PATH = "services/scheduler/scheduler.db";

/** The single, operator-settable schedule config. */
export interface Schedule {
  intervalMinutes: number;
  command: string;
  enabled: boolean;
  updatedAt: string | null;
}

/** The captured result of running a command. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** One recorded execution from the audit log. */
export interface RunRecord {
  id: number;
  command: string;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
}

/** The data layer — config + run history. No scheduling or process logic here. */
export interface SchedulerDb {
  getSchedule(): Schedule;
  setSchedule(patch: Partial<Pick<Schedule, "intervalMinutes" | "command" | "enabled">>): Schedule;
  startRun(command: string): number;
  finishRun(id: number, result: RunResult): void;
  listRuns(limit?: number): RunRecord[];
  close(): void;
}

interface ScheduleRow {
  interval_minutes: number;
  command: string;
  enabled: number;
  updated_at: string | null;
}

interface RunRow {
  id: number;
  command: string;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  stdout: string | null;
  stderr: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schedule (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  interval_minutes INTEGER NOT NULL DEFAULT ${DEFAULT_INTERVAL_MINUTES},
  command          TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1,
  updated_at       TEXT
);
CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  command     TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  exit_code   INTEGER,
  stdout      TEXT,
  stderr      TEXT
);
`;

const toSchedule = (row: ScheduleRow): Schedule => ({
  intervalMinutes: row.interval_minutes,
  command: row.command,
  enabled: row.enabled === 1,
  updatedAt: row.updated_at,
});

const toRun = (row: RunRow): RunRecord => ({
  id: row.id,
  command: row.command,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  exitCode: row.exit_code,
  stdout: row.stdout,
  stderr: row.stderr,
});

/**
 * Open (and, on first use, create + seed) the scheduler database.
 *
 * @param path filesystem path, or `:memory:` for tests. Defaults to
 *   `SCHEDULER_DB_PATH`, then {@link DEFAULT_DB_PATH}.
 */
export function createSchedulerDb(path?: string): SchedulerDb {
  const file = path ?? process.env.SCHEDULER_DB_PATH ?? DEFAULT_DB_PATH;
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  // Seed the single config row exactly once; later opens leave it untouched.
  db.prepare(
    "INSERT OR IGNORE INTO schedule (id, interval_minutes, command, enabled, updated_at) VALUES (1, ?, ?, 1, ?)",
  ).run(DEFAULT_INTERVAL_MINUTES, DEFAULT_COMMAND, new Date().toISOString());

  return {
    getSchedule(): Schedule {
      const row = db.prepare("SELECT * FROM schedule WHERE id = 1").get() as ScheduleRow;
      return toSchedule(row);
    },

    setSchedule(patch): Schedule {
      const current = this.getSchedule();
      const next: Schedule = {
        intervalMinutes: patch.intervalMinutes ?? current.intervalMinutes,
        command: patch.command ?? current.command,
        enabled: patch.enabled ?? current.enabled,
        updatedAt: new Date().toISOString(),
      };
      db.prepare(
        "UPDATE schedule SET interval_minutes = ?, command = ?, enabled = ?, updated_at = ? WHERE id = 1",
      ).run(next.intervalMinutes, next.command, next.enabled ? 1 : 0, next.updatedAt);
      return next;
    },

    startRun(command): number {
      const info = db
        .prepare("INSERT INTO runs (command, started_at) VALUES (?, ?)")
        .run(command, new Date().toISOString());
      return Number(info.lastInsertRowid);
    },

    finishRun(id, result): void {
      db.prepare(
        "UPDATE runs SET finished_at = ?, exit_code = ?, stdout = ?, stderr = ? WHERE id = ?",
      ).run(new Date().toISOString(), result.code, result.stdout, result.stderr, id);
    },

    listRuns(limit = 20): RunRecord[] {
      const rows = db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT ?").all(limit) as RunRow[];
      return rows.map(toRun);
    },

    close(): void {
      db.close();
    },
  };
}
