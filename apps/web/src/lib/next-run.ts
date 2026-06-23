/**
 * Archer's run schedule — when the next weekday sweep fires.
 *
 * Archer runs every weekday (Mon–Fri) at 08:00 and 13:00, then rests. The home
 * screen shows the next upcoming slot as a friendly "{label} · {time}" (e.g.
 * "Today · 13:00", "Tomorrow · 08:00", "Thursday · 08:00"). Ported verbatim from
 * the design spec's `nextRunText`/`fmtRun`, kept pure (a `now` is passed in) so
 * the rollover logic is unit-tested without faking the clock.
 */

/** The weekday hours (24h) Archer sweeps the boards. */
const RUN_HOURS = [8, 13] as const;

const DAY_NAMES = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
] as const;

/** A formatted next-run slot for display. */
export interface NextRun {
	/** "Today", "Tomorrow", or the weekday name (e.g. "Thursday"). */
	label: string;
	/** Zero-padded 24h time, e.g. "08:00". */
	time: string;
}

function isWeekday(day: number): boolean {
	return day >= 1 && day <= 5;
}

function sameDay(a: Date, b: Date): boolean {
	return a.toDateString() === b.toDateString();
}

/** Format a resolved run instant relative to `now` (Today/Tomorrow/weekday). */
function format(run: Date, now: Date): NextRun {
	const tomorrow = new Date(now);
	tomorrow.setDate(now.getDate() + 1);
	const label = sameDay(run, now)
		? "Today"
		: sameDay(run, tomorrow)
			? "Tomorrow"
			: DAY_NAMES[run.getDay()];
	return { label, time: `${String(run.getHours()).padStart(2, "0")}:00` };
}

/**
 * The next weekday run slot strictly after `now`. Scans forward day by day (up to
 * two weeks, which always lands on a weekday) and returns the first 08:00/13:00
 * slot in the future; the two-week bound can't realistically be hit, so it falls
 * back to the canonical Monday 08:00.
 */
export function nextRun(now: Date): NextRun {
	const cursor = new Date(now);
	for (let ahead = 0; ahead < 14; ahead += 1) {
		if (isWeekday(cursor.getDay())) {
			for (const hour of RUN_HOURS) {
				const slot = new Date(cursor);
				slot.setHours(hour, 0, 0, 0);
				if (slot > now) return format(slot, now);
			}
		}
		cursor.setDate(cursor.getDate() + 1);
		cursor.setHours(0, 0, 0, 0);
	}
	return { label: "Monday", time: "08:00" };
}
