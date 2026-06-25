/**
 * Formatting for Archer's real run schedule (ARC-172).
 *
 * The schedule is no longer guessed in the client — the API serves the one
 * declared collection schedule (ARC-171: `GET /collection/schedule` →
 * { schedule, nextRunAt, lastRunAt }). These pure helpers turn those instants and
 * the cron string into the friendly copy the home card shows, in the user's local
 * timezone. Kept pure (a `now` is passed in) so the relative-day logic is
 * unit-tested without faking the clock.
 */

const DAY_NAMES = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
] as const;

/** A formatted run instant for display ("Today · 08:00"). */
export interface NextRun {
	/** "Today", "Tomorrow", "Yesterday", or the weekday name (e.g. "Thursday"). */
	label: string;
	/** Zero-padded 24h local time, e.g. "08:00". */
	time: string;
}

/** The zero-padded 24h local time of an instant. */
function timeOf(at: Date): string {
	return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/** The local calendar day an instant falls on (midnight, local). */
function startOfDay(at: Date): number {
	return new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
}

/**
 * Format a real run instant relative to `now`, in local time: Today / Tomorrow /
 * Yesterday for the adjacent days, otherwise the weekday name. Works for both the
 * upcoming next run and the most recent last run.
 */
export function formatRun(at: Date, now: Date): NextRun {
	const days = Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000);
	const label =
		days === 0
			? "Today"
			: days === 1
				? "Tomorrow"
				: days === -1
					? "Yesterday"
					: DAY_NAMES[at.getDay()];
	return { label, time: timeOf(at) };
}

/**
 * The cadence sentence under the next run, derived from the declared cron's
 * day-of-week field and the local time of the upcoming run — so it stays truthful
 * to whatever schedule the API reports (e.g. weekday `1-5` → "every weekday").
 */
export function scheduleCadence(cron: string, runAt: Date): string {
	const dow = cron.trim().split(/\s+/)[4] ?? "*";
	const cadence =
		dow === "1-5" ? "every weekday" : dow === "*" ? "every day" : "on schedule";
	return `Archer runs ${cadence} at ${timeOf(runAt)}, then rests.`;
}
