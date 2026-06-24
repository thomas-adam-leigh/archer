/// <reference types="cypress" />

// ARC-166 (M7 · Applications view) — the apply-side companion to the jobs feed:
// the candidacies in the apply lifecycle (`approved` awaiting the owner's
// apply-confirm, `applying`, `applied`, `external_pending`, `application_failed`),
// each showing what cover letter was sent and where it stands. Read-only. This spec
// drives the list through the browser with the `/applications` read mocked at the
// network layer. Under CYPRESS_LIVE=1 the mocks are skipped and a real backend won't
// reproduce these states, so the spec self-skips.

import { SESSION_KEY, seededSession } from "../support/commands";

const BOARDS = [
	{ slug: "pnet", name: "PNet", collect_status: "integrated", apply_status: "integrated" },
	{
		slug: "careerjunction",
		name: "CareerJunction",
		collect_status: "integrated",
		apply_status: "integrated",
	},
];

/** Approved, awaiting the owner's explicit apply-confirm (ARC-165) — the one CTA. */
const AWAITING_CONFIRM = {
	id: "11111111-1111-1111-1111-111111111111",
	status: "approved",
	posting_title: "Senior Backend Engineer",
	board_slug: "pnet",
	company_name: "Acme",
	created_at: "2026-06-24T09:00:00Z",
	status_changed_at: "2026-06-24T12:00:00Z",
	apply_confirmed_at: null,
	cover_letter_version_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
	cover_letter_version_no: 2,
	external_form_status: null,
	external_form_url: null,
};

/** Applied successfully on-board. */
const APPLIED = {
	id: "22222222-2222-2222-2222-222222222222",
	status: "applied",
	posting_title: "Platform Engineer",
	board_slug: "pnet",
	company_name: "Globex",
	created_at: "2026-06-23T09:00:00Z",
	status_changed_at: "2026-06-23T11:00:00Z",
	apply_confirmed_at: "2026-06-23T10:30:00Z",
	cover_letter_version_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
	cover_letter_version_no: 1,
	external_form_status: null,
	external_form_url: null,
};

/** Redirected off-board — an external form still to complete. */
const EXTERNAL_PENDING = {
	id: "33333333-3333-3333-3333-333333333333",
	status: "external_pending",
	posting_title: "Full-stack Developer",
	board_slug: "careerjunction",
	company_name: "Initech",
	created_at: "2026-06-22T09:00:00Z",
	status_changed_at: "2026-06-22T10:00:00Z",
	apply_confirmed_at: "2026-06-22T09:45:00Z",
	cover_letter_version_id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
	cover_letter_version_no: 1,
	external_form_status: "pending",
	external_form_url: "https://initech.example/apply",
};

/** Stub the applications read + boards. The URL match requires the `?user=` query
 *  so it catches only the API call, never the `/applications` page document. */
function stubApplications(applications: object[]) {
	cy.intercept({ method: "GET", url: /\/applications\?user=/ }, {
		statusCode: 200,
		body: { user: "test-user-id", applications },
	}).as("applications");
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

describe("Applications — apply lifecycle list (M7)", () => {
	beforeEach(function () {
		if (Cypress.env("live")) this.skip();
	});

	it("lists candidacies in the apply lifecycle with state, board, and what was sent", () => {
		stubApplications([AWAITING_CONFIRM, APPLIED, EXTERNAL_PENDING]);

		visitSignedIn("/applications");
		cy.get('[data-testid="applications-page"]').should("be.visible");
		cy.get('[data-testid="applications-item"]').should("have.length", 3);

		cy.get('[data-testid="applications-feed"]').within(() => {
			// The approved-awaiting-confirm one is the call to action.
			cy.contains("Senior Backend Engineer").should("be.visible");
			cy.contains("Awaiting your confirmation").should("be.visible");
			cy.contains("Cover letter v2 sent").should("be.visible");
			cy.contains("PNet").should("be.visible");

			// The applied + external-pending ones show their distinct states.
			cy.contains("Platform Engineer").should("be.visible");
			cy.contains("Applied").should("be.visible");
			cy.contains("Full-stack Developer").should("be.visible");
			cy.contains("Form to complete").should("be.visible");
		});

		// The external redirect surfaces a link to finish the off-board form.
		cy.contains("a", "Open application form")
			.should("have.attr", "href", "https://initech.example/apply");

		cy.a11y("applications list");
	});

	it("renders a calm empty state when there are no applications yet (launch default)", () => {
		stubApplications([]);

		visitSignedIn("/applications");
		cy.get('[data-testid="applications-empty"]').should("contain.text", "No applications yet");
		cy.get('[data-testid="applications-item"]').should("not.exist");
		cy.a11y("applications empty");
	});

	it("reaches the applications route from the sidebar nav", () => {
		stubApplications([APPLIED]);

		visitSignedIn("/jobs");
		cy.get('[data-testid="applications-page"]').should("not.exist");
		cy.contains("a", "Applications").click();
		cy.location("pathname").should("eq", "/applications");
		cy.get('[data-testid="applications-page"]').should("be.visible");
	});
});
