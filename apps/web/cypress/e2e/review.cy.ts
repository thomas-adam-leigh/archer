/// <reference types="cypress" />

// ARC-109 (M6 · Profile review) + ARC-129 — the profile-review E2E. It reaches the
// review screen via BOTH onboarding paths (résumé upload and the scripted
// conversation finalize — the two ways a candidate arrives at "Here's you, as I
// understand you."), then exercises the review-specific behaviours: the proposed
// draft renders résumé-style (every section), free-text feedback re-runs the draft,
// and "Looks right" approves the proposal and advances to negative criteria (M7).
//
// From ARC-129 the feedback loop is driven by the **live AG-UI revise run**, not a
// dead spinner: clicking "Send to Archer" opens the "Archer is reworking your draft"
// overlay (profile-revising.tsx), which seeds from `GET /agui/threads/:id/history`,
// subscribes to Supabase Realtime, and folds the streamed `state.phase` (`reading →
// revising → complete`). These specs mock the Realtime stream by stubbing
// `window.WebSocket` (the transport uses the global directly), so a test pushes
// `events` rows and watches the overlay advance, hand off to the fresh version, or
// fail on `run_error`. The `/onboarding/progress` poll remains the reconnect fallback.
//
// The backend is mocked at the network layer, mirroring resume.cy.ts/scratch.cy.ts:
// a seeded session plus stubs for every seam — the thread lookup (RLS), the
// path-specific ingest/finalize, the proposed profile version list + detail
// (profile.ts), the AG-UI history restore, `GET /onboarding/progress`, and the
// approve/revise decide calls. A revise lands a NEW proposed version id; the stubs
// flip that id (the draft detail re-reads it) so the refreshed draft shows the
// revised copy. Under CYPRESS_LIVE=1 (where the custom commands are no-ops) the spec
// self-skips, since a real backend won't reproduce the mocked transitions.

import { SESSION_KEY, seededSession } from "../support/commands";

/** The revised summary a feedback run lands, distinct from the fixture's. */
const REVISED_SUMMARY =
	"Revised: staff-level frontend leader focused on accessibility and design systems.";

/** The revise run's thread + run ids (the mocked `POST /onboarding/revise` reply). */
const THREAD_ID = "test-thread-id";
const RUN_ID = "test-run-id";

/** One persisted `events` row, the shape Realtime delivers (snake-case run_id). */
interface EventRow {
	type: string;
	data: Record<string, unknown> | null;
	seq: number;
	run_id: string;
}

/** A `state_delta` row that replaces `/phase` (the backend's revise `flip(phase)`). */
function phaseRow(seq: number, phase: string): EventRow {
	return {
		type: "state_delta",
		data: { delta: [{ op: "replace", path: "/phase", value: phase }] },
		seq,
		run_id: RUN_ID,
	};
}

/** The terminal `complete` delta carrying the FRESH revised draft's ids. */
function completeRow(seq: number, versionId: string): EventRow {
	return {
		type: "state_delta",
		data: {
			delta: [
				{ op: "replace", path: "/phase", value: "complete" },
				{ op: "add", path: "/versionId", value: versionId },
				{ op: "add", path: "/proposalId", value: "test-proposal-id-2" },
			],
		},
		seq,
		run_id: RUN_ID,
	};
}

/** A `run_error` row (the backend's failure tail) — a terminal run failure. */
function errorRow(seq: number): EventRow {
	return {
		type: "run_error",
		data: { message: "revise failed" },
		seq,
		run_id: RUN_ID,
	};
}

/**
 * Install a fake `window.WebSocket` so the shared client's Realtime transport
 * delivers events we control. The whole cumulative event set is redelivered on
 * every push and on socket-open — the client's event log dedupes by `(run_id,
 * seq)`, so this is race-free regardless of when the socket finishes opening.
 */
function installFakeRealtime(win: Cypress.AUTWindow) {
	const w = win as unknown as {
		WebSocket: unknown;
		__rtEvents: EventRow[];
		__rtSockets: Array<{ flush(): void }>;
		__pushEvent(row: EventRow): void;
	};
	w.__rtEvents = [];
	w.__rtSockets = [];

	class FakeWebSocket {
		onopen: (() => void) | null = null;
		onmessage: ((ev: { data: string }) => void) | null = null;
		onerror: (() => void) | null = null;
		onclose: (() => void) | null = null;

		constructor(_url: string) {
			w.__rtSockets.push(this);
			// Defer open so the transport finishes assigning handlers first.
			setTimeout(() => {
				this.onopen?.();
				this.flush();
			}, 0);
		}
		send() {}
		close() {
			this.onclose?.();
		}
		flush() {
			for (const row of w.__rtEvents) {
				this.onmessage?.({
					data: JSON.stringify({
						topic: `realtime:thread:${THREAD_ID}`,
						event: "postgres_changes",
						payload: { data: { record: row } },
						ref: null,
					}),
				});
			}
		}
	}

	w.WebSocket = FakeWebSocket;
	w.__pushEvent = (row: EventRow) => {
		w.__rtEvents.push(row);
		for (const s of w.__rtSockets) s.flush();
	};
}

/** Push one Realtime `events` row into the running app. */
function pushEvent(row: EventRow) {
	cy.window({ log: false }).then((win) => {
		(win as unknown as { __pushEvent(r: EventRow): void }).__pushEvent(row);
	});
}

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
 * lookup, the proposed profile version list + detail, the AG-UI history restore,
 * the progress poll, and the approve/revise decide calls. The path-specific seams
 * (résumé ingest, or the conversation finalize) are layered on by
 * {@link stubResumeArrival} / {@link stubConversationArrival}, which also flip
 * `ctrl.step` to `review`.
 */
function stubReviewBackend(ctrl: ReviewCtrl) {
	// The user's primary thread, read under RLS (threads.ts) — used by both the
	// path arrivals and the feedback run's fetchPrimaryThreadId.
	cy.intercept("GET", "**/rest/v1/threads*", {
		statusCode: 200,
		body: [{ id: THREAD_ID }],
	}).as("threads");

	// AG-UI history restore: the shared client (résumé processing + the revise
	// overlay) seeds from this, then streams live. Empty so the live deltas drive.
	cy.intercept("GET", "**/agui/threads/*/history", {
		statusCode: 200,
		body: { threadId: THREAD_ID, state: {}, events: [] },
	}).as("history");

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

	// Start a revise run (profile.ts → reviseProposedDraft). The overlay then streams
	// the run's events (pushed by the test) and the new version is landed by flipping
	// `ctrl`, so both the live `complete` and the poll fallback have a fresh id to see.
	cy.intercept("POST", "**/onboarding/revise", {
		statusCode: 200,
		body: { threadId: THREAD_ID, runId: RUN_ID },
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
		body: { threadId: THREAD_ID, runId: RUN_ID },
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

/** Visit `path` with a session persisted + the fake Realtime transport installed. */
function visitSignedIn(path: string) {
	cy.visit(path, {
		onBeforeLoad(win) {
			win.localStorage.setItem(SESSION_KEY, JSON.stringify(seededSession()));
			installFakeRealtime(win);
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

	it("conversation path → review → feedback streams a live revise → fresh version lands → approve advances", () => {
		const ctrl = newCtrl();
		stubConversationArrival(ctrl);

		reachReviewViaConversation();
		cy.get('[data-testid="onboarding-stage-review"]').should("be.visible");
		assertAllSectionsRender();

		// Send free-text feedback: the revise run starts and the live "reworking"
		// overlay takes over, driven by the run's real AG-UI phases.
		cy.get('[data-testid="profile-feedback-input"]').type(
			"Lead with my staff-level ambition and accessibility focus.",
		);
		cy.get('[data-testid="profile-feedback-submit"]').click();
		cy.wait("@revise");
		cy.wait("@history");
		cy.get('[data-testid="profile-review-reworking"]').should("be.visible");

		// Stream the backend's revise phases and watch the overlay advance — no timer.
		pushEvent(phaseRow(0, "reading"));
		cy.get('[data-testid="profile-reworking-stage"]').should(
			"contain.text",
			"Reading your notes",
		);

		pushEvent(phaseRow(1, "revising"));
		cy.get('[data-testid="profile-reworking-log"]').should(
			"contain.text",
			"Took your notes on board",
		);

		// The fresh draft lands: flip `ctrl` so the refetched draft carries the new
		// id + revised summary, then stream the terminal `complete` (its versionId
		// differs from the one on screen — the live "revision ready" signal).
		cy.then(() => {
			ctrl.versionId = "test-version-id-2";
			ctrl.versionNo = 2;
			ctrl.summary = REVISED_SUMMARY;
		});
		pushEvent(completeRow(2, "test-version-id-2"));

		// The overlay hands off: it disappears, the revised draft animates in, and the
		// transient "revision landed" cue confirms the new version.
		cy.get('[data-testid="profile-review-reworking"]').should("not.exist");
		cy.get('[data-testid="profile-revision-landed"]')
			.should("be.visible")
			.and("contain.text", "v2");
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

	it("surfaces a revise run failure as a recoverable error", () => {
		const ctrl = newCtrl();
		stubConversationArrival(ctrl);

		reachReviewViaConversation();
		cy.get('[data-testid="onboarding-stage-review"]').should("be.visible");

		cy.get('[data-testid="profile-feedback-input"]').type(
			"Tighten the summary.",
		);
		cy.get('[data-testid="profile-feedback-submit"]').click();
		cy.wait("@revise");
		cy.wait("@history");
		cy.get('[data-testid="profile-review-reworking"]').should("be.visible");

		// A run_error mid-stream surfaces the recoverable error — not the 90s
		// backstop — and the overlay closes so the candidate can retry.
		pushEvent(phaseRow(0, "reading"));
		pushEvent(errorRow(1));
		cy.get('[data-testid="profile-review-reworking"]').should("not.exist");
		cy.get('[data-testid="profile-review-error"]')
			.should("be.visible")
			.and("contain.text", "Couldn't rework your profile");
	});
});
