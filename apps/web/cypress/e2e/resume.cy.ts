/// <reference types="cypress" />

// ARC-103 + ARC-125 (M4 · Résumé upload path) — the résumé-path onboarding E2E.
// It drives the real upload screens through the browser: a signed-in candidate at
// the `intro` step chooses Upload, attaches a fixture résumé, sees the "reading
// every line" processing screen, and lands on profile review.
//
// From ARC-125 the processing screen is driven by the **live AG-UI run**, not a
// timer: the shared client seeds from `GET /agui/threads/:id/history`, subscribes
// to Supabase Realtime, and folds the streamed `state.phase`. These specs mock the
// Realtime stream by stubbing `window.WebSocket` (the transport uses the global
// directly), so a test can push `events` rows and watch the screen advance
// `reading → extracting → building → complete`, fail on `run_error`, or fall back
// to the `/onboarding/progress` poll when the socket delivers nothing.
//
// The backend is mocked at the network layer: a seeded session plus stubbed
// responses for every seam the résumé flow touches — the thread lookup (RLS), the
// Storage upload, the `POST /onboarding/resume` ingest start, the AG-UI history
// restore, and `GET /onboarding/progress`. No file is ever stored and no run is
// ever started. Under CYPRESS_LIVE=1 (where the custom commands are no-ops) these
// specs self-skip, since a real backend won't reproduce the mocked stream
// deterministically.

import { SESSION_KEY, seededSession } from "../support/commands";

const RUN_ID = "test-run-id";

/** One persisted `events` row, the shape Realtime delivers (snake-case run_id). */
interface EventRow {
	type: string;
	data: Record<string, unknown> | null;
	seq: number;
	run_id: string;
}

/** A `state_delta` row that replaces `/phase` (the backend's `flip(phase)`). */
function phaseRow(seq: number, phase: string): EventRow {
	return {
		type: "state_delta",
		data: { delta: [{ op: "replace", path: "/phase", value: phase }] },
		seq,
		run_id: RUN_ID,
	};
}

/** The terminal `complete` delta carrying the proposed draft's ids. */
function completeRow(seq: number): EventRow {
	return {
		type: "state_delta",
		data: {
			delta: [
				{ op: "replace", path: "/phase", value: "complete" },
				{ op: "add", path: "/versionId", value: "test-version-id" },
				{ op: "add", path: "/proposalId", value: "test-proposal-id" },
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
		data: { message: "résumé ingestion failed" },
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
						topic: "realtime:thread:test-thread-id",
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

/** A controller whose `ready` flag flips the mocked progress from intro to review. */
interface ProgressControl {
	ready: boolean;
}

/**
 * Stub every network seam the résumé path touches and return a {@link ProgressControl}.
 *
 * The thread lookup, Storage upload, ingest start, and AG-UI history restore are
 * canned. Progress is the one that has to *change*: the résumé route is only
 * allowed at the `intro` step, so it starts there; flipping `ctrl.ready` makes the
 * next poll report `review` — the reconnect/fallback signal (used by the poll
 * spec; the live specs advance via the Realtime stream instead).
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
		body: { threadId: "test-thread-id", runId: RUN_ID },
	}).as("ingest");

	// AG-UI history restore (the shared client seeds from this, then streams live).
	cy.intercept("GET", "**/agui/threads/*/history", {
		statusCode: 200,
		body: { threadId: "test-thread-id", state: {}, events: [] },
	}).as("history");

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

/** Visit `path` signed-in, with the fake Realtime transport installed at boot. */
function visitSignedIn(path: string) {
	cy.visit(path, {
		onBeforeLoad(win) {
			win.localStorage.setItem(SESSION_KEY, JSON.stringify(seededSession()));
			installFakeRealtime(win);
		},
	});
}

describe("Résumé upload path", () => {
	beforeEach(function () {
		// The intro step + the mocked stream/transition are only deterministic with
		// the stubs; skip the spec against a live backend.
		if (Cypress.env("live")) {
			this.skip();
		}
	});

	it("uploads a résumé → live phases stream → lands on profile review", () => {
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

		// The "reading every line" processing screen takes over; once the ingest
		// start resolves the thread, the client seeds history and streams live.
		cy.get('[data-testid="resume-processing"]').should("be.visible");
		cy.wait("@ingest");
		cy.wait("@history");

		// Drive the real backend phase sequence over Realtime and watch the heading
		// + build log advance with each streamed phase — no timer, no cy.wait.
		pushEvent(phaseRow(0, "reading"));
		cy.get('[data-testid="resume-processing-stage"]').should(
			"contain.text",
			"Reading your résumé",
		);

		pushEvent(phaseRow(1, "extracting"));
		cy.get('[data-testid="resume-build-log"]').should(
			"contain.text",
			"Read your résumé",
		);

		pushEvent(phaseRow(2, "building"));
		cy.get('[data-testid="resume-processing-stage"]').should(
			"contain.text",
			"Building your profile",
		);

		// The proposed draft lands: the run emits `complete` (with the version +
		// proposal ids) and, in the same backend moment, the onboarding step
		// advances to review — so flip the mocked progress to match. The screen
		// advances to review off the live completion, admitted by the review guard.
		cy.then(() => {
			progress.ready = true;
		});
		pushEvent(completeRow(3));
		cy.location("pathname").should("eq", "/onboarding/review");
		cy.get('[data-testid="onboarding-stage-review"]').should("be.visible");
	});

	it("advances via the progress poll when the live socket delivers nothing", () => {
		const progress = stubResumeFlow();

		visitSignedIn("/onboarding/resume");
		cy.get('[data-testid="resume-dropzone"]').should("be.visible");
		cy.get('[data-testid="resume-input"]').selectFile(
			"cypress/fixtures/sample-resume.docx",
			{ force: true },
		);
		cy.get('[data-testid="resume-upload"]').click();

		cy.get('[data-testid="resume-processing"]').should("be.visible");
		cy.wait("@ingest");

		// No Realtime events arrive (a dropped socket). The reconnect/fallback —
		// the `/onboarding/progress` poll — still advances the flow once ready.
		cy.then(() => {
			progress.ready = true;
		});
		cy.location("pathname").should("eq", "/onboarding/review");
		cy.get('[data-testid="onboarding-stage-review"]').should("be.visible");
	});

	it("surfaces a mid-ingest run failure as a recoverable error", () => {
		stubResumeFlow();

		visitSignedIn("/onboarding/resume");
		cy.get('[data-testid="resume-input"]').selectFile(
			"cypress/fixtures/sample-resume.docx",
			{ force: true },
		);
		cy.get('[data-testid="resume-upload"]').click();

		cy.get('[data-testid="resume-processing"]').should("be.visible");
		cy.wait("@ingest");
		cy.wait("@history");

		// A run_error mid-stream surfaces the recoverable error — not the 90s
		// timeout — with its single "Try again".
		pushEvent(phaseRow(0, "reading"));
		pushEvent(errorRow(1));
		cy.get('[data-testid="resume-processing-error"]').should("be.visible");
		cy.get('[data-testid="resume-retry"]').should("be.visible").click();
		cy.get('[data-testid="resume-dropzone"]').should("be.visible");
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
