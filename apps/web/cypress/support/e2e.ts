// Loaded automatically before every spec (see cypress.config.ts supportFile).
import "cypress-axe";
import "./commands";

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
