import { describe, expect, test } from "vitest";
import {
	type ActivityItem,
	activityFeed,
	activityFeedItem,
	boardCollectState,
	type DailyRun,
	type DailyRunBoard,
	dailyRunHeadline,
	researchingNow,
	runTrailLines,
} from "#/lib/dashboard.ts";

/** A daily-run board row with sensible defaults the tests override per case. */
function board(over: Partial<DailyRunBoard> = {}): DailyRunBoard {
	return {
		activityId: "act-1",
		board: "pnet",
		status: "succeeded",
		outcome: "found",
		scraped: 0,
		postingsNew: 0,
		candidaciesNew: 0,
		error: null,
		...over,
	};
}

/** A daily run with no boards (the launch default) the tests build on. */
function run(over: Partial<DailyRun> = {}): DailyRun {
	return {
		date: "2026-06-24",
		status: null,
		jobsNew: 0,
		postingsNew: 0,
		counts: {
			found: 0,
			nothing_today: 0,
			not_integrated: 0,
			failed: 0,
			collecting: 0,
		},
		boards: [],
		startedAt: null,
		finishedAt: null,
		...over,
	};
}

/** An activity row with succeeded-enrich defaults the tests override per case. */
function activity(over: Partial<ActivityItem> = {}): ActivityItem {
	return {
		id: "a-1",
		type: "enrich",
		status: "succeeded",
		detail: { company: "Stripe" },
		error: null,
		started_at: null,
		finished_at: null,
		created_at: "2026-06-24T08:00:00Z",
		...over,
	};
}

describe("boardCollectState", () => {
	test("integrated → Live", () => {
		expect(boardCollectState("integrated")).toEqual({
			label: "Live",
			tone: "live",
		});
	});
	test("not_integrated → Coming soon", () => {
		expect(boardCollectState("not_integrated")).toEqual({
			label: "Coming soon",
			tone: "soon",
		});
	});
	test("broken → Needs attention", () => {
		expect(boardCollectState("broken").tone).toBe("attention");
	});
});

describe("dailyRunHeadline", () => {
	test("no run today → null (the caller shows an empty state)", () => {
		expect(dailyRunHeadline(run())).toBeNull();
	});

	test("in-progress run reads as collecting", () => {
		expect(dailyRunHeadline(run({ status: "in_progress" }))).toBe(
			"Archer is collecting today's roles…",
		);
	});

	test("done with new roles across boards summarises the haul", () => {
		expect(
			dailyRunHeadline(
				run({
					status: "done",
					jobsNew: 6,
					counts: {
						found: 2,
						nothing_today: 0,
						not_integrated: 0,
						failed: 0,
						collecting: 0,
					},
				}),
			),
		).toBe("Collected today — 6 new roles across 2 boards.");
	});

	test("done with one new role + one not-integrated board names both", () => {
		expect(
			dailyRunHeadline(
				run({
					status: "done",
					jobsNew: 1,
					counts: {
						found: 1,
						nothing_today: 0,
						not_integrated: 1,
						failed: 0,
						collecting: 0,
					},
				}),
			),
		).toBe(
			"Collected today — 1 new role across 1 board; 1 board not integrated yet.",
		);
	});

	test("done with nothing found stays calm", () => {
		expect(
			dailyRunHeadline(
				run({
					status: "done",
					jobsNew: 0,
					counts: {
						found: 0,
						nothing_today: 2,
						not_integrated: 0,
						failed: 0,
						collecting: 0,
					},
				}),
			),
		).toBe("Searched today — no new roles yet.");
	});
});

describe("runTrailLines", () => {
	const name = (slug: string | null) =>
		slug === "careerjunction" ? "CareerJunction" : (slug ?? "Unknown");

	test("names each board and phrases its outcome", () => {
		const r = run({
			status: "done",
			boards: [
				board({
					activityId: "x1",
					board: "pnet",
					outcome: "found",
					candidaciesNew: 4,
				}),
				board({
					activityId: "x2",
					board: "careerjunction",
					outcome: "not_integrated",
				}),
			],
		});
		expect(runTrailLines(r, name)).toEqual([
			{
				activityId: "x1",
				board: "pnet",
				detail: "4 new roles",
				outcome: "found",
			},
			{
				activityId: "x2",
				board: "CareerJunction",
				detail: "not integrated yet",
				outcome: "not_integrated",
			},
		]);
	});

	test("phrases nothing-today, failed and in-flight boards", () => {
		const r = run({
			status: "in_progress",
			boards: [
				board({ activityId: "n", board: "indeed", outcome: "nothing_today" }),
				board({
					activityId: "f",
					board: "linkedin",
					outcome: "failed",
					status: "failed",
				}),
				board({
					activityId: "c",
					board: "pnet",
					outcome: "collecting",
					status: "in_progress",
				}),
			],
		});
		expect(runTrailLines(r, (s) => s ?? "?").map((l) => l.detail)).toEqual([
			"nothing new today",
			"run failed",
			"collecting…",
		]);
	});
});

describe("researchingNow", () => {
	test("surfaces in-flight enrich companies, deduped, newest first", () => {
		const items = [
			activity({
				id: "1",
				status: "in_progress",
				detail: { company: "Stripe" },
			}),
			activity({ id: "2", status: "queued", detail: { company: "Notion" } }),
			activity({
				id: "3",
				status: "in_progress",
				detail: { company: "Stripe" },
			}),
		];
		expect(researchingNow(items)).toEqual(["Stripe", "Notion"]);
	});

	test("ignores finished enrich runs and other in-flight types", () => {
		const items = [
			activity({ id: "1", status: "succeeded", detail: { company: "Stripe" } }),
			activity({
				id: "2",
				type: "collect",
				status: "in_progress",
				detail: { board: "pnet" },
			}),
		];
		expect(researchingNow(items)).toEqual([]);
	});
});

describe("activityFeedItem", () => {
	test("a succeeded enrich becomes a 'Researched …' row", () => {
		expect(
			activityFeedItem(activity({ detail: { company: "Stripe" } })),
		).toEqual({
			id: "a-1",
			label: "Researched Stripe",
			kind: "enrich",
		});
	});

	test("a succeeded apply names the company", () => {
		expect(
			activityFeedItem(
				activity({ type: "apply", detail: { company: "Notion" } }),
			),
		).toEqual({ id: "a-1", label: "Applied — Notion", kind: "apply" });
	});

	test("a succeeded cover_letter without a company stays generic", () => {
		expect(
			activityFeedItem(activity({ type: "cover_letter", detail: null })),
		).toEqual({
			id: "a-1",
			label: "Cover letter drafted",
			kind: "cover_letter",
		});
	});

	test("in-flight and operational rows are skipped", () => {
		expect(activityFeedItem(activity({ status: "in_progress" }))).toBeNull();
		expect(activityFeedItem(activity({ type: "transcribe" }))).toBeNull();
		expect(
			activityFeedItem(activity({ type: "apply", status: "failed" })),
		).toBeNull();
	});
});

describe("activityFeed", () => {
	test("keeps only candidate-facing rows, capped, newest first", () => {
		const items = [
			activity({ id: "1", type: "apply", detail: { company: "Stripe" } }),
			activity({ id: "2", status: "in_progress" }), // dropped (in-flight)
			activity({ id: "3", type: "match" }),
			activity({ id: "4", type: "deploy" }), // dropped (operational)
		];
		expect(activityFeed(items).map((i) => i.id)).toEqual(["1", "3"]);
	});

	test("respects the limit", () => {
		const items = Array.from({ length: 10 }, (_, i) =>
			activity({ id: String(i), type: "apply", detail: { company: `Co${i}` } }),
		);
		expect(activityFeed(items, 3)).toHaveLength(3);
	});
});
