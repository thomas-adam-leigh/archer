/// <reference types="cypress" />

// ARC-117 (M9 · Hardening) — network resilience. Proves the flow has no
// dead-ends when the backend is slow or failing: a failed resume-at-step
// progress read lands on a retryable error (not a stuck "Loading…"), retrying
// recovers, and a 401 expires the session and forwards the user to re-auth.
//
// The backend is mocked at the network layer (a seeded session + a controllable
// `/onboarding/progress` intercept), so the run is deterministic and creates no
// data. Under CYPRESS_LIVE=1 these failure injections don't apply, so the specs
// self-skip.

import { SESSION_KEY, seededSession } from "../support/commands";

/** Visit `path` with a session already persisted (a returning, signed-in user). */
function visitSignedIn(path: string) {
	cy.visit(path, {
		onBeforeLoad(win) {
			win.localStorage.setItem(SESSION_KEY, JSON.stringify(seededSession()));
		},
	});
}

describe("Network resilience", () => {
	beforeEach(function () {
		if (Cypress.env("live")) {
			this.skip();
		}
	});

	it("a failed progress read shows a retryable error, then recovers", () => {
		cy.fixture("onboarding/progress.json").then(
			(stages: Record<string, unknown>) => {
				// Fail the initial read and both retries (retry: failureCount < 2 →
				// three attempts), then serve the real intro on the post-retry read.
				let calls = 0;
				cy.intercept("GET", "**/onboarding/progress*", (req) => {
					calls += 1;
					if (calls <= 3) {
						req.reply({ statusCode: 500, body: { error: "boom" } });
					} else {
						req.reply({ statusCode: 200, body: stages.intro });
					}
				}).as("progress");

				visitSignedIn("/onboarding/intro");

				// No dead-end: the failed read surfaces the shared retryable error.
				cy.get('[data-testid="onboarding-error"]', { timeout: 20000 })
					.should("be.visible")
					.and("contain.text", "Try again");

				// Retrying re-reads progress (now healthy) and the stage renders.
				cy.contains('[data-testid="onboarding-error"] button', "Try again").click();
				cy.get('[data-testid="intro-path-resume"]', { timeout: 20000 }).should(
					"be.visible",
				);
			},
		);
	});

	it("a 401 expires the session and forwards to /auth", () => {
		// An invalid/expired token is a client error: surfaced at once (no retry),
		// the session is dropped, and the auth guard sends the user to sign in.
		cy.intercept("GET", "**/onboarding/progress*", {
			statusCode: 401,
			body: { error: "invalid token" },
		}).as("progress");

		visitSignedIn("/onboarding/intro");

		cy.location("pathname", { timeout: 20000 }).should("eq", "/auth");
	});
});
