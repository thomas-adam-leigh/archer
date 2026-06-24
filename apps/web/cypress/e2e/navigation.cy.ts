/// <reference types="cypress" />

// ARC-167 — the dashboard sidebar must navigate client-side (SPA), not reload the
// whole document on every click. This spec guards the regression: it signs in,
// stamps a marker on `window`, then clicks between sidebar routes and asserts the
// marker survives (a full document navigation would replace `window` and wipe it),
// the URL changes, the destination renders without a full-screen reload, and the
// active highlight follows the route. The home + jobs backends are mocked at the
// network layer so the states are deterministic; under CYPRESS_LIVE=1 a real
// backend won't reproduce them, so the spec self-skips.

import { SESSION_KEY, seededSession } from "../support/commands";

const TITLES: readonly string[] = ["Senior Frontend Engineer"];
const RULE_OUTS = [{ id: "criterion-1", text: "nothing in .NET or C#" }];

const BOARDS = [
	{ slug: "pnet", name: "PNet", collect_status: "integrated", apply_status: "not_integrated" },
];

/** A shortlisted candidacy so the jobs feed renders populated (not empty). */
const SHORTLISTED = {
	id: "33333333-3333-3333-3333-333333333333",
	status: "shortlisted",
	triage_decision: "shortlisted",
	match_score: 87,
	posting_title: "Senior Backend Engineer",
	board_slug: "pnet",
	company_name: "Acme",
	created_at: "2026-06-24T09:00:00Z",
};

/** Stub every read the home + jobs routes make, so both render deterministically. */
function stubBackend() {
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
	cy.intercept("GET", "**/boards", { statusCode: 200, body: { boards: BOARDS } }).as("boards");
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
	cy.intercept({ method: "GET", url: /\/jobs\?.*status=shortlisted/ }, {
		statusCode: 200,
		body: { user: "test-user-id", jobs: [SHORTLISTED] },
	}).as("jobsShortlisted");
	cy.intercept({ method: "GET", url: /\/jobs\?.*status=alternative_outreach/ }, {
		statusCode: 200,
		body: { user: "test-user-id", jobs: [] },
	}).as("jobsAltOutreach");
}

/** A nav link in the sidebar (the `asChild` anchor carries the href). */
function navLink(href: string) {
	return cy.get(`[data-slot="sidebar-content"] a[href="${href}"]`);
}

describe("Dashboard sidebar navigation (ARC-167)", () => {
	beforeEach(function () {
		if (Cypress.env("live")) this.skip();
		stubBackend();
		cy.visit("/onboarding/home", {
			onBeforeLoad(win) {
				win.localStorage.setItem(SESSION_KEY, JSON.stringify(seededSession()));
			},
		});
		cy.get('[data-testid="onboarding-stage-home"]').should("be.visible");
		// Stamp a marker on the live window. A full-document navigation would
		// replace `window` and discard it — so its survival proves SPA navigation.
		cy.window().then((win) => {
			(win as unknown as { __navMarker?: string }).__navMarker = "spa";
		});
	});

	it("navigates between routes client-side without a full document reload", () => {
		// Home → Jobs: the destination renders and the page never reloaded.
		navLink("/jobs").click();
		cy.location("pathname").should("eq", "/jobs");
		cy.get('[data-testid="jobs-page"]').should("be.visible");
		cy.window().its("__navMarker").should("eq", "spa");

		// Back to the dashboard, and the marker still survives the round trip.
		navLink("/onboarding/home").click();
		cy.location("pathname").should("eq", "/onboarding/home");
		cy.get('[data-testid="onboarding-stage-home"]').should("be.visible");
		cy.window().its("__navMarker").should("eq", "spa");
	});

	it("moves the active highlight to the current route", () => {
		// On home, the Dashboard entry is active and Jobs is not.
		navLink("/onboarding/home").should("have.attr", "data-active", "true");
		navLink("/jobs").should("have.attr", "data-active", "false");

		navLink("/jobs").click();
		cy.location("pathname").should("eq", "/jobs");
		// After navigating, the highlight follows: Jobs active, Dashboard not.
		navLink("/jobs").should("have.attr", "data-active", "true");
		navLink("/onboarding/home").should("have.attr", "data-active", "false");
	});
});
