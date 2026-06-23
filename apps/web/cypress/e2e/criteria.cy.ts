/// <reference types="cypress" />

// ARC-112 (M7 · Negative criteria / hunt setup) — the hunt-setup E2E. It reaches
// the criteria stage the way a returning user resumes onto it, exercises the
// rule-out capture ARC-110 added (empty prompt → add → remove), then drives the
// single "Send to Archer →" submit ARC-111 wired and asserts the now-`done` user
// is forwarded to home.
//
// The backend is mocked at the network layer, mirroring review.cy.ts: a seeded
// session (the way ARC-96 restores a returning user) plus stubs for every seam the
// stage touches — the progress poll, the suggested target titles (read on mount),
// the negative-criteria list/add/remove, and the submit's titles-approve +
// onboarding-complete writes. A mutable `ctrl` models the two pieces of backend
// state the screen observes: the saved rule-outs (so add/remove re-render) and the
// step (flipped to `done` by /onboarding/complete so the resume guard lands the
// candidate on home). Under CYPRESS_LIVE=1 (where the custom commands are no-ops)
// the spec self-skips, since a real backend won't reproduce the transitions
// deterministically.

import { SESSION_KEY, seededSession } from "../support/commands";

/** Archer's ranked target titles, read on mount — needed (≥1) for submit readiness. */
const SUGGESTED_TITLES: readonly string[] = [
	"Senior Frontend Engineer",
	"Staff Frontend Engineer",
	"Frontend Platform Engineer",
];

/** A saved rule-out (mirrors the `{ id, text }` row `POST /criteria` returns). */
interface Criterion {
	id: string;
	text: string;
}

/**
 * The mutable backend state the criteria stubs read. `step` drives the progress
 * poll: `titles` keeps the candidate on the criteria route (onboarding-flow.ts),
 * until `/onboarding/complete` flips it to `done`, which the resume guard maps to
 * home. `criteria` is the saved rule-out list, mutated by the add/remove stubs so
 * the list and empty-state re-render; `seq` mints stable ids without Math.random.
 */
interface CriteriaCtrl {
	step: "titles" | "done";
	criteria: Criterion[];
	seq: number;
}

function newCtrl(): CriteriaCtrl {
	return { step: "titles", criteria: [], seq: 0 };
}

/**
 * Stub the hunt-setup backend: the progress poll (criteria → home on submit), the
 * suggested titles read, the rule-out list/add/remove, and the submit's
 * titles-approve + onboarding-complete writes. The criteria reads serve `ctrl`'s
 * live list so each add/remove is observable on the next refetch.
 */
function stubCriteriaBackend(ctrl: CriteriaCtrl) {
	// Progress: `titles` reuses the draft-approved criteria fixture stage with the
	// real backend step (routes to the criteria stage); once complete flips `ctrl`
	// to `done`, the poll reports the completed fixture and the guard forwards home.
	cy.fixture("onboarding/progress.json").then(
		(stages: Record<string, Record<string, unknown>>) => {
			cy.intercept("GET", "**/onboarding/progress*", (req) => {
				const body =
					ctrl.step === "done"
						? { ...stages.completed, step: "done" }
						: { ...stages.criteria, step: "titles" };
				req.reply({ statusCode: 200, body });
			}).as("progress");
		},
	);

	// Archer's suggested target titles, read on mount (preferences.ts → suggestTitles).
	cy.intercept("POST", "**/onboarding/titles/suggest", {
		statusCode: 200,
		body: { user: "test-user-id", suggestions: SUGGESTED_TITLES },
	}).as("suggestTitles");

	// The saved rule-out list (preferences.ts → listNegativeCriteria), served live
	// from `ctrl` so an add/remove is reflected on the post-mutation refetch. Matched
	// on the `?user=` query so the document request for `/onboarding/criteria` (the
	// page navigation, no query) isn't swallowed as JSON.
	cy.intercept({ method: "GET", url: /\/criteria\?/ }, (req) => {
		req.reply({
			statusCode: 200,
			body: { user: "test-user-id", criteria: ctrl.criteria },
		});
	}).as("listCriteria");

	// Capture one rule-out (preferences.ts → addNegativeCriterion): append to `ctrl`
	// and echo the new row back.
	cy.intercept("POST", "**/criteria", (req) => {
		ctrl.seq += 1;
		const criterion: Criterion = {
			id: `criterion-${ctrl.seq}`,
			text: (req.body as { text: string }).text,
		};
		ctrl.criteria.push(criterion);
		req.reply({ statusCode: 200, body: { user: "test-user-id", criterion } });
	}).as("addCriterion");

	// Remove a rule-out by id (preferences.ts → removeNegativeCriterion).
	cy.intercept("DELETE", "**/criteria/*", (req) => {
		const id = req.url.split("/").pop()?.split("?")[0];
		ctrl.criteria = ctrl.criteria.filter((c) => c.id !== id);
		req.reply({ statusCode: 200, body: {} });
	}).as("removeCriterion");

	// Submit (hooks.ts → useSubmitHuntSetup): persist the work preferences (ARC-133,
	// only when any were entered) → approve the confirmed titles → complete
	// onboarding — the completion flips `ctrl.step` to `done` so the invalidated
	// progress poll carries the candidate to home.
	cy.intercept("POST", "**/profile/preferences", {
		statusCode: 200,
		body: { user: "test-user-id", profile: {} },
	}).as("submitPreferences");
	cy.intercept("POST", "**/onboarding/titles/approve", {
		statusCode: 200,
		body: {},
	}).as("approveTitles");
	cy.intercept("POST", "**/onboarding/complete", (req) => {
		ctrl.step = "done";
		req.reply({
			statusCode: 200,
			body: { user: "test-user-id", status: "submitted" },
		});
	}).as("complete");
}

/** Visit `path` with a session already persisted so the route guard admits us. */
function visitSignedIn(path: string) {
	cy.visit(path, {
		onBeforeLoad(win) {
			win.localStorage.setItem(SESSION_KEY, JSON.stringify(seededSession()));
		},
	});
}

describe("Hunt setup (M7)", () => {
	beforeEach(function () {
		// The mocked criteria → complete → home transitions are only deterministic
		// with the stubs; skip against a live backend.
		if (Cypress.env("live")) {
			this.skip();
		}
	});

	it("login → criteria → add + remove exclusions → submit advances to home", () => {
		const ctrl = newCtrl();
		stubCriteriaBackend(ctrl);

		// Resume onto the criteria stage; the suggested titles and the empty
		// rule-out prompt render.
		visitSignedIn("/onboarding/criteria");
		cy.get('[data-testid="onboarding-stage-criteria"]').should("be.visible");
		cy.get('[data-testid="target-titles-list"]')
			.should("be.visible")
			.and("contain.text", "Senior Frontend Engineer");
		cy.get('[data-testid="criteria-empty"]').should("be.visible");

		// Submit is gated until a rule-out exists (titles already loaded).
		cy.get('[data-testid="hunt-setup-submit"]').should("be.disabled");

		// Add a rule-out → it appears in the captured list as a removable chip.
		cy.get('[data-testid="criteria-input"]').type("nothing in .NET or C#");
		cy.get('[data-testid="criteria-add"]').click();
		cy.wait("@addCriterion");
		cy.get('[data-testid="criteria-list"]')
			.should("be.visible")
			.and("contain.text", "nothing in .NET or C#");
		cy.get('[data-testid="criteria-empty"]').should("not.exist");

		// Remove it → the list empties back to the prompt (remove works).
		cy.get('[data-testid="criteria-remove"]').click();
		cy.wait("@removeCriterion");
		cy.get('[data-testid="criteria-empty"]').should("be.visible");
		cy.get('[data-testid="hunt-setup-submit"]').should("be.disabled");

		// Re-add a rule-out so the submit is ready, then send to Archer.
		cy.get('[data-testid="criteria-input"]').type("no on-call rotations");
		cy.get('[data-testid="criteria-add"]').click();
		cy.wait("@addCriterion");
		cy.get('[data-testid="criteria-list"]').should(
			"contain.text",
			"no on-call rotations",
		);

		// Capture the optional work preferences (ARC-133): pick a work mode, opt into
		// remote, and answer salary + notice. These land on the typed `profiles`
		// columns via POST /profile/preferences when the candidate submits.
		cy.get('[data-testid="work-preferences"]').should("be.visible");
		cy.get('[data-testid="work-pref-hybrid"]').click();
		cy.get('[data-testid="willing-remote-toggle"]').click();
		cy.get('[data-testid="current-salary-input"]').type("R900k");
		cy.get('[data-testid="preferred-salary-input"]').type("R1.1m");
		cy.get('[data-testid="notice-period-input"]').type("30 days");

		// "Send to Archer →": persist preferences → approve titles → complete
		// onboarding → the step flips to `done` and the resume guard forwards home.
		cy.get('[data-testid="hunt-setup-submit"]').should("be.enabled").click();
		cy.wait("@submitPreferences").its("request.body").should("deep.equal", {
			userId: "test-user-id",
			workPref: "hybrid",
			willingRemote: true,
			currentSalary: "R900k",
			preferredSalary: "R1.1m",
			noticePeriod: "30 days",
		});
		cy.wait("@approveTitles");
		cy.wait("@complete");
		cy.location("pathname").should("eq", "/onboarding/home");
		cy.get('[data-testid="onboarding-stage-home"]').should("be.visible");
	});
});
