/// <reference types="cypress" />

// Custom commands that make the onboarding specs deterministic, fast, and free
// of real data: they stub GoTrue + the Archer API with `cy.intercept` so no
// account is ever created and no profile is ever written. When `CYPRESS_LIVE=1`
// (Cypress.env("live")) the mocks are skipped so the same specs can run against
// a real test backend.
//
// The mocked shapes mirror the contract the mobile client implements
// (apps/mobile/src/lib/{auth,onboarding}.ts) so the web client (ARC-92/96/99)
// can wire onto them unchanged.

/** A GoTrue session payload, matching what `/auth/v1/token` returns. */
function sessionBody(email: string) {
	return {
		access_token: "test-access-token",
		refresh_token: "test-refresh-token",
		token_type: "bearer",
		expires_in: 3600,
		user: { id: "test-user-id", email },
	};
}

// `**/auth/v1` matches GoTrue regardless of the Supabase host the app targets.
const GOTRUE = "**/auth/v1";

Cypress.Commands.add("signup", (email, _password) => {
	if (Cypress.env("live")) return;
	cy.intercept("POST", `${GOTRUE}/signup`, {
		statusCode: 200,
		body: sessionBody(email),
	}).as("signup");
});

Cypress.Commands.add(
	"login",
	(email = "candidate@example.com", _password = "password123") => {
		if (Cypress.env("live")) return;
		// Email + password sign-in (`grant_type=password`).
		cy.intercept("POST", `${GOTRUE}/token*`, {
			statusCode: 200,
			body: sessionBody(email),
		}).as("login");
		// The API verifies the bearer token via GET /auth/v1/user (ARC-87).
		cy.intercept("GET", `${GOTRUE}/user`, {
			statusCode: 200,
			body: { id: "test-user-id", email },
		}).as("authUser");
	},
);

Cypress.Commands.add("onboardingState", (step) => {
	if (Cypress.env("live")) return;
	// Per-stage progress payloads live in fixtures/onboarding/progress.json,
	// keyed by step. Unknown steps fall back to the intro shape with the step
	// overridden, so the command stays useful as the step machine (ARC-99) grows.
	cy.fixture("onboarding/progress.json").then(
		(stages: Record<string, Record<string, unknown>>) => {
			const body = stages[step] ?? { ...stages.intro, step };
			cy.intercept("GET", "**/onboarding/progress*", {
				statusCode: 200,
				body,
			}).as("onboardingProgress");
		},
	);
});

export {};
