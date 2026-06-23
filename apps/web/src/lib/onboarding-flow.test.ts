import { describe, expect, test } from "vitest";
import type { OnboardingStep } from "#/lib/onboarding.ts";
import {
	type OnboardingRoute,
	progressSegmentForRoute,
	resolveOnboardingTarget,
	resumeRouteForStep,
	routePath,
	routesAllowedForStep,
} from "#/lib/onboarding-flow.ts";

describe("routePath", () => {
	test("nests a stage under /onboarding", () => {
		expect(routePath("intro")).toBe("/onboarding/intro");
		expect(routePath("review")).toBe("/onboarding/review");
	});
});

describe("resumeRouteForStep", () => {
	const cases: Array<[OnboardingStep, OnboardingRoute]> = [
		["intro", "intro"],
		["processing", "resume"],
		["review", "review"],
		["titles", "criteria"],
		["submitting", "criteria"],
		["done", "home"],
	];
	test.each(cases)("step %s resumes on the %s route", (step, route) => {
		expect(resumeRouteForStep(step)).toBe(route);
	});
});

describe("routesAllowedForStep", () => {
	test("the intro step admits the path choice and either entered path", () => {
		expect(routesAllowedForStep("intro")).toEqual([
			"intro",
			"resume",
			"conversation",
		]);
	});

	test("a later step pins to its single screen", () => {
		expect(routesAllowedForStep("review")).toEqual(["review"]);
		expect(routesAllowedForStep("titles")).toEqual(["criteria"]);
	});
});

describe("resolveOnboardingTarget", () => {
	test("the resolver (null current) always redirects to the resume route", () => {
		expect(resolveOnboardingTarget(null, "intro")).toBe("intro");
		expect(resolveOnboardingTarget(null, "review")).toBe("review");
		expect(resolveOnboardingTarget(null, "done")).toBe("home");
	});

	test("stays put when the current route is valid for the step", () => {
		expect(resolveOnboardingTarget("intro", "intro")).toBeNull();
		expect(resolveOnboardingTarget("review", "review")).toBeNull();
	});

	test("lets the intro step keep a chosen path without bouncing", () => {
		// Picking "Upload" / "Start from scratch" navigates ahead while the backend
		// is still on the intro step — the guard must not redirect back to intro.
		expect(resolveOnboardingTarget("resume", "intro")).toBeNull();
		expect(resolveOnboardingTarget("conversation", "intro")).toBeNull();
	});

	test("redirects a deep-link that skipped ahead of the real step", () => {
		// On the intro step but deep-linking to review → back to the intro.
		expect(resolveOnboardingTarget("review", "intro")).toBe("intro");
		// Past review but deep-linking back to the résumé screen → forward to review.
		expect(resolveOnboardingTarget("resume", "review")).toBe("review");
	});
});

describe("progressSegmentForRoute", () => {
	test("maps each stage to its 1-based segment", () => {
		expect(progressSegmentForRoute("intro")).toBe(1);
		expect(progressSegmentForRoute("resume")).toBe(2);
		expect(progressSegmentForRoute("conversation")).toBe(2);
		expect(progressSegmentForRoute("review")).toBe(3);
		expect(progressSegmentForRoute("criteria")).toBe(4);
	});

	test("hides the indicator on the post-onboarding home", () => {
		expect(progressSegmentForRoute("home")).toBeUndefined();
	});
});
