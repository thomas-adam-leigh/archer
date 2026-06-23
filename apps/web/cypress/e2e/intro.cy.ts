/// <reference types="cypress" />

// ARC-100 (M3 · Intro / path choice) — the onboarding entry E2E. It drives the
// real intro screen (ARC-98) and the resume-at-step router (ARC-99) through the
// browser: a signed-in candidate whose step is `intro` sees both path cards,
// each card dispatches to its stage, and the `/onboarding` resolver lands an
// intro-step user back on the intro (resume on reload).
//
// The backend is mocked at the network layer — a seeded session (the way ARC-96
// restores a returning user from localStorage) plus a mocked `/onboarding/progress`
// (cy.onboardingState). No account is created and the run is deterministic. The
// intro step is the mock that makes path routing predictable, so under
// CYPRESS_LIVE=1 (where the custom commands are no-ops) these specs self-skip.

import { SESSION_KEY, seededSession } from "../support/commands";

/**
 * Register the mocked `intro` progress, then visit `path` with a session already
 * persisted so the route guard (ARC-96) admits the visitor and the resume router
 * (ARC-99) reads the `intro` step. Pair with assertions on where it lands.
 */
function visitSignedIn(path: string) {
	cy.onboardingState("intro");
	cy.visit(path, {
		onBeforeLoad(win) {
			win.localStorage.setItem(SESSION_KEY, JSON.stringify(seededSession()));
		},
	});
}

describe("Intro — path choice", () => {
	beforeEach(function () {
		// The intro state + path routing are only deterministic with the mocks;
		// a real backend user's step isn't guaranteed to be `intro`.
		if (Cypress.env("live")) {
			this.skip();
		}
	});

	it("renders both path-choice cards", () => {
		visitSignedIn("/onboarding/intro");

		cy.contains("h1", "Hi, I'm Archer.").should("be.visible");
		cy.get('[data-testid="intro-path-resume"]')
			.should("be.visible")
			.and("contain.text", "Upload my résumé");
		cy.get('[data-testid="intro-path-conversation"]')
			.should("be.visible")
			.and("contain.text", "Start from scratch");
	});

	it("'Upload my résumé' routes to the résumé stage", () => {
		visitSignedIn("/onboarding/intro");

		cy.get('[data-testid="intro-path-resume"]').click();

		cy.location("pathname").should("eq", "/onboarding/resume");
		cy.get('[data-testid="onboarding-stage-resume"]').should("be.visible");
	});

	it("'Start from scratch' routes to the conversation stage", () => {
		visitSignedIn("/onboarding/intro");

		cy.get('[data-testid="intro-path-conversation"]').click();

		cy.location("pathname").should("eq", "/onboarding/conversation");
		cy.get('[data-testid="onboarding-stage-conversation"]').should(
			"be.visible",
		);
	});

	it("the /onboarding resolver lands an intro-step user on the intro", () => {
		visitSignedIn("/onboarding");

		cy.location("pathname").should("eq", "/onboarding/intro");
		cy.get('[data-testid="intro-path-resume"]').should("be.visible");
	});

	it("reloading mid-intro resumes at the intro", () => {
		visitSignedIn("/onboarding/intro");
		cy.get('[data-testid="intro-path-resume"]').should("be.visible");

		// The session survives in localStorage and progress is re-read, so the
		// guard keeps the user on the intro rather than bouncing to /auth.
		cy.reload();

		cy.location("pathname").should("eq", "/onboarding/intro");
		cy.get('[data-testid="intro-path-conversation"]').should("be.visible");
	});
});
