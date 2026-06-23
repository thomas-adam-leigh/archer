/**
 * The onboarding flow map: how the backend `OnboardingStep` (from
 * `/onboarding/progress`) projects onto the web app's stage routes, and the
 * rules the router uses to resume a returning user and guard against skipping.
 *
 * Kept pure (no router, no React) so the resume/guard decisions are unit-tested
 * in isolation; the thin {@link useOnboardingResume} hook just wires these into
 * navigation. The backend step machine is coarser than the screens: the résumé
 * dropzone, the scratch conversation, and the intro path choice are all the
 * single backend `intro` step (no profile data yet), so the intro step admits
 * several routes rather than mapping one-to-one.
 */

import type { OnboardingStep } from "#/lib/onboarding.ts";

/** A stage in the web onboarding flow — one route under `/onboarding`. */
export type OnboardingRoute =
	| "intro"
	| "resume"
	| "conversation"
	| "review"
	| "criteria"
	| "home";

/** The number of segments in the onboarding progress indicator. */
export const ONBOARDING_TOTAL_STEPS = 4;

/** Each stage's path, as literals so they match the router's typed `to`. */
const ROUTE_PATHS = {
	intro: "/onboarding/intro",
	resume: "/onboarding/resume",
	conversation: "/onboarding/conversation",
	review: "/onboarding/review",
	criteria: "/onboarding/criteria",
	home: "/onboarding/home",
} as const;

/** The path a stage route lives at (e.g. `intro` → `/onboarding/intro`). */
export function routePath(
	route: OnboardingRoute,
): (typeof ROUTE_PATHS)[OnboardingRoute] {
	return ROUTE_PATHS[route];
}

/**
 * The route a user at `step` resumes onto — where `/onboarding` sends them and
 * where a guard redirects a deep-link that skipped ahead. The intro step lands
 * on the path-choice screen; a chosen path (résumé/conversation) is reached from
 * there while still the `intro` step (see {@link routesAllowedForStep}).
 */
export function resumeRouteForStep(step: OnboardingStep): OnboardingRoute {
	switch (step) {
		case "intro":
			return "intro";
		case "processing":
			return "resume";
		case "review":
			return "review";
		case "titles":
		case "submitting":
			return "criteria";
		case "done":
			return "home";
	}
}

/**
 * The routes a user at `step` may legitimately be on, so the guard doesn't bounce
 * a valid in-step path choice. At `intro` the candidate hasn't produced profile
 * data yet, so the path-choice screen and either entered path (the résumé
 * dropzone or the scratch conversation) are all in-step; every later step pins to
 * a single screen.
 */
export function routesAllowedForStep(step: OnboardingStep): OnboardingRoute[] {
	if (step === "intro") return ["intro", "resume", "conversation"];
	return [resumeRouteForStep(step)];
}

/**
 * Resolve where the router should send a user, or `null` to stay put.
 *
 * `current` is the route the user is on (`null` for the `/onboarding` resolver,
 * which always redirects). Returns the resume route when `current` is `null` or
 * isn't allowed for `step` (a skipped-ahead deep-link), else `null`.
 */
export function resolveOnboardingTarget(
	current: OnboardingRoute | null,
	step: OnboardingStep,
): OnboardingRoute | null {
	if (current === null) return resumeRouteForStep(step);
	if (routesAllowedForStep(step).includes(current)) return null;
	return resumeRouteForStep(step);
}

/**
 * The 1-based progress segment a stage route lights, or `undefined` to hide the
 * indicator (the post-onboarding home). The résumé and conversation paths share
 * segment 2 — they're two ways through the same "build your profile" stage.
 */
export function progressSegmentForRoute(
	route: OnboardingRoute,
): number | undefined {
	switch (route) {
		case "intro":
			return 1;
		case "resume":
		case "conversation":
			return 2;
		case "review":
			return 3;
		case "criteria":
			return 4;
		case "home":
			return undefined;
	}
}
