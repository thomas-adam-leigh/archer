/// <reference types="cypress" />

// ARC-106 (M5 · Start from scratch) — the scratch-path onboarding E2E. It drives
// the real scripted Q&A through the browser: a signed-in candidate at the `intro`
// step chooses "Start from scratch", answers each preset question (ARC-104), watches
// the live "profile, taking shape" panel accrete every answer (ARC-105), then
// finalizes — which structures the captured answers into a PROPOSED profile draft
// and lands on profile review, the convergence point both paths reach.
//
// The backend is mocked at the network layer: a seeded session (the way ARC-96
// restores a returning user from localStorage) plus stubbed responses for every
// seam the finalize touches — the thread lookup (RLS), the per-answer voicenote
// ingest, the `/onboarding/guided` structurer (the only AI in this path), and
// `GET /onboarding/progress`. No thread is written and no profile is structured for
// real. Per the path's design (onboarding copy is static — no `/agui/run` chat),
// the only AI seams are transcription + the guided extraction; the spec drives the
// text fallback for the answers (deterministic, no MediaRecorder), and registers
// the transcribe seam the voice control shares. Under CYPRESS_LIVE=1 (where the
// custom commands are no-ops) the spec self-skips, since a real backend won't
// reproduce the mocked finalize → review transition deterministically.

import { SESSION_KEY, seededSession } from "../support/commands";

/** A controller whose `ready` flag flips the mocked progress from intro to review. */
interface ProgressControl {
	ready: boolean;
}

/**
 * Stub every network seam the scratch path touches and return a {@link ProgressControl}.
 *
 * The thread lookup, the per-answer voicenote ingest, and the transcribe seam are
 * canned. Progress is the one that has to *change*: the conversation route is only
 * allowed at the `intro` step, so it starts there; the guided structurer flips
 * `ctrl.ready` as it replies, so the post-finalize progress refetch (the review
 * guard's read) reports `review` and admits the candidate — the same readiness
 * signal the real backend exposes once a draft is proposed.
 */
function stubScratchFlow(): ProgressControl {
	const ctrl: ProgressControl = { ready: false };

	// The user's primary thread, read straight from Supabase under RLS (threads.ts).
	cy.intercept("GET", "**/rest/v1/threads*", {
		statusCode: 200,
		body: [{ id: "test-thread-id" }],
	}).as("threads");

	// Each captured answer persisted to the thread as a message (conversation.ts →
	// ingestAnswer); the audio never leaves the browser, only the text is sent.
	cy.intercept("POST", "**/onboarding/voicenote", {
		statusCode: 200,
		body: {},
	}).as("voicenote");

	// The voice control's transcribe seam (voice.ts → transcribe). The answers below
	// are typed (the always-present text fallback) so the run needs no MediaRecorder,
	// but the path shares this seam, so it's stubbed like the rest.
	cy.fixture("transcribe.json").then((body) => {
		cy.intercept("POST", "**/functions/v1/transcribe*", {
			statusCode: 200,
			body,
		}).as("transcribe");
	});

	// The guided structurer: reads the thread's gathered answers and submits a
	// PROPOSED profile version (conversation.ts → finalizeGuidedOnboarding). This is
	// the only AI in the path; replying here flips progress to `review`.
	cy.intercept("POST", "**/onboarding/guided", (req) => {
		ctrl.ready = true;
		req.reply({
			statusCode: 200,
			body: { versionId: "test-version-id", proposalId: "test-proposal-id" },
		});
	}).as("guided");

	// Progress: intro until the draft is proposed, then review. Per-stage bodies
	// come from the shared fixture so the shapes match the rest of the suite.
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

/** One scripted answer: the step key (for the live-panel assertion) + the text. */
interface ScriptedAnswer {
	key: string;
	text: string;
}

// Answers for the six preset steps, in script order (onboarding-script.ts):
// about → recent → path → education → skills → ambition.
const ANSWERS: readonly ScriptedAnswer[] = [
	{ key: "about", text: "I'm Casey Rivera, a senior frontend engineer." },
	{ key: "recent", text: "Most recently at Northwind Labs leading the design system." },
	{ key: "path", text: "Before that, agency work building accessible React apps." },
	{ key: "education", text: "BSc Computer Science, plus a lot of self-teaching." },
	{ key: "skills", text: "React, TypeScript, and accessibility are my strengths." },
	{ key: "ambition", text: "A staff-level frontend role at a product company." },
];

/** Type the current step's answer and submit it, advancing the script by one. */
function answerStep(text: string) {
	cy.get('[data-testid="conversation-answer"]').clear().type(text);
	cy.get('[data-testid="conversation-submit"]').click();
}

describe("Start-from-scratch path", () => {
	beforeEach(function () {
		// The intro step + the mocked finalize → review transition are only
		// deterministic with the stubs; skip the spec against a live backend.
		if (Cypress.env("live")) {
			this.skip();
		}
	});

	it("answers the scripted Q&A → profile builds live → lands on review", () => {
		stubScratchFlow();

		// Intro → choose Start from scratch → the scripted conversation.
		visitSignedIn("/onboarding/intro");
		cy.get('[data-testid="intro-path-conversation"]').click();
		cy.location("pathname").should("eq", "/onboarding/conversation");
		cy.get('[data-testid="scripted-conversation"]').should("be.visible");

		// The live panel starts empty and the counter is on the first question.
		cy.get('[data-testid="profile-shape"]').should("contain.text", "Nothing yet");
		cy.get('[data-testid="conversation-progress"]').should(
			"contain.text",
			"Question 1 of 6",
		);

		// Answer each preset step; every answer accretes into the live panel and the
		// question counter advances.
		ANSWERS.forEach((answer, i) => {
			cy.get('[data-testid="conversation-prompt"]').should("be.visible");
			answerStep(answer.text);

			// The captured answer shows in the "profile, taking shape" panel.
			cy.get(`[data-testid="captured-${answer.key}"]`)
				.should("be.visible")
				.and("contain.text", answer.text);

			// The counter advances until the last answer completes the sequence.
			if (i < ANSWERS.length - 1) {
				cy.get('[data-testid="conversation-progress"]').should(
					"contain.text",
					`Question ${i + 2} of 6`,
				);
			}
		});

		// Every question answered → the finalize panel, reporting all six captures.
		cy.get('[data-testid="conversation-complete"]')
			.should("be.visible")
			.and("contain.text", "6 answers captured");

		// Finalize: persist each answer (voicenote ×6) then structure them (guided).
		cy.get('[data-testid="conversation-finalize"]').click();
		cy.get("@voicenote.all").should("have.length", ANSWERS.length);
		cy.wait("@guided");

		// The guided reply flipped progress to review, so the finalize hand-off lands
		// on the profile-review stage (the convergence point of both paths).
		cy.location("pathname").should("eq", "/onboarding/review");
		cy.get('[data-testid="onboarding-stage-review"]').should("be.visible");
	});

	it("an optional step can be skipped and still finalizes", () => {
		stubScratchFlow();

		visitSignedIn("/onboarding/conversation");
		cy.get('[data-testid="scripted-conversation"]').should("be.visible");

		// Answer the two required openers, then skip the first optional step ("path").
		answerStep(ANSWERS[0].text);
		answerStep(ANSWERS[1].text);
		cy.get('[data-testid="conversation-skip"]').should("be.visible").click();

		// The skipped step never lands in the live panel; the answered ones do.
		cy.get('[data-testid="captured-path"]').should("not.exist");
		cy.get('[data-testid="captured-about"]').should("be.visible");
		cy.get('[data-testid="captured-recent"]').should("be.visible");

		// Finish the remaining steps (education optional, then skills + ambition).
		answerStep(ANSWERS[3].text);
		answerStep(ANSWERS[4].text);
		answerStep(ANSWERS[5].text);

		// Five answers captured (path was skipped); finalize still reaches review.
		cy.get('[data-testid="conversation-complete"]')
			.should("be.visible")
			.and("contain.text", "5 answers captured");
		cy.get('[data-testid="conversation-finalize"]').click();
		cy.wait("@guided");

		cy.location("pathname").should("eq", "/onboarding/review");
		cy.get('[data-testid="onboarding-stage-review"]').should("be.visible");
	});
});
