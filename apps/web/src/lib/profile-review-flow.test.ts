import { describe, expect, test } from "vitest";
import type { OnboardingProgress } from "#/lib/onboarding.ts";
import { isRevisionReady } from "#/lib/profile-review-flow.ts";

function progress(over: Partial<OnboardingProgress> = {}): OnboardingProgress {
	return {
		hasProfileData: true,
		draftGenerated: true,
		draftApproved: false,
		titlesGenerated: false,
		titlesApproved: false,
		negativeCriteriaCaptured: false,
		completed: false,
		step: "review",
		openProposalId: "prop-1",
		proposedVersionId: "ver-1",
		...over,
	};
}

describe("isRevisionReady", () => {
	test("is ready once a different proposed version lands", () => {
		expect(
			isRevisionReady(progress({ proposedVersionId: "ver-2" }), "ver-1"),
		).toBe(true);
	});

	test("keeps waiting while the same version is still proposed", () => {
		expect(
			isRevisionReady(progress({ proposedVersionId: "ver-1" }), "ver-1"),
		).toBe(false);
	});

	test("keeps waiting while the proposed version is briefly cleared", () => {
		expect(
			isRevisionReady(progress({ proposedVersionId: null }), "ver-1"),
		).toBe(false);
	});

	test("treats any non-null version as ready when nothing was on screen", () => {
		expect(
			isRevisionReady(progress({ proposedVersionId: "ver-2" }), null),
		).toBe(true);
	});
});
