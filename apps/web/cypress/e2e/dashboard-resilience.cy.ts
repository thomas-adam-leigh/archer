/// <reference types="cypress" />

// ARC-163 (M6 · Hardening) — dashboard error resilience. The dashboard's
// happy + empty paths are covered per-route (jobs/companies/cover-letters/
// applications/profile each render a calm empty state with cy.a11y); this proves
// the remaining axis: a *failed* read is never a dead-end. A 5xx on the jobs feed
// surfaces the shared retryable InlineErrorState (a "Try again" action, not a
// stuck "Loading…" or a blank), it's accessible, and retrying — once the backend
// recovers — re-reads and renders the feed.
//
// The backend is mocked at the network layer (a seeded session + a controllable
// `/jobs?status=` intercept), so the run is deterministic and creates no data.
// The client retries a 5xx twice (root-provider: failureCount < 2 → three
// attempts) before surfacing the error, so the initial three reads fail and the
// post-retry read succeeds. Under CYPRESS_LIVE=1 these failure injections don't
// apply, so the spec self-skips.

import { SESSION_KEY, seededSession } from "../support/commands";

/** The seeded boards, so a recovered job's `board_slug` resolves to a name. */
const BOARDS = [
	{
		slug: "pnet",
		name: "PNet",
		collect_status: "integrated",
		apply_status: "not_integrated",
	},
];

/** The shortlisted candidacy the feed renders once the read recovers. */
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

/** Visit a path with a restored session so the guard treats us as signed-in. */
function visitSignedIn(path: string) {
	cy.visit(path, {
		onBeforeLoad(win) {
			win.localStorage.setItem(SESSION_KEY, JSON.stringify(seededSession()));
		},
	});
}

describe("Dashboard resilience — a failed read is never a dead-end (M6)", () => {
	beforeEach(function () {
		if (Cypress.env("live")) this.skip();
	});

	it("a failed jobs read shows a retryable error, then recovers on retry", () => {
		// Fail the initial read + both client retries (three attempts), then serve
		// the real feed on the post-retry read. The alt-outreach read (same
		// Promise.all) stays healthy throughout, so only the 5xx drives the error.
		let shortlistedCalls = 0;
		cy.intercept({ method: "GET", url: /\/jobs\?.*status=shortlisted/ }, (req) => {
			shortlistedCalls += 1;
			if (shortlistedCalls <= 3) {
				req.reply({ statusCode: 500, body: { error: "boom" } });
			} else {
				req.reply({
					statusCode: 200,
					body: { user: "test-user-id", jobs: [SHORTLISTED] },
				});
			}
		}).as("jobsShortlisted");
		cy.intercept(
			{ method: "GET", url: /\/jobs\?.*status=alternative_outreach/ },
			{ statusCode: 200, body: { user: "test-user-id", jobs: [] } },
		).as("jobsAltOutreach");
		cy.intercept("GET", "**/boards", {
			statusCode: 200,
			body: { boards: BOARDS },
		}).as("boards");

		visitSignedIn("/jobs");

		// No dead-end: the failed read surfaces the shared retryable error.
		cy.get('[data-testid="jobs-error"]', { timeout: 20000 })
			.should("be.visible")
			.and("contain.text", "Try again");
		// The error treatment itself is accessible (role=alert + a real button).
		cy.a11y("jobs error");

		// Retrying re-reads the feed (now healthy) and the jobs render.
		cy.contains('[data-testid="jobs-error"] button', "Try again").click();
		cy.get('[data-testid="jobs-feed"]', { timeout: 20000 }).should("be.visible");
		cy.contains("Senior Backend Engineer").should("be.visible");
		cy.get('[data-testid="jobs-error"]').should("not.exist");
	});
});
