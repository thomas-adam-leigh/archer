import { describe, expect, test } from "vitest";
import { formatRun, scheduleCadence } from "#/lib/next-run.ts";

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

describe("formatRun", () => {
	const now = at(2026, 6, 24, 9, 0); // Wed 2026-06-24, 09:00 local

	test("same calendar day → Today + the local time", () => {
		expect(formatRun(at(2026, 6, 24, 6, 0), now)).toEqual({
			label: "Today",
			time: "06:00",
		});
	});

	test("the next day → Tomorrow", () => {
		expect(formatRun(at(2026, 6, 25, 8, 30), now)).toEqual({
			label: "Tomorrow",
			time: "08:30",
		});
	});

	test("the previous day → Yesterday (a past last-run)", () => {
		expect(formatRun(at(2026, 6, 23, 8, 2), now)).toEqual({
			label: "Yesterday",
			time: "08:02",
		});
	});

	test("a further-off weekday uses its name", () => {
		// Mon 2026-06-29 is several days ahead → the weekday name, not Today/Tomorrow.
		expect(formatRun(at(2026, 6, 29, 8, 0), now)).toEqual({
			label: "Monday",
			time: "08:00",
		});
	});

	test("renders the real minutes, not a hardcoded :00", () => {
		expect(formatRun(at(2026, 6, 24, 8, 45), now).time).toBe("08:45");
	});
});

describe("scheduleCadence", () => {
	test("a weekday cron (dow 1-5) reads 'every weekday' at the local run time", () => {
		expect(scheduleCadence("0 6 * * 1-5", at(2026, 6, 24, 8, 0))).toBe(
			"Archer runs every weekday at 08:00, then rests.",
		);
	});

	test("a daily cron (dow *) reads 'every day'", () => {
		expect(scheduleCadence("0 6 * * *", at(2026, 6, 24, 8, 0))).toBe(
			"Archer runs every day at 08:00, then rests.",
		);
	});

	test("the time comes from the run instant, in local time", () => {
		expect(scheduleCadence("30 5 * * 1-5", at(2026, 6, 24, 7, 30))).toBe(
			"Archer runs every weekday at 07:30, then rests.",
		);
	});
});
