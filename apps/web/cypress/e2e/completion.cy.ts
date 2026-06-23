/// <reference types="cypress" />

// ARC-114 (M8 · Home / onboarding complete) — the completion → home handoff. Once
// the candidate has finished onboarding they are "directed out of onboarding": a
// completed account is durably routed to home and re-login lands there straight
// away, rather than the welcome / "Get started" landing. This spec drives that
// exit point through the browser with the backend mocked at the network layer:
//
//   1. re-login as a completed user → /auth submit lands straight on home;
//   2. a returning completed user who hits the `/` landing is forwarded to home;
//   3. reloading on home keeps them there (the session + progress resume).
//
// A completed user's `/onboarding/progress` reports `completed: true` with step
// `done` (the criteria.cy.ts shape `/onboarding/complete` flips to). The home
// route (ARC-113) also reads the suggested titles + saved rule-outs, so those are
// stubbed too. Under CYPRESS_LIVE=1 the custom commands are no-ops and a real
// backend won't reproduce the completed state deterministically, so the spec
// self-skips.

import { SESSION_KEY, seededSession } from "../support/commands";

const email = "candidate@example.com";
const password = "password123";

/** Archer's approved target titles + a captured rule-out the home summary shows. */
const TITLES: readonly string[] = [
	"Senior Frontend Engineer",
	"Staff Frontend Engineer",
];
const RULE_OUTS = [{ id: "criterion-1", text: "nothing in .NET or C#" }];

/**
 * Stub the backend a completed candidate observes: progress reporting `done`
 * (the shape `/onboarding/complete` settles on), plus the home route's title +
 * rule-out reads. No write seams — onboarding is already finished.
 */
function stubCompletedBackend() {
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
}

describe("Completion → home handoff (M8)", () => {
	beforeEach(function () {
		if (Cypress.env("live")) {
			this.skip();
		}
		stubCompletedBackend();
	});

	it("re-login as a completed user lands straight on home", () => {
		cy.login(email, password);
		cy.visit("/auth");

		cy.get('[data-testid="auth-form"]').within(() => {
			cy.get('input[type="email"]').clear().type(email);
			cy.get('input[type="password"]').clear().type(password);
		});
		cy.get('button[type="submit"]').click();

		// Mocked sign-in 200 → session persisted → the landing forwards the
		// completed account out of onboarding to home (no welcome / "Get started").
		cy.wait("@login");
		cy.location("pathname").should("eq", "/onboarding/home");
		cy.get('[data-testid="onboarding-stage-home"]').should("be.visible");
		cy.contains("h1", "Never apply for a job").should("not.exist");
	});

	it("forwards a returning completed user from `/` to home, durably on reload", () => {
		// A restored session (the way ARC-96 rehydrates a returning user) hitting
		// the `/` landing is sent to home rather than the welcome screen.
		cy.visit("/", {
			onBeforeLoad(win) {
				win.localStorage.setItem(SESSION_KEY, JSON.stringify(seededSession()));
			},
		});
		cy.location("pathname").should("eq", "/onboarding/home");
		cy.get('[data-testid="onboarding-stage-home"]').should("be.visible");

		// Reload: the session + progress resume and keep the user on home.
		cy.reload();
		cy.location("pathname").should("eq", "/onboarding/home");
		cy.get('[data-testid="onboarding-stage-home"]').should("be.visible");
	});
});
