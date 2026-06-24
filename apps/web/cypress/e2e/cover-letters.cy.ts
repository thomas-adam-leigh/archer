/// <reference types="cypress" />

// ARC-150 (M3 · Cover letters — review → revise → approve) — the cover-letters
// cockpit is the daily heartbeat / one human gate before Archer applies. The list
// shows the candidacies whose letter is the candidate's to act on (`in_review`,
// `drafting`, `approved`), each linking to a review. The review presents the proposed
// letter with version history + spoken-note playback, then either approves it
// (self-decide the open proposal) or sends feedback (reject with the note) →
// "Archer is reworking your letter" → the reworked draft's fresh proposal re-presents.
// This spec drives all three through the browser with the backend mocked at the
// network layer. Under CYPRESS_LIVE=1 the mocks are skipped and a real backend won't
// reproduce these states, so the spec self-skips.

import { SESSION_KEY, seededSession } from "../support/commands";

const BOARDS = [
	{ slug: "pnet", name: "PNet", collect_status: "integrated", apply_status: "not_integrated" },
];

const CANDIDACY = "33333333-3333-3333-3333-333333333333";
const V1 = "11111111-aaaa-1111-aaaa-111111111111";
const V2 = "22222222-bbbb-2222-bbbb-222222222222";
const P1 = "aaaaaaaa-1111-aaaa-1111-aaaaaaaaaaaa";
const P2 = "bbbbbbbb-2222-bbbb-2222-bbbbbbbbbbbb";

/** A candidacy whose letter needs the candidate's review (the list's primary state). */
const IN_REVIEW = {
	id: CANDIDACY,
	status: "in_review",
	triage_decision: "shortlisted",
	match_score: 87,
	posting_title: "Senior Backend Engineer",
	board_slug: "pnet",
	company_name: "Acme",
	created_at: "2026-06-24T09:00:00Z",
};

/** The first (proposed) version's full content + a spoken-note artifact. */
const VERSION_1 = {
	id: V1,
	version_no: 1,
	status: "proposed",
	content: "Dear hiring manager,\n\nI'm excited to apply for the Senior Backend role.",
	details: {
		spokenNote: { audioUrl: "https://cdn.example/note-1.mp3", provider: "elevenlabs" },
	},
};

/** The reworked (v2) version that lands after feedback. */
const VERSION_2 = {
	id: V2,
	version_no: 2,
	status: "proposed",
	content: "Dear hiring manager,\n\nWith deep fintech experience, I'd love to join Acme.",
	details: null,
};

/** Stub the cockpit list reads (the three relevant statuses) + boards. */
function stubList(inReview: object[], drafting: object[], approved: object[]) {
	cy.intercept({ method: "GET", url: /\/jobs\?.*status=in_review/ }, {
		statusCode: 200,
		body: { user: "test-user-id", jobs: inReview },
	}).as("listInReview");
	cy.intercept({ method: "GET", url: /\/jobs\?.*status=drafting/ }, {
		statusCode: 200,
		body: { user: "test-user-id", jobs: drafting },
	}).as("listDrafting");
	cy.intercept({ method: "GET", url: /\/jobs\?.*status=approved/ }, {
		statusCode: 200,
		body: { user: "test-user-id", jobs: approved },
	}).as("listApproved");
	cy.intercept("GET", "**/boards", { statusCode: 200, body: { boards: BOARDS } }).as("boards");
}

/** Visit a path with a restored session so the guard treats us as signed-in. */
function visitSignedIn(path: string) {
	cy.visit(path, {
		onBeforeLoad(win) {
			win.localStorage.setItem(SESSION_KEY, JSON.stringify(seededSession()));
		},
	});
}

describe("Cover letters — cockpit list (M3)", () => {
	beforeEach(function () {
		if (Cypress.env("live")) this.skip();
	});

	it("lists candidacies needing review with their state + board, linking to the review", () => {
		stubList([IN_REVIEW], [], []);
		cy.intercept("GET", "**/candidacies/*/cover-letters", {
			statusCode: 200,
			body: { versions: [VERSION_1], openProposalId: P1, proposedVersionId: V1 },
		});
		cy.intercept("GET", `**/cover-letters/${V1}`, { statusCode: 200, body: { version: VERSION_1 } });

		visitSignedIn("/cover-letters");
		cy.get('[data-testid="cover-letters-page"]').should("be.visible");
		cy.get('[data-testid="cover-letters-item"]').should("have.length", 1);
		cy.get('[data-testid="cover-letters-feed"]').within(() => {
			cy.contains("Senior Backend Engineer").should("be.visible");
			cy.contains("Needs your review").should("be.visible");
			cy.contains("PNet").should("be.visible");
		});
		cy.a11y("cover letters list");

		cy.contains('[data-testid="cover-letters-item"]', "Senior Backend Engineer").click();
		cy.location("pathname").should("eq", `/cover-letters/${CANDIDACY}`);
		cy.get('[data-testid="cover-letter-review"]').should("be.visible");
	});

	it("renders a calm empty state when there are no letters to review", () => {
		stubList([], [], []);
		visitSignedIn("/cover-letters");
		cy.get('[data-testid="cover-letters-empty"]').should("contain.text", "No cover letters");
		cy.get('[data-testid="cover-letters-item"]').should("not.exist");
		cy.a11y("cover letters empty");
	});
});

describe("Cover letter — review, approve & revise (M3)", () => {
	beforeEach(function () {
		if (Cypress.env("live")) this.skip();
		cy.intercept("GET", "**/boards", { statusCode: 200, body: { boards: BOARDS } });
		stubList([IN_REVIEW], [], []);
	});

	it("presents the letter with version history + spoken-note playback", () => {
		cy.intercept("GET", "**/candidacies/*/cover-letters", {
			statusCode: 200,
			body: { versions: [VERSION_1], openProposalId: P1, proposedVersionId: V1 },
		});
		cy.intercept("GET", `**/cover-letters/${V1}`, { statusCode: 200, body: { version: VERSION_1 } });

		visitSignedIn(`/cover-letters/${CANDIDACY}`);
		cy.get('[data-testid="cover-letter-review"]').should("be.visible");
		cy.get('[data-testid="cover-letter-content"]').should("contain.text", "excited to apply");
		cy.get('[data-testid="cover-letter-spoken-note"]').should("be.visible");
		cy.get('[data-testid="cover-letter-history"]').should("contain.text", "v1");
		cy.get('[data-testid="cover-letter-actions"]').should("be.visible");
		cy.a11y("cover letter review");
	});

	it("approves the open proposal and returns to the cockpit", () => {
		cy.intercept("GET", "**/candidacies/*/cover-letters", {
			statusCode: 200,
			body: { versions: [VERSION_1], openProposalId: P1, proposedVersionId: V1 },
		});
		cy.intercept("GET", `**/cover-letters/${V1}`, { statusCode: 200, body: { version: VERSION_1 } });
		cy.intercept("POST", "**/cover-letters/proposals/*/decide/self", {
			statusCode: 200,
			body: { proposalId: P1, proposalStatus: "completed", candidacyStatus: "approved" },
		}).as("decide");

		visitSignedIn(`/cover-letters/${CANDIDACY}`);
		cy.get('[data-testid="cover-letter-approve"]').click();
		cy.wait("@decide").its("request.body").should("deep.include", { action: "approve" });
		cy.location("pathname").should("eq", "/cover-letters");
		cy.get('[data-testid="cover-letters-page"]').should("be.visible");
	});

	it("sends feedback, shows Archer reworking, then re-presents the reworked draft", () => {
		// The history read returns the open proposal P1/V1 first; after the feedback
		// (reject) the poll/refetch returns the reworked draft's fresh proposal P2/V2.
		let historyCalls = 0;
		cy.intercept("GET", "**/candidacies/*/cover-letters", (req) => {
			historyCalls += 1;
			req.reply(
				historyCalls === 1
					? { versions: [VERSION_1], openProposalId: P1, proposedVersionId: V1 }
					: {
							versions: [VERSION_2, VERSION_1],
							openProposalId: P2,
							proposedVersionId: V2,
						},
			);
		});
		cy.intercept("GET", `**/cover-letters/${V1}`, { statusCode: 200, body: { version: VERSION_1 } });
		cy.intercept("GET", `**/cover-letters/${V2}`, { statusCode: 200, body: { version: VERSION_2 } });
		cy.intercept("POST", "**/cover-letters/proposals/*/decide/self", {
			statusCode: 200,
			body: { proposalId: P1, proposalStatus: "rejected", candidacyStatus: "drafting" },
		}).as("decide");

		visitSignedIn(`/cover-letters/${CANDIDACY}`);
		cy.get('[data-testid="cover-letter-content"]').should("contain.text", "excited to apply");

		cy.get('[data-testid="cover-letter-feedback-input"]').type("Make it warmer and mention fintech.");
		cy.get('[data-testid="cover-letter-send"]').click();
		cy.wait("@decide").its("request.body").should("deep.include", { action: "reject" });

		// The reworked draft lands (fresh proposal) and re-presents with a version bump.
		cy.get('[data-testid="cover-letter-landed"]', { timeout: 8000 }).should("contain.text", "v2");
		cy.get('[data-testid="cover-letter-content"]').should("contain.text", "deep fintech experience");
	});
});
