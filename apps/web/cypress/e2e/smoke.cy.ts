/// <reference types="cypress" />

// ARC-94 smoke E2E: the first spec that asserts on the real onboarding UI.
// It proves the served app boots, the persistent app shell (logo + progress
// indicator, ARC-91) renders, and the stubbed intro mounts — and that the
// custom commands (cy.login / cy.onboardingState) and their cy.intercept mocks
// resolve. This is the M1 "harness works end to end against the real shell"
// gate; richer per-stage specs land from M2 (ARC-97) onward.
//
// The ARC-93 harness self-test (harness.cy.ts) deliberately avoids asserting on
// any onboarding screen so it can stay green before the UI exists; this spec is
// where that assertion now lives.

import { SESSION_KEY, seededSession } from "../support/commands";

describe("Onboarding smoke", () => {
	it("boots the served app and renders the shell + stubbed intro", () => {
		// The onboarding root is guarded (ARC-96), so seed a session before boot
		// to land on the intro rather than being redirected to /auth.
		cy.visit("/", {
			onBeforeLoad(win) {
				win.localStorage.setItem(SESSION_KEY, JSON.stringify(seededSession()));
			},
		});
		cy.document().its("readyState").should("eq", "complete");

		// Persistent chrome from the app shell (ARC-91): logo top-left…
		cy.get('[data-testid="app-logo"]')
			.should("be.visible")
			.and("contain.text", "Archer");

		// …and the top-center onboarding progress indicator.
		cy.get('[data-testid="onboarding-progress"]')
			.should("be.visible")
			.and("have.attr", "role", "progressbar");

		// The stubbed intro content mounts in <main>.
		cy.contains("h1", "Never apply for a job").should("be.visible");
		cy.contains("button", "Get started").should("be.visible");
	});

	it("resolves the cy.login + cy.onboardingState('intro') mocks", function () {
		// Live mode (CYPRESS_LIVE=1) makes the commands no-ops, so there is no
		// deterministic mocked response to assert against.
		if (Cypress.env("live")) {
			this.skip();
		}

		cy.login();
		cy.onboardingState("intro");
		cy.visit("/");

		// Drive the intercepts from the served page's own fetch, the way the
		// app (ARC-96/99) will once it reads progress on load.
		cy.window().then((win) =>
			win.fetch("/onboarding/progress?user=test-user-id"),
		);
		cy.wait("@onboardingProgress")
			.its("response.body.step")
			.should("eq", "intro");

		cy.window().then((win) =>
			win.fetch(
				"https://example.supabase.co/auth/v1/token?grant_type=password",
				{
					method: "POST",
					body: JSON.stringify({
						email: "candidate@example.com",
						password: "password123",
					}),
				},
			),
		);
		cy.wait("@login")
			.its("response.body.access_token")
			.should("eq", "test-access-token");
	});
});
