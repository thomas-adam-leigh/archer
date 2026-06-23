/// <reference types="cypress" />

// ARC-116 (M9 · Hardening) — the responsive + accessibility gate. Where
// onboarding-full.cy.ts proves the stages *compose*, this proves they're
// accessible and reflow at every breakpoint: it drives the same mocked journey
// through the browser at mobile / tablet / desktop widths and runs axe-core at
// each stage, asserting no critical/serious violations (cy.a11y). It also spot-
// checks keyboard focusability of each stage's primary control, so a regression
// that breaks tab access fails here.
//
// Both onboarding branches are covered: the résumé path's journey (auth → welcome
// → intro → dropzone → processing → review → criteria → home) and the scratch
// path's unique conversation screen. The backend is mocked exactly as the rest of
// the suite (no account created, no profile written); under CYPRESS_LIVE=1 the
// stage transitions aren't deterministic, so the spec self-skips.

import { SESSION_KEY, seededSession } from "../support/commands";

const email = "candidate@example.com";
const password = "password123";

/** The breakpoints every stage is exercised at: phone, tablet, laptop. */
const VIEWPORTS = [
	{ name: "mobile", width: 375, height: 812 },
	{ name: "tablet", width: 768, height: 1024 },
	{ name: "desktop", width: 1280, height: 900 },
] as const;

const SUGGESTED_TITLES: readonly string[] = [
	"Senior Frontend Engineer",
	"Staff Frontend Engineer",
	"Frontend Platform Engineer",
];

const RULE_OUT = "nothing in .NET or C#";

interface Criterion {
	id: string;
	text: string;
}

/** The single mutable backend state the résumé journey reads (see onboarding-full). */
interface Ctrl {
	step: "intro" | "review" | "titles" | "done";
	versionId: string;
	criteria: Criterion[];
	seq: number;
}

function newCtrl(): Ctrl {
	return { step: "intro", versionId: "test-version-id", criteria: [], seq: 0 };
}

/** Stub every seam the résumé journey touches, keyed off one {@link Ctrl}. */
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
		body: { user: "test-user-id", suggestions: SUGGESTED_TITLES },
	}).as("suggestTitles");

	cy.intercept({ method: "GET", url: /\/criteria\?/ }, (req) => {
		req.reply({
			statusCode: 200,
			body: { user: "test-user-id", criteria: ctrl.criteria },
		});
	}).as("listCriteria");

	cy.intercept("POST", "**/criteria", (req) => {
		ctrl.seq += 1;
		const criterion: Criterion = {
			id: `criterion-${ctrl.seq}`,
			text: (req.body as { text: string }).text,
		};
		ctrl.criteria.push(criterion);
		req.reply({ statusCode: 200, body: { user: "test-user-id", criterion } });
	}).as("addCriterion");

	cy.intercept("POST", "**/onboarding/titles/approve", {
		statusCode: 200,
		body: {},
	}).as("approveTitles");
	cy.intercept("POST", "**/onboarding/complete", (req) => {
		ctrl.step = "done";
		req.reply({
			statusCode: 200,
			body: { user: "test-user-id", status: "submitted" },
		});
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

/** Stub the scratch path's unique seams (transcribe shared; no real MediaRecorder). */
function stubConversation() {
	cy.intercept("GET", "**/rest/v1/threads*", {
		statusCode: 200,
		body: [{ id: "test-thread-id" }],
	}).as("threads");
	cy.fixture("transcribe.json").then((body) => {
		cy.intercept("POST", "**/functions/v1/transcribe*", {
			statusCode: 200,
			body,
		}).as("transcribe");
	});
	cy.onboardingState("intro");
}

function fillCredentials(mail: string, pass: string) {
	cy.get('[data-testid="auth-form"]').within(() => {
		cy.get('input[type="email"]').clear().type(mail);
		cy.get('input[type="password"]').clear().type(pass);
	});
}

describe("Responsive + accessibility (M9)", () => {
	beforeEach(function () {
		if (Cypress.env("live")) {
			this.skip();
		}
	});

	for (const vp of VIEWPORTS) {
		describe(`${vp.name} (${vp.width}px)`, () => {
			beforeEach(() => {
				cy.viewport(vp.width, vp.height);
			});

			it("résumé path: every stage reflows + passes axe", () => {
				const ctrl = newCtrl();
				stubBackend(ctrl);

				// Auth — both modes (the sign-up toggle changes the rendered copy).
				cy.visit("/auth");
				cy.get('[data-testid="auth-form"]').should("be.visible");
				cy.a11y("auth — sign in");
				cy.contains("button", "Don't have an account? Sign up").click();
				cy.contains("h1", "Create account").should("be.visible");
				cy.a11y("auth — sign up");

				// Sign up → the welcome landing.
				fillCredentials(email, password);
				cy.get('button[type="submit"]').click();
				cy.wait("@signup");
				cy.contains("h1", "Never apply for a job").should("be.visible");
				cy.a11y("welcome");

				// Intro — the two path cards.
				cy.contains("button", "Get started").click();
				cy.location("pathname").should("eq", "/onboarding/intro");
				cy.contains("h1", "Hi, I'm Archer.").should("be.visible");
				cy.get('[data-testid="intro-path-resume"]')
					.focus()
					.should("be.focused");
				cy.a11y("intro");

				// Résumé dropzone.
				cy.get('[data-testid="intro-path-resume"]').click();
				cy.location("pathname").should("eq", "/onboarding/resume");
				cy.get('[data-testid="resume-dropzone"]').should("be.visible");
				cy.a11y("resume dropzone");

				// Processing — shown while the ingest is in flight (before the draft lands).
				cy.get('[data-testid="resume-input"]').selectFile(
					"cypress/fixtures/sample-resume.docx",
					{ force: true },
				);
				cy.get('[data-testid="resume-selected"]').should("be.visible");
				cy.get('[data-testid="resume-upload"]').click();
				cy.get('[data-testid="resume-processing"]').should("be.visible");
				cy.wait("@ingest");
				cy.a11y("resume processing");

				// Let the next poll report the draft → review.
				cy.then(() => {
					ctrl.step = "review";
				});
				cy.location("pathname").should("eq", "/onboarding/review");
				cy.get('[data-testid="profile-name"]').should(
					"contain.text",
					"Casey Rivera",
				);
				cy.a11y("profile review");

				// Approve → criteria (hunt setup).
				cy.get('[data-testid="profile-approve"]').click();
				cy.wait("@approve");
				cy.location("pathname").should("eq", "/onboarding/criteria");
				cy.get('[data-testid="target-titles-list"]').should("be.visible");
				cy.a11y("criteria — empty");

				cy.get('[data-testid="criteria-input"]').type(RULE_OUT);
				cy.get('[data-testid="criteria-add"]').click();
				cy.wait("@addCriterion");
				cy.get('[data-testid="criteria-list"]').should("contain.text", RULE_OUT);
				cy.a11y("criteria — captured");

				// Submit → home.
				cy.get('[data-testid="hunt-setup-submit"]').should("be.enabled").click();
				cy.wait("@complete");
				cy.location("pathname").should("eq", "/onboarding/home");
				cy.get('[data-testid="onboarding-stage-home"]').should("be.visible");
				cy.get('[data-testid="home-start-over"]').focus().should("be.focused");
				cy.a11y("home");
			});

			it("scratch path: the conversation screen reflows + passes axe", () => {
				stubConversation();
				cy.visit("/onboarding/conversation", {
					onBeforeLoad(win) {
						win.localStorage.setItem(
							SESSION_KEY,
							JSON.stringify(seededSession()),
						);
					},
				});
				cy.get('[data-testid="scripted-conversation"]').should("be.visible");
				cy.get('[data-testid="conversation-answer"]')
					.focus()
					.should("be.focused");
				cy.a11y("conversation — question");

				// The composer + live "profile, taking shape" panel after an answer.
				cy.get('[data-testid="conversation-answer"]').type(
					"I'm Casey, a senior frontend engineer.",
				);
				cy.get('[data-testid="conversation-submit"]').click();
				cy.get('[data-testid="captured-about"]').should("be.visible");
				cy.a11y("conversation — profile taking shape");
			});
		});
	}
});
