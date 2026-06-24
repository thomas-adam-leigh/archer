/// <reference types="cypress" />

// ARC-149 (M2 · Jobs route + detail) — the curated jobs feed shows only the
// candidacies Archer has decided are worth a look (`shortlisted` +
// `alternative_outreach`), each tagged with its board + match score and linking to
// a detail view (posting, why-matched, company). The feed is the union of two
// status-filtered reads (`GET /jobs?status=`), so this spec stubs both. It drives
// the populated path, the launch-default empty path, and the detail view through
// the browser with the backend mocked at the network layer, so empty/loading
// states render calm (never blank/broken). Under CYPRESS_LIVE=1 the mocks are
// skipped and a real backend won't reproduce these states, so the spec self-skips.

import { SESSION_KEY, seededSession } from "../support/commands";

/** The two seeded boards, so a job's `board_slug` resolves to a display name. */
const BOARDS = [
	{ slug: "pnet", name: "PNet", collect_status: "integrated", apply_status: "not_integrated" },
	{
		slug: "careerjunction",
		name: "CareerJunction",
		collect_status: "integrated",
		apply_status: "not_integrated",
	},
];

/** A shortlisted candidacy (the feed's primary state). */
const SHORTLISTED = {
	id: "33333333-3333-3333-3333-333333333333",
	status: "shortlisted",
	triage_decision: "shortlisted",
	match_score: 87,
	posting_title: "Senior Backend Engineer",
	board_slug: "pnet",
	company_name: "Acme",
	created_at: "2026-06-24T09:00:00Z",
};

/** An alternative-outreach candidacy (the feed's second curated state). */
const ALT_OUTREACH = {
	id: "44444444-4444-4444-4444-444444444444",
	status: "alternative_outreach",
	triage_decision: "alternative_outreach",
	match_score: 71,
	posting_title: "Platform Engineer",
	board_slug: "careerjunction",
	company_name: "Globex",
	created_at: "2026-06-24T08:00:00Z",
};

/** Full detail for the shortlisted candidacy (the job-detail read). */
const DETAIL = {
	id: SHORTLISTED.id,
	user_id: "test-user-id",
	status: "shortlisted",
	triage_decision: "shortlisted",
	triage_reason: "Strong match on backend + remote, and salary is in range.",
	match_score: 87,
	created_at: "2026-06-24T09:00:00Z",
	status_changed_at: "2026-06-24T09:30:00Z",
	posting: {
		title: "Senior Backend Engineer",
		board_slug: "pnet",
		url: "https://www.pnet.co.za/jobs/1",
		location: "Cape Town",
		work_mode: "remote",
		salary_raw: "R900k–R1.1m",
		posted_on: "2026-06-23",
		description: "Build and scale the platform's core services.",
	},
	company: {
		id: "55555555-5555-5555-5555-555555555555",
		name: "Acme",
		status: "enriched",
		description: "A late-stage fintech building payments rails.",
		website_url: "https://acme.example",
		recruitment_email: "jobs@acme.example",
	},
	external_form: { status: "pending", url: "https://www.pnet.co.za/apply/1" },
};

/** Stub the two curated status reads with the given jobs for each. */
function stubFeed(shortlisted: object[], altOutreach: object[]) {
	cy.intercept({ method: "GET", url: /\/jobs\?.*status=shortlisted/ }, {
		statusCode: 200,
		body: { user: "test-user-id", jobs: shortlisted },
	}).as("jobsShortlisted");
	cy.intercept({ method: "GET", url: /\/jobs\?.*status=alternative_outreach/ }, {
		statusCode: 200,
		body: { user: "test-user-id", jobs: altOutreach },
	}).as("jobsAltOutreach");
	cy.intercept("GET", "**/boards", { statusCode: 200, body: { boards: BOARDS } }).as(
		"boards",
	);
}

/** Visit a path with a restored session so the guard treats us as signed-in. */
function visitSignedIn(path: string) {
	cy.visit(path, {
		onBeforeLoad(win) {
			win.localStorage.setItem(SESSION_KEY, JSON.stringify(seededSession()));
		},
	});
}

describe("Jobs route — curated feed (M2)", () => {
	beforeEach(function () {
		if (Cypress.env("live")) this.skip();
	});

	it("shows shortlisted + alternative-outreach with board + score, and links to detail", () => {
		stubFeed([SHORTLISTED], [ALT_OUTREACH]);
		cy.intercept("GET", "**/candidacies/*", { statusCode: 200, body: { candidacy: DETAIL } }).as(
			"jobDetail",
		);

		visitSignedIn("/jobs");
		cy.get('[data-testid="jobs-page"]').should("be.visible");

		// Both curated states render, newest first, with their board name + score.
		cy.get('[data-testid="jobs-item"]').should("have.length", 2);
		cy.get('[data-testid="jobs-feed"]').within(() => {
			cy.contains("Senior Backend Engineer").should("be.visible");
			cy.contains("Shortlisted").should("be.visible");
			cy.contains("87% match").should("be.visible");
			cy.contains("PNet").should("be.visible");
			cy.contains("Platform Engineer").should("be.visible");
			cy.contains("Alternative outreach").should("be.visible");
		});

		cy.a11y("jobs feed");

		// The card links through to its detail.
		cy.contains('[data-testid="jobs-item"]', "Senior Backend Engineer").click();
		cy.location("pathname").should("eq", `/jobs/${SHORTLISTED.id}`);
		cy.get('[data-testid="job-detail"]').should("be.visible");
	});

	it("renders a calm empty state when there are no shortlisted jobs (launch default)", () => {
		stubFeed([], []);

		visitSignedIn("/jobs");

		cy.get('[data-testid="jobs-empty"]').should(
			"contain.text",
			"Archer is searching",
		);
		cy.get('[data-testid="jobs-item"]').should("not.exist");
		cy.a11y("jobs empty");
	});
});

describe("Job detail (M2)", () => {
	beforeEach(function () {
		if (Cypress.env("live")) this.skip();
		cy.intercept("GET", "**/boards", { statusCode: 200, body: { boards: BOARDS } });
	});

	it("renders the posting, why-matched, company and external-form state", () => {
		cy.intercept("GET", "**/candidacies/*", { statusCode: 200, body: { candidacy: DETAIL } }).as(
			"jobDetail",
		);

		visitSignedIn(`/jobs/${DETAIL.id}`);

		cy.get('[data-testid="job-detail"]').should("be.visible");
		// The why-matched triage reason.
		cy.get('[data-testid="job-detail-why"]').should(
			"contain.text",
			"Strong match on backend",
		);
		// The posting facts + company summary.
		cy.get('[data-testid="job-detail"]').within(() => {
			cy.contains("Cape Town").should("be.visible");
			cy.contains("Remote").should("be.visible");
			cy.contains("R900k–R1.1m").should("be.visible");
			cy.contains("A late-stage fintech").should("be.visible");
			cy.contains("jobs@acme.example").should("be.visible");
		});
		cy.get('[data-testid="job-detail-external-form"]').should("be.visible");
		cy.get('[data-testid="job-detail-back"]').should("have.attr", "href", "/jobs");

		cy.a11y("job detail");
	});
});
