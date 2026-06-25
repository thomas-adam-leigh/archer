/// <reference types="cypress" />

// ARC-148 (M1 · Home + activity feed) — the post-onboarding home now renders live
// data: the boards Archer sweeps with their integration status (GET /boards),
// today's collect run rolled up into a readable trail (GET /activities/daily), and
// the recent-activity feed incl. the live "Archer is researching …" indicator
// (GET /activities). This spec drives both the populated path and the launch
// default — no run, no activity — through the browser with the backend mocked at
// the network layer, so empty states render calm (never blank/broken).
//
// A completed user's `/onboarding/progress` reports `done` (the completion shape),
// and the home route also reads suggested titles + saved rule-outs, so those are
// stubbed too. Under CYPRESS_LIVE=1 the mocks are skipped and a real backend won't
// reproduce these states deterministically, so the spec self-skips.

import { SESSION_KEY, seededSession } from "../support/commands";

const TITLES: readonly string[] = ["Senior Frontend Engineer"];
const RULE_OUTS = [{ id: "criterion-1", text: "nothing in .NET or C#" }];

/** The two seeded boards the home panel renders (one live, one not integrated). */
const BOARDS = [
	{ slug: "pnet", name: "PNet", collect_status: "integrated", apply_status: "not_integrated" },
	{
		slug: "careerjunction",
		name: "CareerJunction",
		collect_status: "not_integrated",
		apply_status: "not_integrated",
	},
];

/** Stub the progress + onboarding-output reads every home visit makes. */
function stubHomeBackend() {
	cy.fixture("onboarding/progress.json").then(
		(stages: Record<string, Record<string, unknown>>) => {
			cy.intercept("GET", "**/onboarding/progress*", {
				statusCode: 200,
				body: { ...stages.completed, step: "done" },
			}).as("progress");
		},
	);
	cy.intercept("POST", "**/onboarding/titles/suggest", {
		statusCode: 200,
		body: { user: "test-user-id", suggestions: TITLES },
	}).as("suggestTitles");
	cy.intercept({ method: "GET", url: /\/criteria\?/ }, {
		statusCode: 200,
		body: { user: "test-user-id", criteria: RULE_OUTS },
	}).as("listCriteria");
	cy.intercept("GET", "**/boards", { statusCode: 200, body: { boards: BOARDS } }).as(
		"boards",
	);
	// The real collection schedule (ARC-172): a weekday cron, a future next run, and
	// a recent last run. Times are UTC ISO; the card renders them in local time.
	cy.intercept("GET", "**/collection/schedule*", {
		statusCode: 200,
		body: {
			user: "test-user-id",
			schedule: "0 6 * * 1-5",
			nextRunAt: "2026-06-29T06:00:00Z",
			lastRunAt: "2026-06-24T06:02:00Z",
		},
	}).as("schedule");
}

/** The empty run + feed reads the next-run card tests don't otherwise care about. */
function stubEmptyRunAndFeed() {
	cy.intercept({ method: "GET", url: /\/activities\/daily/ }, {
		statusCode: 200,
		body: {
			user: "test-user-id",
			run: {
				date: "2026-06-24",
				status: null,
				jobsNew: 0,
				postingsNew: 0,
				counts: { found: 0, nothing_today: 0, not_integrated: 0, failed: 0, collecting: 0 },
				boards: [],
				startedAt: null,
				finishedAt: null,
			},
		},
	}).as("dailyRun");
	cy.intercept({ method: "GET", url: /\/activities\?/ }, {
		statusCode: 200,
		body: { user: "test-user-id", activities: [] },
	}).as("activities");
}

/** Visit home with a restored session so the guard treats us as signed-in. */
function visitHome() {
	cy.visit("/onboarding/home", {
		onBeforeLoad(win) {
			win.localStorage.setItem(SESSION_KEY, JSON.stringify(seededSession()));
		},
	});
	cy.get('[data-testid="onboarding-stage-home"]').should("be.visible");
}

describe("Home dashboard — live data (M1)", () => {
	beforeEach(function () {
		if (Cypress.env("live")) this.skip();
		stubHomeBackend();
	});

	it("renders today's run, board status, the feed and the researching indicator", () => {
		// A finished collect run: PNet found roles, CareerJunction is not integrated.
		cy.intercept({ method: "GET", url: /\/activities\/daily/ }, {
			statusCode: 200,
			body: {
				user: "test-user-id",
				run: {
					date: "2026-06-24",
					status: "done",
					jobsNew: 4,
					postingsNew: 4,
					counts: { found: 1, nothing_today: 0, not_integrated: 1, failed: 0, collecting: 0 },
					boards: [
						{
							activityId: "run-pnet",
							board: "pnet",
							status: "succeeded",
							outcome: "found",
							scraped: 12,
							postingsNew: 4,
							candidaciesNew: 4,
							error: null,
						},
						{
							activityId: "run-cj",
							board: "careerjunction",
							status: "succeeded",
							outcome: "not_integrated",
							scraped: 0,
							postingsNew: 0,
							candidaciesNew: 0,
							error: null,
						},
					],
					startedAt: "2026-06-24T08:00:00Z",
					finishedAt: "2026-06-24T08:02:00Z",
				},
			},
		}).as("dailyRun");
		// An in-flight enrich (researching now) + a finished apply (feed row).
		cy.intercept({ method: "GET", url: /\/activities\?/ }, {
			statusCode: 200,
			body: {
				user: "test-user-id",
				activities: [
					{
						id: "enrich-1",
						type: "enrich",
						status: "in_progress",
						detail: { company: "Stripe" },
						error: null,
						started_at: "2026-06-24T08:05:00Z",
						finished_at: null,
						created_at: "2026-06-24T08:05:00Z",
					},
					{
						id: "apply-1",
						type: "apply",
						status: "succeeded",
						detail: { company: "Notion" },
						error: null,
						started_at: "2026-06-24T07:00:00Z",
						finished_at: "2026-06-24T07:01:00Z",
						created_at: "2026-06-24T07:00:00Z",
					},
				],
			},
		}).as("activities");

		visitHome();

		// Today's run: the headline summarises the haul + the not-integrated board.
		cy.get('[data-testid="home-todays-run-headline"]').should(
			"contain.text",
			"Collected today",
		);
		cy.get('[data-testid="home-run-trail"]').within(() => {
			cy.contains("PNet").should("be.visible");
			cy.contains("CareerJunction").should("be.visible");
			cy.contains("not integrated yet").should("be.visible");
		});

		// Boards panel: real names + their collect status.
		cy.get('[data-testid="home-boards"]').within(() => {
			cy.contains("PNet").should("be.visible");
			cy.contains("Live").should("be.visible");
			cy.contains("Coming soon").should("be.visible");
		});

		// The live "Archer is researching …" indicator + the feed row.
		cy.get('[data-testid="home-researching"]').should("contain.text", "Stripe");
		cy.get('[data-testid="home-activity-item"]').should("contain.text", "Applied — Notion");
	});

	it("renders calm empty states at launch (no run, no activity)", () => {
		// The launch default: a day with no collect run and an empty activity feed.
		cy.intercept({ method: "GET", url: /\/activities\/daily/ }, {
			statusCode: 200,
			body: {
				user: "test-user-id",
				run: {
					date: "2026-06-24",
					status: null,
					jobsNew: 0,
					postingsNew: 0,
					counts: { found: 0, nothing_today: 0, not_integrated: 0, failed: 0, collecting: 0 },
					boards: [],
					startedAt: null,
					finishedAt: null,
				},
			},
		}).as("dailyRun");
		cy.intercept({ method: "GET", url: /\/activities\?/ }, {
			statusCode: 200,
			body: { user: "test-user-id", activities: [] },
		}).as("activities");

		visitHome();

		cy.get('[data-testid="home-todays-run"]').should(
			"contain.text",
			"Archer is searching for opportunities",
		);
		cy.get('[data-testid="home-activity-empty"]').should("be.visible");
		cy.get('[data-testid="home-researching"]').should("not.exist");
		// Boards still render at launch (they're seeded, not user data).
		cy.get('[data-testid="home-board"]').should("have.length", BOARDS.length);
	});

	// ARC-172 — the next-run card now reads the real API schedule, not a hardcoded
	// "08:00 and 13:00". The runner's timezone isn't fixed, so we assert the shape of
	// the rendered local times (a weekday label + HH:MM) rather than exact hours, and
	// that the old hardcoded copy is gone.
	it("renders the real next run, cadence and last run from the schedule API", () => {
		stubEmptyRunAndFeed();
		visitHome();

		cy.get('[data-testid="home-next-run"]').should("be.visible");
		cy.get('[data-testid="home-next-run-time"]')
			.invoke("text")
			.should(
				"match",
				/^(Today|Tomorrow|Yesterday|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday) · \d{2}:\d{2}$/,
			);
		cy.get('[data-testid="home-cadence"]')
			.should("contain.text", "every weekday")
			.invoke("text")
			.should("match", /at \d{2}:\d{2}/);
		cy.get('[data-testid="home-last-run"]')
			.should("contain.text", "Last run")
			.invoke("text")
			.should("match", /\d{2}:\d{2}/);
		// The hardcoded fiction ARC-172 removed must not resurface.
		cy.get('[data-testid="home-next-run"]').should(
			"not.contain.text",
			"08:00 and 13:00",
		);
	});

	it("shows an honest empty state when no run has happened yet", () => {
		cy.intercept("GET", "**/collection/schedule*", {
			statusCode: 200,
			body: {
				user: "test-user-id",
				schedule: "0 6 * * 1-5",
				nextRunAt: "2026-06-29T06:00:00Z",
				lastRunAt: null,
			},
		}).as("scheduleNoRun");
		stubEmptyRunAndFeed();
		visitHome();

		cy.get('[data-testid="home-last-run"]').should("have.text", "No runs yet.");
	});
});
