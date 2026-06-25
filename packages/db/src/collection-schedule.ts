/**
 * The single declared collection schedule (ARC-171).
 *
 * Collection fires once every weekday at 08:00 SAST = 06:00 UTC. This constant is the
 * source of truth the API serves as the dashboard's real "next run" — replacing the
 * hardcoded fiction ARC-172 removes. The `archer-collect-daily` pg_cron migration
 * schedules the SAME expression (collection-schedule.test.ts asserts the latest
 * migration and this constant agree, so the served schedule can't drift from the cron
 * it reports), and the host collection runner's crontab (ARC-170) is aligned to it.
 */
export const COLLECTION_CRON = "0 6 * * 1-5";

/** Expand one cron field (e.g. "1-5", "*", "0,30", "*\/2") to its allowed values. */
function expandField(spec: string, min: number, max: number): number[] {
  const values = new Set<number>();
  for (const part of spec.split(",")) {
    const [range, stepRaw] = part.split("/");
    const step = stepRaw ? Number.parseInt(stepRaw, 10) : 1;
    let lo = min;
    let hi = max;
    if (range !== "*") {
      const [a, b] = range.split("-");
      lo = Number.parseInt(a, 10);
      hi = b === undefined ? lo : Number.parseInt(b, 10);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
}

/**
 * The next instant (UTC) a standard 5-field cron expression fires strictly after
 * `now`. Pure (a `now` is passed in) so the rollover is unit-tested without faking
 * the clock. Supports `*`, ranges, lists and steps per field, and the standard
 * "match either" rule when both day-of-month and day-of-week are restricted. pg_cron
 * fires in the server timezone (UTC on Supabase), so this computes in UTC to match.
 */
export function cronNextFire(cron: string, now: Date): Date {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`expected a 5-field cron, got "${cron}"`);
  const [minF, hourF, domF, monF, dowF] = fields;
  const minutes = expandField(minF, 0, 59);
  const hours = expandField(hourF, 0, 23);
  const months = new Set(expandField(monF, 1, 12));
  const domStar = domF === "*";
  const dowStar = dowF === "*";
  const doms = new Set(expandField(domF, 1, 31));
  // cron day-of-week is 0–6 (0=Sunday); 7 is also Sunday, so fold it onto 0.
  const dows = new Set(expandField(dowF, 0, 6).map((d) => d % 7));

  const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // A standard cron always fires within a year; the bound is just a safety net.
  for (let day = 0; day < 366; day += 1) {
    if (months.has(cursor.getUTCMonth() + 1)) {
      const domOk = doms.has(cursor.getUTCDate());
      const dowOk = dows.has(cursor.getUTCDay());
      const dayOk = domStar && dowStar ? true : domStar ? dowOk : dowStar ? domOk : domOk || dowOk;
      if (dayOk) {
        for (const h of hours) {
          for (const m of minutes) {
            const at = new Date(
              Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), h, m),
            );
            if (at.getTime() > now.getTime()) return at;
          }
        }
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  throw new Error(`no cron fire within a year for "${cron}"`);
}

/** The next collection run (UTC) strictly after `now`, per the declared schedule. */
export function nextCollectionRunAt(now: Date): Date {
  return cronNextFire(COLLECTION_CRON, now);
}
