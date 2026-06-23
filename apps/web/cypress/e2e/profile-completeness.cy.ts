/// <reference types="cypress" />

// ARC-136 (M10 · Onboarding finalization) — the capstone completeness check, browser
// side. Where onboarding-full.cy.ts (ARC-115) proves the résumé journey *composes*
// stage-to-stage, this spec proves the journey surfaces a *complete, ordered* profile:
// it drives sign up → upload → review → approve → criteria → home, and at the review
// checkpoint asserts the rendered profile contract exposes every field the web client
// shows — name, location, the linkedin + portfolio link chips, summary, the ordered
// experience timeline, education, and skills — with the spine in `position` order.
//
// The two contract-only typed columns the UI never renders — years_experience and
// resume_url — are asserted at the persistence layer in
// packages/db/src/profile-completeness.test.ts (the same approval seam, against a real
// migrated Postgres). Together the pair is the regression net for the NULL-columns
// class M10 closed.
//
// Backend fully stubbed via cy.intercept (no account, no profile written). Under
// CYPRESS_LIVE=1 the mocked stage transitions aren't reproducible, so the spec skips.

const email = "candidate@example.com";
const password = "password123";
const RULE_OUT = "nothing in .NET or C#";

/** The single mutable backend state the journey reads; `step` drives the progress
 *  poll (intro → review → titles → done), mirroring onboarding-full.cy.ts. */
interface Ctrl {
	step: "intro" | "review" | "titles" | "done";
	versionId: string;
	criteria: { id: string; text: string }[];
	seq: number;
}

function stubBackend(ctrl: Ctrl) {
	cy.signup(email, password);

	cy.intercept("GET", "**/rest/v1/threads*", {
		statusCode: 200,
		body: [{ id: "test-thread-id" }],
	}).as("threads");

	cy.fixture("onboarding/progress.json").then(
		(stages: Record<string, Record<string, unknown>>) => {
			cy.intercept("GET", "**/onboarding/progress*", (req) => {
				let body: Record<string, unknown>;
				switch (ctrl.step) {
					case "review":
						body = { ...stages.review, proposedVersionId: ctrl.versionId };
						break;
					case "titles":
						body = { ...stages.criteria, step: "titles" };
						break;
					case "done":
						body = { ...stages.completed, step: "done" };
						break;
					default:
						body = stages.intro;
				}
				req.reply({ statusCode: 200, body });
			}).as("progress");
		},
	);

	// The proposed version + its spine, served from the rich profile.json fixture so
	// every résumé-style section renders and the experience order is meaningful.
	cy.fixture("profile.json").then(
		(profile: {
			attributes: Record<string, unknown>;
			spine: Record<string, unknown>;
		}) => {
			const version = () => ({
				id: ctrl.versionId,
				status: "proposed",
				version_no: 1,
				attributes: profile.attributes,
			});
			cy.intercept(/\/profile\/versions\?/, (req) => {
				req.reply({
					statusCode: 200,
					body: { versions: [version()], liveVersionId: null },
				});
			}).as("versions");
			cy.intercept(/\/profile\/versions\/[^/?]+\?/, (req) => {
				req.reply({
					statusCode: 200,
					body: { version: version(), spine: profile.spine },
				});
			}).as("versionDetail");
		},
	);

	cy.intercept("POST", "**/onboarding/proposals/*/decide/self", (req) => {
		ctrl.step = "titles";
		req.reply({ statusCode: 200, body: {} });
	}).as("approve");

	cy.intercept("POST", "**/onboarding/titles/suggest", {
		statusCode: 200,
		body: {
			user: "test-user-id",
			suggestions: ["Senior Frontend Engineer", "Staff Frontend Engineer"],
		},
	}).as("suggestTitles");
	cy.intercept({ method: "GET", url: /\/criteria\?/ }, (req) => {
		req.reply({ statusCode: 200, body: { user: "test-user-id", criteria: ctrl.criteria } });
	}).as("listCriteria");
	cy.intercept("POST", "**/criteria", (req) => {
		ctrl.seq += 1;
		const criterion = { id: `criterion-${ctrl.seq}`, text: (req.body as { text: string }).text };
		ctrl.criteria.push(criterion);
		req.reply({ statusCode: 200, body: { user: "test-user-id", criterion } });
	}).as("addCriterion");
	cy.intercept("POST", "**/onboarding/titles/approve", { statusCode: 200, body: {} }).as(
		"approveTitles",
	);
	cy.intercept("POST", "**/onboarding/complete", (req) => {
		ctrl.step = "done";
		req.reply({ statusCode: 200, body: { user: "test-user-id", status: "submitted" } });
	}).as("complete");

	cy.intercept("POST", "**/storage/v1/object/resumes/**", {
		statusCode: 200,
		body: { Key: "resumes/test-user-id/sample-resume.docx" },
	}).as("upload");
	cy.intercept("POST", "**/onboarding/resume", {
		statusCode: 200,
		body: { threadId: "test-thread-id", runId: "test-run-id" },
	}).as("ingest");
}

/** Sign up a fresh account through the UI and enter onboarding at the intro. */
function signUpToIntro() {
	cy.visit("/auth");
	cy.contains("button", "Don't have an account? Sign up").click();
	cy.get('[data-testid="auth-form"]').within(() => {
		cy.get('input[type="email"]').clear().type(email);
		cy.get('input[type="password"]').clear().type(password);
	});
	cy.get('button[type="submit"]').click();
	cy.wait("@signup");
	cy.location("pathname").should("eq", "/");
	cy.contains("button", "Get started").click();
	cy.location("pathname").should("eq", "/onboarding/intro");
}

describe("Onboarding profile completeness (M10 · ARC-136)", () => {
	beforeEach(function () {
		if (Cypress.env("live")) this.skip();
	});

	it("a completed résumé onboarding surfaces a complete, ordered profile", () => {
		const ctrl: Ctrl = { step: "intro", versionId: "test-version-id", criteria: [], seq: 0 };
		stubBackend(ctrl);

		signUpToIntro();

		// Upload the fixture résumé → processing → the proposed draft lands on review.
		cy.get('[data-testid="intro-path-resume"]').click();
		cy.location("pathname").should("eq", "/onboarding/resume");
		cy.get('[data-testid="resume-input"]').selectFile("cypress/fixtures/sample-resume.docx", {
			force: true,
		});
		cy.get('[data-testid="resume-upload"]').click();
		cy.wait("@ingest");
		cy.then(() => {
			ctrl.step = "review";
		});
		cy.location("pathname").should("eq", "/onboarding/review");

		// --- The completeness assertions: every field the review render exposes. ---
		cy.get('[data-testid="profile-review-card"]').within(() => {
			cy.get('[data-testid="profile-name"]').should("contain.text", "Casey Rivera");
			// Typed field: location materialises onto the header.
			cy.contains("London, UK").should("be.visible");
			// Typed fields: the linkedin + portfolio (website) link chips both render.
			cy.get('a[href="https://www.linkedin.com/in/casey-rivera"]').should("exist");
			cy.get('a[href="https://caseyrivera.dev"]').should("exist");
			cy.get('[data-testid="profile-summary"]').should("contain.text", "Senior frontend engineer");
			cy.get('[data-testid="profile-education"]').should("contain.text", "University of Bristol");
			cy.get('[data-testid="profile-skills"]').should("contain.text", "TypeScript");
		});

		// The spine is present AND ordered: the current role (Northwind) precedes the
		// earlier one (Brightwave) in the rendered timeline, matching spine order.
		cy.get('[data-testid="profile-experience"]')
			.should("contain.text", "Northwind Labs")
			.and("contain.text", "Brightwave")
			.invoke("text")
			.then((text) => {
				expect(text.indexOf("Northwind Labs")).to.be.lessThan(text.indexOf("Brightwave"));
			});

		// Approve → criteria → submit → land out of onboarding on home, proving the
		// completed-onboarding handoff (not just the review snapshot).
		cy.get('[data-testid="profile-approve"]').click();
		cy.wait("@approve");
		cy.location("pathname").should("eq", "/onboarding/criteria");

		cy.get('[data-testid="criteria-input"]').type(RULE_OUT);
		cy.get('[data-testid="criteria-add"]').click();
		cy.wait("@addCriterion");
		cy.get('[data-testid="hunt-setup-submit"]').should("be.enabled").click();
		cy.wait("@approveTitles");
		cy.wait("@complete");
		cy.location("pathname").should("eq", "/onboarding/home");
		cy.get('[data-testid="onboarding-stage-home"]').should("be.visible");
	});
});
