/// <reference types="cypress" />

// Harness self-test for ARC-93: proves the Cypress + CI wiring works end to end
// (build → serve → wait-on → run) and that the custom commands + cy.intercept
// mocks resolve. It deliberately does NOT assert on any onboarding screen — the
// shell + intro smoke is ARC-94, gated on the design system (ARC-91). Keeping
// this spec independent of unbuilt UI is what lets web-e2e go green now.

describe("Cypress harness", () => {
	it("boots the served app", () => {
		cy.visit("/");
		cy.document().its("readyState").should("eq", "complete");
		cy.get("body").should("be.visible");
	});

	it("resolves the mocked GoTrue + Archer API contract", function () {
		// In live mode the commands intentionally skip the mocks, so there is
		// nothing deterministic to assert here.
		if (Cypress.env("live")) {
			this.skip();
		}

		cy.login();
		cy.onboardingState("intro");
		cy.visit("/");

		// Drive the intercepts from the page context the app will use.
		cy.window().then((win) =>
			win.fetch("/onboarding/progress?user=test-user-id"),
		);
		cy.wait("@onboardingProgress")
			.its("response.body.step")
			.should("eq", "intro");

		cy.window().then((win) =>
			win.fetch("https://example.supabase.co/auth/v1/token?grant_type=password", {
				method: "POST",
				body: JSON.stringify({
					email: "candidate@example.com",
					password: "password123",
				}),
			}),
		);
		cy.wait("@login")
			.its("response.body.access_token")
			.should("eq", "test-access-token");
	});

	it("loads the résumé + profile fixtures", () => {
		cy.fixture("profile.json")
			.its("attributes.full_name")
			.should("eq", "Casey Rivera");
		cy.fixture("sample-resume.docx", "binary").should(
			"have.length.greaterThan",
			0,
		);
	});
});
