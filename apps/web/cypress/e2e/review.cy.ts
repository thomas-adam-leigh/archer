/// <reference types="cypress" />

// ARC-109 (M6 · Profile review) — the profile-review E2E. It reaches the review
// screen via BOTH onboarding paths (résumé upload and the scripted conversation
// finalize — the two ways a candidate arrives at "Here's you, as I understand
// you."), then exercises the review-specific behaviours ARC-107/108 added: the
// proposed draft renders résumé-style (every section), free-text feedback re-runs
// the draft and the updated version re-renders, and "Looks right" approves the
// proposal and advances to negative criteria (M7).
//
// The backend is mocked at the network layer, mirroring resume.cy.ts/scratch.cy.ts:
// a seeded session (the way ARC-96 restores a returning user) plus stubs for every
// seam — the thread lookup (RLS), the path-specific ingest/finalize, the proposed
// profile version list + detail (profile.ts), `GET /onboarding/progress`, and the
// approve/revise decide calls. The proposed draft never changes the `step` (it
// stays `review`); a revise lands a NEW proposed version id, which is the only
// "revision ready" signal the web client polls for (profile-review-flow.ts), so
// the stubs flip that id rather than the step. Under CYPRESS_LIVE=1 (where the
// custom commands are no-ops) the spec self-skips, since a real backend won't
// reproduce the mocked transitions deterministically.

import { SESSION_KEY, seededSession } from "../support/commands";

/** The revised summary a feedback run lands, distinct from the fixture's. */
const REVISED_SUMMARY =
	"Revised: staff-level frontend leader focused on accessibility and design systems.";

/**
 * The mutable backend state the review stubs read. `step` drives the progress
 * poll: `review` until approval advances it to `titles` — the real backend step
 * once the draft is approved but titles aren't generated yet, which maps to the
 * negative-criteria route (onboarding-flow.ts). `versionId` + `summary` model the
 * proposed draft, flipped by a revise run so the screen sees a fresh version and
 * re-renders the updated copy.
 */
interface ReviewCtrl {
	step: "intro" | "review" | "titles";
	versionId: string;
	versionNo: number;
	summary: string;
}

/**
 * Stub the review-screen backend (shared by both arrival paths): the thread
 * lookup, the proposed profile version list + detail, the progress poll, and the
 * approve/revise decide calls. The path-specific seams (résumé ingest, or the
 * conversation finalize) are layered on by {@link stubResumeArrival} /
 * {@link stubConversationArrival}, which also flip `ctrl.step` to `review`.
 */
function stubReviewBackend(ctrl: ReviewCtrl) {
	// The user's primary thread, read under RLS (threads.ts) — used by both the
	// path arrivals and the feedback run's fetchPrimaryThreadId.
	cy.intercept("GET", "**/rest/v1/threads*", {
		statusCode: 200,
		body: [{ id: "test-thread-id" }],
	}).as("threads");

	// The proposed profile draft (profile.ts): the user-scoped version list, then
	// the chosen version's detail (attributes + spine). The fixture supplies the
	// rich spine; `ctrl` overrides the id/version/summary so a revise re-render is
	// observable. The two route regexes are mutually exclusive — the list URL ends
	// `versions?…`, the detail URL has `versions/<id>?…`.
	cy.fixture("profile.json").then(
		(profile: {
			attributes: Record<string, unknown>;
			spine: Record<string, unknown>;
		}) => {
			ctrl.summary = profile.attributes.summary as string;

			const version = () => ({
				id: ctrl.versionId,
				status: "proposed",
				version_no: ctrl.versionNo,
				attributes: { ...profile.attributes, summary: ctrl.summary },
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

	// Progress: while `review`, the proposed version id is overridden so a flipped
	// `ctrl` (post-revise) is what the poll reports; `titles` reuses the draft-
	// approved fixture stage with the real backend step, which routes to negative
	// criteria. Bodies come from the shared fixture so the shapes match the suite.
	cy.fixture("onboarding/progress.json").then(
		(stages: Record<string, Record<string, unknown>>) => {
			cy.intercept("GET", "**/onboarding/progress*", (req) => {
				let body: Record<string, unknown>;
				if (ctrl.step === "review") {
					body = { ...stages.review, proposedVersionId: ctrl.versionId };
				} else if (ctrl.step === "titles") {
					body = { ...stages.criteria, step: "titles" };
				} else {
					body = stages.intro;
				}
				req.reply({ statusCode: 200, body });
			}).as("progress");
		},
	);

	// Self-approve the open proposal (profile.ts → approveProposedDraft). Observing
	// it advances the step, so the refetched progress carries the candidate on to
	// negative criteria.
	cy.intercept("POST", "**/onboarding/proposals/*/decide/self", (req) => {
		ctrl.step = "titles";
		req.reply({ statusCode: 200, body: {} });
	}).as("approve");

	// Start a revise run (profile.ts → reviseProposedDraft). The new version is
	// landed by the test (flipping `ctrl`) once this POST is observed, so the
	// poll-for-a-fresh-version loop has something to detect.
	cy.intercept("POST", "**/onboarding/revise", {
		statusCode: 200,
		body: { threadId: "test-thread-id", runId: "test-run-id" },
	}).as("revise");
}

/** Layer the résumé-path seams (Storage upload + ingest start) on the backend. */
function stubResumeArrival(ctrl: ReviewCtrl) {
	stubReviewBackend(ctrl);
	cy.intercept("POST", "**/storage/v1/object/resumes/**", {
		statusCode: 200,
		body: { Key: "resumes/test-user-id/sample-resume.docx" },
	}).as("upload");
	cy.intercept("POST", "**/onboarding/resume", {
		statusCode: 200,
		body: { threadId: "test-thread-id", runId: "test-run-id" },
	}).as("ingest");
}

/** Layer the conversation-path seams (voicenote ingest + guided structurer). */
function stubConversationArrival(ctrl: ReviewCtrl) {
	stubReviewBackend(ctrl);
	cy.intercept("POST", "**/onboarding/voicenote", {
		statusCode: 200,
		body: {},
	}).as("voicenote");
	cy.fixture("transcribe.json").then((body) => {
		cy.intercept("POST", "**/functions/v1/transcribe*", {
			statusCode: 200,
			body,
		}).as("transcribe");
	});
	// The guided structurer proposes the draft — its reply flips progress to review.
	cy.intercept("POST", "**/onboarding/guided", (req) => {
		ctrl.step = "review";
		req.reply({
			statusCode: 200,
			body: { versionId: "test-version-id", proposalId: "test-proposal-id" },
		});
	}).as("guided");
}

/** Visit `path` with a session already persisted so the route guard admits us. */
function visitSignedIn(path: string) {
	cy.visit(path, {
		onBeforeLoad(win) {
			win.localStorage.setItem(SESSION_KEY, JSON.stringify(seededSession()));
		},
	});
}

/** Drive the résumé path from intro to the profile-review screen. */
function reachReviewViaResume(ctrl: ReviewCtrl) {
	visitSignedIn("/onboarding/intro");
	cy.get('[data-testid="intro-path-resume"]').click();
	cy.get('[data-testid="resume-input"]').selectFile(
		"cypress/fixtures/sample-resume.docx",
		{ force: true },
	);
	cy.get('[data-testid="resume-upload"]').click();
	// Once the ingest is in flight, let the next progress poll report the draft.
	cy.wait("@ingest");
	cy.then(() => {
		ctrl.step = "review";
	});
	cy.location("pathname").should("eq", "/onboarding/review");
}

// The six preset answers (onboarding-script.ts order), driven via the always-present
// text fallback so the run needs no MediaRecorder.
const ANSWERS: readonly string[] = [
	"I'm Casey Rivera, a senior frontend engineer.",
	"Most recently at Northwind Labs leading the design system.",
	"Before that, agency work building accessible React apps.",
	"BSc Computer Science, plus a lot of self-teaching.",
	"React, TypeScript, and accessibility are my strengths.",
	"A staff-level frontend role at a product company.",
];

/** Drive the scripted conversation path from intro to the profile-review screen. */
function reachReviewViaConversation() {
	visitSignedIn("/onboarding/intro");
	cy.get('[data-testid="intro-path-conversation"]').click();
	cy.get('[data-testid="scripted-conversation"]').should("be.visible");
	ANSWERS.forEach((text) => {
		cy.get('[data-testid="conversation-answer"]').clear().type(text);
		cy.get('[data-testid="conversation-submit"]').click();
	});
	cy.get('[data-testid="conversation-finalize"]').click();
	cy.wait("@guided");
	cy.location("pathname").should("eq", "/onboarding/review");
}

/** Assert the proposed draft renders résumé-style with every populated section. */
function assertAllSectionsRender() {
	cy.get('[data-testid="profile-review-card"]').should("be.visible");
	cy.get('[data-testid="profile-name"]').should("contain.text", "Casey Rivera");
	cy.get('[data-testid="profile-summary"]').should(
		"contain.text",
		"Senior frontend engineer",
	);
	cy.get('[data-testid="profile-experience"]')
		.should("be.visible")
		.and("contain.text", "Northwind Labs");
	cy.get('[data-testid="profile-education"]')
		.should("be.visible")
		.and("contain.text", "University of Bristol");
	// Certifications + courses are merged into "Courses & Certifications".
	cy.get('[data-testid="profile-certifications"]')
		.should("be.visible")
		.and("contain.text", "CPACC");
	cy.get('[data-testid="profile-skills"]')
		.should("be.visible")
		.and("contain.text", "TypeScript");
}

function newCtrl(): ReviewCtrl {
	return {
		step: "intro",
		versionId: "test-version-id",
		versionNo: 1,
		summary: "",
	};
}

describe("Profile review (M6)", () => {
	beforeEach(function () {
		// The mocked path → review → decide transitions are only deterministic with
		// the stubs; skip against a live backend.
		if (Cypress.env("live")) {
			this.skip();
		}
	});

	it("résumé path → review renders every section → approve advances to criteria", () => {
		const ctrl = newCtrl();
		stubResumeArrival(ctrl);

		reachReviewViaResume(ctrl);
		cy.get('[data-testid="onboarding-stage-review"]').should("be.visible");

		// The proposed draft renders résumé-style with all populated sections.
		assertAllSectionsRender();

		// Approve the open proposal → the step advances → the guard carries the
		// candidate to negative criteria (M7).
		cy.get('[data-testid="profile-approve"]').click();
		cy.wait("@approve");
		cy.location("pathname").should("eq", "/onboarding/criteria");
		cy.get('[data-testid="onboarding-stage-criteria"]').should("be.visible");
	});

	it("conversation path → review → feedback re-runs the draft → approve advances", () => {
		const ctrl = newCtrl();
		stubConversationArrival(ctrl);

		reachReviewViaConversation();
		cy.get('[data-testid="onboarding-stage-review"]').should("be.visible");
		assertAllSectionsRender();

		// Send free-text feedback: the revise run starts, the "reworking" overlay
		// takes over, and once a fresh proposed version lands the updated draft
		// re-renders with the revised summary.
		cy.get('[data-testid="profile-feedback-input"]').type(
			"Lead with my staff-level ambition and accessibility focus.",
		);
		cy.get('[data-testid="profile-feedback-submit"]').click();
		cy.wait("@revise");
		cy.get('[data-testid="profile-review-reworking"]').should("be.visible");

		// Land the revised version (a new id + summary) — the poll detects it.
		cy.then(() => {
			ctrl.versionId = "test-version-id-2";
			ctrl.versionNo = 2;
			ctrl.summary = REVISED_SUMMARY;
		});
		cy.get('[data-testid="profile-review-reworking"]').should("not.exist");
		cy.get('[data-testid="profile-summary"]').should(
			"contain.text",
			"Revised: staff-level frontend leader",
		);

		// The revised draft is still approvable → approve advances to criteria.
		cy.get('[data-testid="profile-approve"]').click();
		cy.wait("@approve");
		cy.location("pathname").should("eq", "/onboarding/criteria");
		cy.get('[data-testid="onboarding-stage-criteria"]').should("be.visible");
	});
});
