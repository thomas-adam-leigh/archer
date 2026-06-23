/// <reference types="cypress" />

// ARC-103 (M4 · Résumé upload path) — the résumé-path onboarding E2E. It drives
// the real upload screens through the browser: a signed-in candidate at the
// `intro` step chooses Upload, attaches a fixture résumé, sees the "reading every
// line" processing screen (ARC-102), and lands on profile review once the ingest
// reports the draft is ready. It also covers the two non-happy exits — an
// unsupported file type is rejected with a friendly error, and "Talk to me
// instead" escapes to the conversation path.
//
// The backend is mocked at the network layer: a seeded session (the way ARC-96
// restores a returning user from localStorage) plus stubbed responses for every
// seam the résumé flow touches — the thread lookup (RLS), the Storage upload, the
// `POST /onboarding/resume` ingest start, and `GET /onboarding/progress`. No file
// is ever stored and no run is ever started. Under CYPRESS_LIVE=1 (where the
// custom commands are no-ops) these specs self-skip, since a real backend won't
// reproduce the mocked ingest → review transition deterministically.

import { SESSION_KEY, seededSession } from "../support/commands";

/** A controller whose `ready` flag flips the mocked progress from intro to review. */
interface ProgressControl {
	ready: boolean;
}

/**
 * Stub every network seam the résumé path touches and return a {@link ProgressControl}.
 *
 * The thread lookup, Storage upload, and ingest start are canned. Progress is the
 * one that has to *change*: the résumé route is only allowed at the `intro` step,
 * so it starts there; flipping `ctrl.ready` (after the ingest POST is observed)
 * makes the next poll report `review`, which is what ends the wait and advances
 * the candidate — the same readiness signal the real backend exposes.
 */
function stubResumeFlow(): ProgressControl {
	const ctrl: ProgressControl = { ready: false };

	// The user's primary thread, read straight from Supabase under RLS (threads.ts).
	cy.intercept("GET", "**/rest/v1/threads*", {
		statusCode: 200,
		body: [{ id: "test-thread-id" }],
	}).as("threads");

	// The Storage upload to resumes/{uid}/{filename} (resume.ts → uploadResume).
	cy.intercept("POST", "**/storage/v1/object/resumes/**", {
		statusCode: 200,
		body: { Key: "resumes/test-user-id/sample-resume.docx" },
	}).as("upload");

	// Starting the streamed ingest run (resume.ts → startResumeIngest).
	cy.intercept("POST", "**/onboarding/resume", {
		statusCode: 200,
		body: { threadId: "test-thread-id", runId: "test-run-id" },
	}).as("ingest");

	// Progress: intro until the draft lands, then review. Per-stage bodies come
	// from the shared fixture so the shapes match the rest of the suite.
	cy.fixture("onboarding/progress.json").then(
		(stages: Record<string, Record<string, unknown>>) => {
			cy.intercept("GET", "**/onboarding/progress*", (req) => {
				req.reply({
					statusCode: 200,
					body: ctrl.ready ? stages.review : stages.intro,
				});
			}).as("progress");
		},
	);

	return ctrl;
}

/** Visit `path` with a session already persisted so the route guard admits us. */
function visitSignedIn(path: string) {
	cy.visit(path, {
		onBeforeLoad(win) {
			win.localStorage.setItem(SESSION_KEY, JSON.stringify(seededSession()));
		},
	});
}

describe("Résumé upload path", () => {
	beforeEach(function () {
		// The intro step + the mocked ingest → review transition are only
		// deterministic with the stubs; skip the spec against a live backend.
		if (Cypress.env("live")) {
			this.skip();
		}
	});

	it("uploads a résumé → processing → lands on profile review", () => {
		const progress = stubResumeFlow();

		// Intro → choose Upload → résumé dropzone.
		visitSignedIn("/onboarding/intro");
		cy.get('[data-testid="intro-path-resume"]').click();
		cy.location("pathname").should("eq", "/onboarding/resume");
		cy.get('[data-testid="resume-dropzone"]').should("be.visible");

		// Attach the fixture résumé (the input is visually hidden, so force it),
		// confirm the selected state, then start the upload.
		cy.get('[data-testid="resume-input"]').selectFile(
			"cypress/fixtures/sample-resume.docx",
			{ force: true },
		);
		cy.get('[data-testid="resume-selected"]').should("be.visible");
		cy.get('[data-testid="resume-upload"]').click();

		// The "reading every line" processing screen takes over while the run builds.
		cy.get('[data-testid="resume-processing"]').should("be.visible");
		cy.contains("I'm reading every line").should("be.visible");

		// Once the ingest POST is in flight, let the next progress poll report the
		// finished draft — that readiness signal advances us to review.
		cy.wait("@ingest");
		cy.then(() => {
			progress.ready = true;
		});

		cy.location("pathname").should("eq", "/onboarding/review");
		cy.get('[data-testid="onboarding-stage-review"]').should("be.visible");
	});

	it("rejects an unsupported file type with a friendly error", () => {
		stubResumeFlow();

		visitSignedIn("/onboarding/resume");
		cy.get('[data-testid="resume-dropzone"]').should("be.visible");

		cy.get('[data-testid="resume-input"]').selectFile(
			"cypress/fixtures/not-a-resume.txt",
			{ force: true },
		);

		cy.get('[data-testid="resume-error"]')
			.should("be.visible")
			.and("contain.text", "PDF or Word");
		// A rejected file never reaches the selected/upload state.
		cy.get('[data-testid="resume-selected"]').should("not.exist");
		cy.get('[data-testid="resume-upload"]').should("not.exist");
	});

	it("'Talk to me instead' escapes to the conversation stage", () => {
		stubResumeFlow();

		visitSignedIn("/onboarding/resume");
		cy.get('[data-testid="resume-talk-instead"]').click();

		cy.location("pathname").should("eq", "/onboarding/conversation");
		cy.get('[data-testid="scripted-conversation"]').should("be.visible");
	});
});
