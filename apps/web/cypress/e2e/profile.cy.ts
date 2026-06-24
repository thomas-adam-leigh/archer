/// <reference types="cypress" />

import { SESSION_KEY, seededSession } from "../support/commands";

const API = "https://api.archer.test";

const PROFILE = {
	about: "Senior engineer who ships.",
	location: "Cape Town, ZA",
	linkedin_url: "https://linkedin.com/in/jord",
	portfolio_url: "https://jord.dev",
	resume_url: null,
	years_experience: 8,
	willing_remote: true,
	work_pref: "hybrid",
	current_salary: "R900k / year",
	preferred_salary: "R1.1m / year",
	notice_period: "30 days",
	attributes: {
		full_name: "Jordan Vale",
		summary: "Senior engineer who ships.",
		location: "Cape Town, ZA",
		links: {
			linkedin: "https://linkedin.com/in/jord",
			website: "https://jord.dev",
		},
	},
	updated_at: "2026-06-24T09:30:00Z",
};

const VERSIONS = [
	{
		id: "11111111-1111-1111-1111-111111111111",
		version_no: 1,
		status: "superseded",
		label: "onboarding draft",
		created_at: "2026-06-20T09:00:00Z",
	},
	{
		id: "22222222-2222-2222-2222-222222222222",
		version_no: 2,
		status: "approved",
		label: "revised",
		created_at: "2026-06-24T09:00:00Z",
	},
];

const LIVE_ID = VERSIONS[1].id;

const SPINE = {
	workExperiences: [
		{
			title: "Staff Engineer",
			organization: "Acme",
			startDate: "2022-01",
			isCurrent: true,
			description: "Led the platform team.",
		},
	],
	education: [{ institution: "UCT", degree: "BSc Computer Science" }],
	skills: [{ name: "TypeScript" }, { name: "Postgres" }],
};

/** Stub the three reads the overview makes (profile, versions, live version). */
function stubProfile(opts?: {
	profile?: object | null;
	versions?: object[];
	liveVersionId?: string | null;
	spine?: object;
}) {
	const versions = opts?.versions ?? VERSIONS;
	const liveVersionId =
		opts && "liveVersionId" in opts ? opts.liveVersionId : LIVE_ID;
	cy.intercept({ method: "GET", url: /\/profile\?.*user=/ }, {
		statusCode: 200,
		body: {
			user: "test-user-id",
			profile: opts && "profile" in opts ? opts.profile : PROFILE,
		},
	}).as("profile");
	cy.intercept({ method: "GET", url: /\/profile\/versions\?.*user=/ }, {
		statusCode: 200,
		body: { user: "test-user-id", versions, liveVersionId },
	}).as("versions");
	cy.intercept(
		{ method: "GET", url: /\/profile\/versions\/[^?]+\?.*user=/ },
		{
			statusCode: 200,
			body: {
				user: "test-user-id",
				version: { id: liveVersionId, status: "approved", attributes: {} },
				spine: opts?.spine ?? SPINE,
			},
		},
	).as("liveVersion");
}

function visitSignedIn(path: string) {
	cy.visit(path, {
		onBeforeLoad(win) {
			win.localStorage.setItem(SESSION_KEY, JSON.stringify(seededSession()));
		},
	});
}

/**
 * Run the a11y sweep only once the page's fade-up has settled. axe's
 * color-contrast rule samples the *composited* colour, so checking mid-animation
 * (opacity < 1) reads a blended background and flags a false positive; gating on
 * the settled opacity is a real settled-state assertion, not an arbitrary wait.
 */
function a11yWhenSettled(label: string) {
	cy.get('[data-testid="profile-page"]').should("have.css", "opacity", "1");
	cy.a11y(label);
}

describe("Profile route — live profile + history", () => {
	beforeEach(function () {
		if (Cypress.env("live")) this.skip();
	});

	it("renders identity, the structured spine, and the version history", () => {
		stubProfile();
		visitSignedIn("/profile");

		cy.get('[data-testid="profile-page"]').should("be.visible");
		cy.get('[data-testid="profile-name"]').should("contain.text", "Jordan Vale");

		cy.get('[data-testid="profile-structured"]').within(() => {
			cy.contains("Staff Engineer").should("be.visible");
			cy.contains("UCT").should("be.visible");
			cy.contains("TypeScript").should("be.visible");
		});

		// Version history: the live version is badged Live, the earlier one Previous.
		cy.get('[data-testid="profile-versions"]').should("be.visible");
		cy.get('[data-testid="profile-version"]').should("have.length", 2);
		cy.get('[data-testid="profile-versions"]').within(() => {
			cy.contains("Live").should("be.visible");
			cy.contains("Previous").should("be.visible");
		});

		a11yWhenSettled("profile");
	});

	it("edits work preferences and persists them (direct write)", () => {
		stubProfile();
		cy.intercept({ method: "POST", url: `${API}/profile/preferences` }, {
			statusCode: 200,
			body: { user: "test-user-id", profile: PROFILE },
		}).as("savePrefs");

		visitSignedIn("/profile");
		cy.get('[data-testid="profile-preferences"]').should("be.visible");

		// The form is seeded from the live profile, then edited.
		cy.get('[data-testid="notice-period-input"]')
			.clear()
			.type("60 days");
		cy.get('[data-testid="work-pref-remote"]').click();
		cy.get('[data-testid="profile-preferences-save"]').click();

		cy.wait("@savePrefs").its("request.body").should((body) => {
			expect(body).to.include({ userId: "test-user-id", noticePeriod: "60 days" });
			expect(body.workPref).to.eq("remote");
		});
		cy.get('[data-testid="profile-preferences-saved"]').should("be.visible");
		a11yWhenSettled("profile preferences saved");
	});

	it("surfaces a proposed update as a calm awaiting-review note", () => {
		stubProfile({
			versions: [
				...VERSIONS,
				{
					id: "33333333-3333-3333-3333-333333333333",
					version_no: 3,
					status: "proposed",
					label: "Archer's update",
					created_at: "2026-06-24T12:00:00Z",
				},
			],
		});
		visitSignedIn("/profile");

		cy.get('[data-testid="profile-proposed"]').should(
			"contain.text",
			"proposed an update",
		);
		cy.get('[data-testid="profile-versions"]').within(() => {
			cy.contains("Awaiting review").should("be.visible");
		});
		a11yWhenSettled("profile proposed");
	});
});
