/// <reference types="cypress" />

// ARC-151 (M4 · Companies route) — the companies directory shows only the
// companies Archer has finished researching (`enriched`), with the ones it's
// researching right now (`researching`) surfaced separately as a live in-action
// indicator. The list is two status-filtered reads (`GET /companies?status=`), so
// this spec stubs both. It drives the populated path (enriched directory +
// researching indicator + link to detail), the launch-default empty path, and the
// detail view (description, links, recruitment email, contacts) through the
// browser with the backend mocked at the network layer, so empty/loading states
// render calm (never blank/broken). Under CYPRESS_LIVE=1 the mocks are skipped and
// a real backend won't reproduce these states, so the spec self-skips.

import { SESSION_KEY, seededSession } from "../support/commands";

// The e2e API base (mirrors `VITE_ARCHER_API_URL` in apps/web/.env.e2e). The
// company-detail API path (`/companies/{id}`) is identical to the detail *page*
// route (`/companies/$companyId`), so the detail stub is scoped to the API host —
// otherwise it would also answer `cy.visit('/companies/<id>')`'s document request
// with JSON and the page would never load.
const API = "https://api.archer.test";

/** An enriched company (the directory's primary state). */
const ENRICHED = {
	id: "66666666-6666-6666-6666-666666666666",
	name: "Acme",
	status: "enriched",
	domain: "acme.example",
	website_url: "https://www.acme.example",
	description: "A late-stage fintech building payments rails.",
	created_at: "2026-06-24T09:00:00Z",
};

/** A company Archer is researching right now (the in-action indicator). */
const RESEARCHING = {
	id: "77777777-7777-7777-7777-777777777777",
	name: "Globex",
	status: "researching",
	domain: null,
	website_url: null,
	description: null,
	created_at: "2026-06-24T10:00:00Z",
};

/** Full detail for the enriched company (the company-detail read). */
const DETAIL = {
	id: ENRICHED.id,
	name: "Acme",
	status: "enriched",
	domain: "acme.example",
	website_url: "https://www.acme.example",
	linkedin_url: "https://linkedin.com/company/acme",
	description: "A late-stage fintech building payments rails.",
	recruitment_email: "jobs@acme.example",
	enrichment: { headcount: "200-500" },
	created_at: "2026-06-24T09:00:00Z",
	updated_at: "2026-06-24T09:30:00Z",
	contacts: [
		{
			id: "88888888-8888-8888-8888-888888888888",
			full_name: "Dana Reeves",
			email: "dana@acme.example",
			linkedin_url: "https://linkedin.com/in/danareeves",
			role_title: "Head of Engineering",
			notes: "Owns the platform org.",
		},
	],
};

/** Stub the two status reads with the given companies for each. */
function stubCompanies(enriched: object[], researching: object[]) {
	cy.intercept({ method: "GET", url: /\/companies\?.*status=enriched/ }, {
		statusCode: 200,
		body: { user: "test-user-id", companies: enriched },
	}).as("companiesEnriched");
	cy.intercept({ method: "GET", url: /\/companies\?.*status=researching/ }, {
		statusCode: 200,
		body: { user: "test-user-id", companies: researching },
	}).as("companiesResearching");
}

/** Visit a path with a restored session so the guard treats us as signed-in. */
function visitSignedIn(path: string) {
	cy.visit(path, {
		onBeforeLoad(win) {
			win.localStorage.setItem(SESSION_KEY, JSON.stringify(seededSession()));
		},
	});
}

describe("Companies route — enriched directory (M4)", () => {
	beforeEach(function () {
		if (Cypress.env("live")) this.skip();
	});

	it("shows enriched companies + the researching indicator, and links to detail", () => {
		stubCompanies([ENRICHED], [RESEARCHING]);
		cy.intercept("GET", `${API}/companies/*`, {
			statusCode: 200,
			body: { company: DETAIL },
		}).as("companyDetail");

		visitSignedIn("/companies");
		cy.get('[data-testid="companies-page"]').should("be.visible");

		// The enriched company renders in the directory, with its website host.
		cy.get('[data-testid="companies-item"]').should("have.length", 1);
		cy.get('[data-testid="companies-directory"]').within(() => {
			cy.contains("Acme").should("be.visible");
			cy.contains("Researched").should("be.visible");
			cy.contains("acme.example").should("be.visible");
		});

		// The researching company is surfaced as a separate in-action indicator,
		// never in the directory.
		cy.get('[data-testid="companies-researching"]').should(
			"contain.text",
			"Globex",
		);

		cy.a11y("companies directory");

		// The card links through to its detail.
		cy.contains('[data-testid="companies-item"]', "Acme").click();
		cy.location("pathname").should("eq", `/companies/${ENRICHED.id}`);
		cy.get('[data-testid="company-detail"]').should("be.visible");
	});

	it("renders a calm empty state when nothing is researched yet (launch default)", () => {
		stubCompanies([], []);

		visitSignedIn("/companies");

		cy.get('[data-testid="companies-empty"]').should(
			"contain.text",
			"No researched companies yet",
		);
		cy.get('[data-testid="companies-item"]').should("not.exist");
		cy.get('[data-testid="companies-researching"]').should("not.exist");
		cy.a11y("companies empty");
	});
});

describe("Company detail (M4)", () => {
	beforeEach(function () {
		if (Cypress.env("live")) this.skip();
	});

	it("renders the description, links, recruitment email and contacts", () => {
		cy.intercept("GET", `${API}/companies/*`, {
			statusCode: 200,
			body: { company: DETAIL },
		}).as("companyDetail");

		visitSignedIn(`/companies/${DETAIL.id}`);

		cy.get('[data-testid="company-detail"]').should("be.visible");
		cy.get('[data-testid="company-detail"]').within(() => {
			cy.contains("Acme").should("be.visible");
			cy.contains("A late-stage fintech").should("be.visible");
			cy.contains("jobs@acme.example").should("be.visible");
		});

		// The contacts the Researcher found.
		cy.get('[data-testid="company-detail-contacts"]').within(() => {
			cy.contains("Dana Reeves").should("be.visible");
			cy.contains("Head of Engineering").should("be.visible");
		});

		cy.get('[data-testid="company-detail-back"]').should(
			"have.attr",
			"href",
			"/companies",
		);

		cy.a11y("company detail");
	});
});
