/// <reference types="cypress" />

// ARC-97 (M2 · Auth) — the first "real" onboarding E2E: the auth entry point.
// It drives the actual auth screen (ARC-95) and its GoTrue wiring + route guards
// (ARC-96) through the browser, with the backend mocked at the network layer
// (cy.signup / cy.login + cy.intercept) so no account is created and the run is
// deterministic. Under CYPRESS_LIVE=1 the custom commands become no-ops; the
// mock-only assertions self-skip so the same spec can run against a real backend.
//
// What "resume" means at M2: the per-stage step machine that lands a returning
// user on their exact onboarding step reads /onboarding/progress and arrives with
// the onboarding router in ARC-99 (M3). At M2 the resume that exists is session
// persistence (ARC-96): a signed-in user is restored from localStorage on reload
// and stays in the guarded flow instead of being bounced back to /auth. This spec
// asserts that, and mocks /onboarding/progress mid-flow so the M3 spec (ARC-100)
// can extend it to assert the exact resumed stage.

const email = "candidate@example.com";
const password = "password123";

/** Fill the auth form's email + password fields. */
function fillCredentials(mail: string, pass: string) {
	cy.get('[data-testid="auth-form"]').within(() => {
		cy.get('input[type="email"]').clear().type(mail);
		cy.get('input[type="password"]').clear().type(pass);
	});
}

describe("Auth — sign up / sign in / resume", () => {
	it("signs up a fresh user → lands on the onboarding intro", function () {
		if (Cypress.env("live")) {
			// No deterministic mocked GoTrue response to land on without the stubs.
			this.skip();
		}

		cy.signup(email, password);
		cy.visit("/auth");

		// Switch to sign-up mode, then create the account through the UI.
		cy.contains("button", "Don't have an account? Sign up").click();
		cy.contains("h1", "Create account").should("be.visible");
		fillCredentials(email, password);
		cy.get('button[type="submit"]').click();

		// Mocked sign-up 200 → session persisted → routed into the guarded flow.
		cy.wait("@signup");
		cy.location("pathname").should("eq", "/");
		cy.contains("h1", "Never apply for a job").should("be.visible");
		cy.contains("button", "Get started").should("be.visible");
	});

	it("signs in an existing user → enters the flow and resumes on reload", function () {
		if (Cypress.env("live")) {
			this.skip();
		}

		cy.login(email, password);
		// Mock progress mid-flow so the M3 resume-at-step router (ARC-99) has a
		// stage to land on; at M2 we assert entry into the guarded flow + that the
		// persisted session survives a reload (resume without re-authenticating).
		cy.onboardingState("review");
		cy.visit("/auth");

		fillCredentials(email, password);
		cy.get('button[type="submit"]').click();

		cy.wait("@login");
		cy.location("pathname").should("eq", "/");
		cy.contains("h1", "Never apply for a job").should("be.visible");

		// Reload: the session is restored from localStorage and the guard keeps the
		// user in the flow rather than redirecting to /auth.
		cy.reload();
		cy.location("pathname").should("eq", "/");
		cy.contains("h1", "Never apply for a job").should("be.visible");
	});

	it("rejects empty fields with an inline validation error", () => {
		// Pure client-side validation — no backend, so it runs in live mode too.
		cy.visit("/auth");
		cy.get('button[type="submit"]').click();

		cy.contains('[role="alert"]', "Enter an email and password.").should(
			"be.visible",
		);
		cy.location("pathname").should("eq", "/auth");
	});

	it("surfaces the GoTrue error on bad credentials", function () {
		if (Cypress.env("live")) {
			this.skip();
		}

		// Override the sign-in stub with a rejected GoTrue response; the screen
		// reads `msg` from the error body (auth.ts readError) into its alert.
		cy.intercept("POST", "**/auth/v1/token*", {
			statusCode: 400,
			body: { msg: "Invalid login credentials" },
		}).as("badLogin");
		cy.visit("/auth");

		fillCredentials(email, "wrong-password");
		cy.get('button[type="submit"]').click();

		cy.wait("@badLogin");
		cy.contains('[role="alert"]', "Invalid login credentials").should(
			"be.visible",
		);
		cy.location("pathname").should("eq", "/auth");
	});
});
