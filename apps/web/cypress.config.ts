import { defineConfig } from "cypress";

// Opt-in: `CYPRESS_LIVE=1` runs the specs against a real test backend instead
// of the `cy.intercept` mocks (nightly / manual). Exposed to specs as
// `Cypress.env("live")` so a spec can branch its setup.
const live = process.env.CYPRESS_LIVE === "1";

export default defineConfig({
	e2e: {
		// The built app is served by `pnpm serve` (node .output/server/index.mjs)
		// on :3000; start-server-and-test waits on this before the run.
		baseUrl: process.env.CYPRESS_BASE_URL ?? "http://localhost:3000",
		specPattern: "cypress/e2e/**/*.cy.ts",
		supportFile: "cypress/support/e2e.ts",
		fixturesFolder: "cypress/fixtures",
		// Retry in CI to absorb transient flake; never auto-retry in `open` mode.
		retries: { runMode: 2, openMode: 0 },
		video: true,
		screenshotOnRunFailure: true,
		setupNodeEvents(_on, config) {
			config.env.live = live;
			return config;
		},
	},
});
