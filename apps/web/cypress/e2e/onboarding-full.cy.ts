/// <reference types="cypress" />

// ARC-115 (M8 · Home / onboarding complete) — the capstone E2E: the cumulative
// journey a candidate makes from a brand-new account all the way out of
// onboarding, driven through the browser for BOTH entry paths:
//
//   Path A (résumé):       sign up → intro → upload → processing → review →
//                          approve → criteria → submit → home.
//   Path B (conversation): sign up → intro → start from scratch → scripted Q&A →
//                          finalize → review → approve → criteria → submit → home.
//
// Where the per-milestone specs (auth/intro/resume/scratch/review/criteria) each
// prove one stage, this one proves the stages compose: a single mutable `ctrl`
// drives `/onboarding/progress` forward through the whole step machine (intro →
// review → titles → done) while every seam each stage touches is stubbed at the
// network layer, so no account is created and no profile is written. The progress
// indicator (route-driven via staticData.onboardingStep) is asserted to advance
// 1 → 2 → 3 → 4 and then hide on home, and home is asserted to render the
// onboarding outputs Archer hunts with (target titles + rule-outs).
//
// This is the suite the M9 gate promotion (ARC-118) guards. Under CYPRESS_LIVE=1
// the custom commands are no-ops and a real backend won't reproduce the mocked
// stage transitions deterministically, so the spec self-skips.

import { SESSION_KEY, seededSession } from "../support/commands";

const email = "candidate@example.com";
const password = "password123";

/** Archer's ranked target titles, read on the criteria + home stages. */
const SUGGESTED_TITLES: readonly string[] = [
	"Senior Frontend Engineer",
	"Staff Frontend Engineer",
	"Frontend Platform Engineer",
];

/** The rule-out the candidate captures on the criteria stage. */
const RULE_OUT = "nothing in .NET or C#";

/** The six preset answers (onboarding-script.ts order), driven via the text fallback. */
const ANSWERS: readonly { key: string; text: string }[] = [
	{ key: "about", text: "I'm Casey Rivera, a senior frontend engineer." },
	{ key: "recent", text: "Most recently at Northwind Labs leading the design system." },
	{ key: "path", text: "Before that, agency work building accessible React apps." },
	{ key: "education", text: "BSc Computer Science, plus a lot of self-teaching." },
	{ key: "skills", text: "React, TypeScript, and accessibility are my strengths." },
	{ key: "ambition", text: "A staff-level frontend role at a product company." },
];

/** A saved rule-out (the `{ id, text }` row `POST /criteria` returns). */
interface Criterion {
	id: string;
	text: string;
}

/**
 * The single mutable backend state the whole journey reads. `step` drives the
 * progress poll across every stage — it advances `intro → review` when the path's
 * draft lands, `review → titles` on approve, and `titles → done` on submit, which
 * the resume guard maps to intro/review/criteria/home respectively. `versionId`
 * models the proposed draft the review screen renders; `criteria`/`seq` model the
 * captured rule-outs (served live so an add is reflected on the criteria + home
 * reads).
 */
interface FullCtrl {
	step: "intro" | "review" | "titles" | "done";
	versionId: string;
	criteria: Criterion[];
	seq: number;
}

function newCtrl(): FullCtrl {
	return { step: "intro", versionId: "test-version-id", criteria: [], seq: 0 };
}

/**
 * Stub every network seam the full journey touches, keyed off one {@link FullCtrl}.
 * The path-specific arrival seams (résumé upload/ingest, or conversation
 * voicenote/transcribe/guided) are both registered; whichever path the test drives
 * flips `ctrl.step` to `review` (the résumé ingest is awaited by the test, the
 * guided structurer flips it as it replies).
 */
function stubFullBackend(ctrl: FullCtrl) {
	// Sign-up creates the session the rest of the journey runs under.
	cy.signup(email, password);

	// The user's primary thread, read under RLS (threads.ts) — used by both paths.
	cy.intercept("GET", "**/rest/v1/threads*", {
		statusCode: 200,
		body: [{ id: "test-thread-id" }],
	}).as("threads");

	// Progress: the spine of the journey. Each `step` reports the matching stage
	// body from the shared fixture so the shapes match the rest of the suite; the
	// review step overrides the proposed version id the screen reads, `titles`
	// carries the real backend step that routes to criteria, and `done` is the
	// completed shape that routes to home.
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

	// --- Review seams (profile.ts): the proposed version list + detail, served
	// from the rich profile.json spine so every résumé-style section renders. ---
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

	// Approve the open proposal (profile.ts → approveProposedDraft): advance the
	// step so the refetched progress carries the candidate on to negative criteria.
	cy.intercept("POST", "**/onboarding/proposals/*/decide/self", (req) => {
		ctrl.step = "titles";
		req.reply({ statusCode: 200, body: {} });
	}).as("approve");

	// --- Criteria seams (preferences.ts): the suggested titles, the rule-out
	// list/add, and the submit's titles-approve + onboarding-complete writes. ---
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

	// --- Résumé-path arrival seams (resume.ts): Storage upload + ingest start. ---
	cy.intercept("POST", "**/storage/v1/object/resumes/**", {
		statusCode: 200,
		body: { Key: "resumes/test-user-id/sample-resume.docx" },
	}).as("upload");
	cy.intercept("POST", "**/onboarding/resume", {
		statusCode: 200,
		body: { threadId: "test-thread-id", runId: "test-run-id" },
	}).as("ingest");

	// --- Conversation-path arrival seams (conversation.ts): voicenote ingest,
	// the shared transcribe seam, and the guided structurer that proposes the
	// draft (the only AI in the path) and flips progress to review. ---
	cy.intercept("POST", "**/onboarding/voicenote", { statusCode: 200, body: {} }).as(
		"voicenote",
	);
	cy.fixture("transcribe.json").then((body) => {
		cy.intercept("POST", "**/functions/v1/transcribe*", {
			statusCode: 200,
			body,
		}).as("transcribe");
	});
	cy.intercept("POST", "**/onboarding/guided", (req) => {
		ctrl.step = "review";
		req.reply({
			statusCode: 200,
			body: { versionId: "test-version-id", proposalId: "test-proposal-id" },
		});
	}).as("guided");
}

/** Fill the auth form's email + password fields. */
function fillCredentials(mail: string, pass: string) {
	cy.get('[data-testid="auth-form"]').within(() => {
		cy.get('input[type="email"]').clear().type(mail);
		cy.get('input[type="password"]').clear().type(pass);
	});
}

/** Assert the route-driven progress indicator is lit to `segment` (1-based). */
function assertProgress(segment: number) {
	cy.get('[data-testid="onboarding-progress"]').should(
		"have.attr",
		"aria-valuenow",
		String(segment),
	);
}

/** Sign up a fresh account through the UI and enter onboarding at the intro. */
function signUpToIntro() {
	cy.visit("/auth");
	cy.contains("button", "Don't have an account? Sign up").click();
	cy.contains("h1", "Create account").should("be.visible");
	fillCredentials(email, password);
	cy.get('button[type="submit"]').click();

	// Mocked sign-up 200 → session persisted → the welcome landing renders.
	cy.wait("@signup");
	cy.location("pathname").should("eq", "/");
	cy.contains("h1", "Never apply for a job").should("be.visible");

	// "Get started" enters /onboarding, which resumes the fresh account at intro.
	cy.contains("button", "Get started").click();
	cy.location("pathname").should("eq", "/onboarding/intro");
	cy.contains("h1", "Hi, I'm Archer.").should("be.visible");
	assertProgress(1);
}

/** Assert the proposed draft renders résumé-style with every populated section. */
function assertReviewSections() {
	cy.get('[data-testid="profile-name"]').should("contain.text", "Casey Rivera");
	cy.get('[data-testid="profile-summary"]').should(
		"contain.text",
		"Senior frontend engineer",
	);
	cy.get('[data-testid="profile-experience"]').should(
		"contain.text",
		"Northwind Labs",
	);
	cy.get('[data-testid="profile-education"]').should(
		"contain.text",
		"University of Bristol",
	);
	cy.get('[data-testid="profile-skills"]').should("contain.text", "TypeScript");
}

/** Approve the proposed draft → advance to the criteria (hunt-setup) stage. */
function reviewApproveToCriteria() {
	cy.get('[data-testid="onboarding-stage-review"]').should("be.visible");
	assertProgress(3);
	assertReviewSections();

	cy.get('[data-testid="profile-approve"]').click();
	cy.wait("@approve");
	cy.location("pathname").should("eq", "/onboarding/criteria");
}

/** Capture a rule-out, submit the hunt setup, and land on home. */
function criteriaSubmitToHome() {
	cy.get('[data-testid="onboarding-stage-criteria"]').should("be.visible");
	assertProgress(4);
	cy.get('[data-testid="target-titles-list"]')
		.should("be.visible")
		.and("contain.text", "Senior Frontend Engineer");

	// Submit is gated until a rule-out exists.
	cy.get('[data-testid="hunt-setup-submit"]').should("be.disabled");
	cy.get('[data-testid="criteria-input"]').type(RULE_OUT);
	cy.get('[data-testid="criteria-add"]').click();
	cy.wait("@addCriterion");
	cy.get('[data-testid="criteria-list"]').should("contain.text", RULE_OUT);

	// "Send to Archer →": approve titles + complete onboarding → the step flips to
	// `done` and the resume guard forwards the candidate out of onboarding to home.
	cy.get('[data-testid="hunt-setup-submit"]').should("be.enabled").click();
	cy.wait("@approveTitles");
	cy.wait("@complete");
	cy.location("pathname").should("eq", "/onboarding/home");
}

/** Assert home renders the resting dashboard with the onboarding outputs. */
function assertHomeOutputs() {
	cy.get('[data-testid="onboarding-stage-home"]').should("be.visible");
	// Post-onboarding the route-driven indicator hides (home's segment is undefined).
	cy.get('[data-testid="onboarding-progress"]').should("not.exist");

	cy.get('[data-testid="home-next-run"]').should("be.visible");
	cy.get('[data-testid="home-target-titles"]')
		.should("be.visible")
		.and("contain.text", "Senior Frontend Engineer");
	cy.get('[data-testid="home-rule-outs"]')
		.should("be.visible")
		.and("contain.text", RULE_OUT);
	cy.get('[data-testid="home-activity"]').should("be.visible");
}

describe("Full onboarding journey (M8)", () => {
	beforeEach(function () {
		// The mocked sign-up → stage transitions are only deterministic with the
		// stubs; skip the whole journey against a live backend.
		if (Cypress.env("live")) {
			this.skip();
		}
	});

	it("Path A: sign up → upload résumé → review → criteria → home", () => {
		const ctrl = newCtrl();
		stubFullBackend(ctrl);

		signUpToIntro();

		// Choose Upload → the résumé dropzone (still segment 2 of the flow).
		cy.get('[data-testid="intro-path-resume"]').click();
		cy.location("pathname").should("eq", "/onboarding/resume");
		assertProgress(2);

		// Attach the fixture résumé, start the upload, see the processing screen.
		cy.get('[data-testid="resume-input"]').selectFile(
			"cypress/fixtures/sample-resume.docx",
			{ force: true },
		);
		cy.get('[data-testid="resume-selected"]').should("be.visible");
		cy.get('[data-testid="resume-upload"]').click();
		cy.get('[data-testid="resume-processing"]').should("be.visible");

		// Once the ingest is in flight, let the next progress poll report the draft.
		cy.wait("@ingest");
		cy.then(() => {
			ctrl.step = "review";
		});
		cy.location("pathname").should("eq", "/onboarding/review");

		reviewApproveToCriteria();
		criteriaSubmitToHome();
		assertHomeOutputs();
	});

	it("Path B: sign up → start from scratch → converse → review → criteria → home", () => {
		const ctrl = newCtrl();
		stubFullBackend(ctrl);

		signUpToIntro();

		// Choose Start from scratch → the scripted conversation (still segment 2).
		cy.get('[data-testid="intro-path-conversation"]').click();
		cy.location("pathname").should("eq", "/onboarding/conversation");
		assertProgress(2);
		cy.get('[data-testid="scripted-conversation"]').should("be.visible");

		// Answer each preset step; every answer accretes into the live panel.
		ANSWERS.forEach((answer) => {
			cy.get('[data-testid="conversation-answer"]').clear().type(answer.text);
			cy.get('[data-testid="conversation-submit"]').click();
			cy.get(`[data-testid="captured-${answer.key}"]`)
				.should("be.visible")
				.and("contain.text", answer.text);
		});

		// Finalize: persist each answer (voicenote ×6) then structure them (guided),
		// whose reply flips progress to review.
		cy.get('[data-testid="conversation-finalize"]').click();
		cy.get("@voicenote.all").should("have.length", ANSWERS.length);
		cy.wait("@guided");
		cy.location("pathname").should("eq", "/onboarding/review");

		reviewApproveToCriteria();
		criteriaSubmitToHome();
		assertHomeOutputs();
	});
});
