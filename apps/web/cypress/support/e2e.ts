// Loaded automatically before every spec (see cypress.config.ts supportFile).
import "cypress-axe";
import "./commands";

// ARC-148: the post-onboarding home reads live dashboard data — the boards Archer
// sweeps (GET /boards), the day's collect run (GET /activities/daily), and the
// recent-activity feed (GET /activities). Default all three to calm empty shapes
// before every spec so any flow that lands on home stays deterministic without a
// real backend; specs asserting populated states override these with their own
// `cy.intercept` (last-registered wins). Skipped under CYPRESS_LIVE=1.
beforeEach(() => {
	if (Cypress.env("live")) return;
	cy.intercept("GET", "**/boards", { statusCode: 200, body: { boards: [] } });
	cy.intercept({ method: "GET", url: /\/activities\/daily/ }, {
		statusCode: 200,
		body: {
			user: "test-user-id",
			run: {
				date: "1970-01-01",
				status: null,
				jobsNew: 0,
				postingsNew: 0,
				counts: { found: 0, nothing_today: 0, not_integrated: 0, failed: 0, collecting: 0 },
				boards: [],
				startedAt: null,
				finishedAt: null,
			},
		},
	});
	cy.intercept({ method: "GET", url: /\/activities\?/ }, {
		statusCode: 200,
		body: { user: "test-user-id", activities: [] },
	});
});

declare global {
	namespace Cypress {
		interface Chainable {
			/**
			 * Inject axe-core (idempotently) and assert the current document has no
			 * critical/serious accessibility violations. `label` names the stage in
			 * the run log so a failure is easy to place. Backs the ARC-116 a11y gate.
			 */
			a11y(label?: string): Chainable<void>;
			/** Stub GoTrue sign-up so a fresh account is never created. */
			signup(email: string, password: string): Chainable<void>;
			/**
			 * Stub GoTrue sign-in (+ the API's token-verification lookup) so specs
			 * authenticate without a real session. Defaults to a canned candidate.
			 */
			login(email?: string, password?: string): Chainable<void>;
			/**
			 * Stub `GET /onboarding/progress` to report the given onboarding step,
			 * so the router resumes the flow at that stage.
			 */
			onboardingState(step: string): Chainable<void>;
			/**
			 * Persist a session in `localStorage` so a guarded route treats the
			 * visitor as signed-in (the way a returning user is restored on reload).
			 */
			seedSession(email?: string): Chainable<void>;
		}
	}
}

export {};
