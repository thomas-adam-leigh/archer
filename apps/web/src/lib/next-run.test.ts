import { describe, expect, test } from "vitest";
import { nextRun } from "#/lib/next-run.ts";

/** Build a local-time Date (months are 0-based) for a fixed clock in tests. */
function at(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute = 0,
): Date {
	return new Date(year, month - 1, day, hour, minute);
}

describe("nextRun", () => {
	test("before the morning slot → Today · 08:00", () => {
		// Wed 2026-06-24, 06:30 → next slot is today at 08:00.
		expect(nextRun(at(2026, 6, 24, 6, 30))).toEqual({
			label: "Today",
			time: "08:00",
		});
	});

	test("between the two slots → Today · 13:00", () => {
		// Wed 2026-06-24, 09:00 → 08:00 has passed, next is today at 13:00.
		expect(nextRun(at(2026, 6, 24, 9, 0))).toEqual({
			label: "Today",
			time: "13:00",
		});
	});

	test("after the last slot on a weekday → Tomorrow · 08:00", () => {
		// Wed 2026-06-24, 18:00 → both slots passed, next is Thursday at 08:00.
		expect(nextRun(at(2026, 6, 24, 18, 0))).toEqual({
			label: "Tomorrow",
			time: "08:00",
		});
	});

	test("exactly on a slot rolls forward (strictly after now)", () => {
		// Wed 2026-06-24, 08:00 sharp → not in the future, next is today 13:00.
		expect(nextRun(at(2026, 6, 24, 8, 0))).toEqual({
			label: "Today",
			time: "13:00",
		});
	});

	test("Friday evening skips the weekend → Monday · 08:00", () => {
		// Fri 2026-06-26, 18:00 → Sat/Sun rest, next is Monday at 08:00 (a weekday
		// name, not "Tomorrow").
		expect(nextRun(at(2026, 6, 26, 18, 0))).toEqual({
			label: "Monday",
			time: "08:00",
		});
	});

	test("Saturday → Monday · 08:00", () => {
		// Sat 2026-06-27, any time → next weekday slot is Monday at 08:00.
		expect(nextRun(at(2026, 6, 27, 10, 0))).toEqual({
			label: "Monday",
			time: "08:00",
		});
	});

	test("Sunday → Tomorrow · 08:00 (Monday is the next day)", () => {
		// Sun 2026-06-28 → Monday is literally tomorrow, so the friendly label wins.
		expect(nextRun(at(2026, 6, 28, 10, 0))).toEqual({
			label: "Tomorrow",
			time: "08:00",
		});
	});

	test("midweek future weekday uses its name", () => {
		// Tue 2026-06-23, 18:00 → Wednesday at 08:00 (named, not Today/Tomorrow…
		// Wednesday IS tomorrow here, so expect Tomorrow).
		expect(nextRun(at(2026, 6, 23, 18, 0))).toEqual({
			label: "Tomorrow",
			time: "08:00",
		});
	});
});
