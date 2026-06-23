import { describe, expect, test } from "vitest";
import type { OnboardingProgress } from "#/lib/onboarding.ts";
import {
	INGEST_PHASES,
	isDraftReady,
	processingView,
} from "#/lib/resume-processing.ts";

function progress(over: Partial<OnboardingProgress> = {}): OnboardingProgress {
	return {
		hasProfileData: false,
		draftGenerated: false,
		draftApproved: false,
		titlesGenerated: false,
		titlesApproved: false,
		negativeCriteriaCaptured: false,
		completed: false,
		step: "processing",
		openProposalId: null,
		proposedVersionId: null,
		...over,
	};
}

describe("processingView", () => {
	test("starts on the first heading with nothing logged at 0%", () => {
		const v = processingView(0);
		expect(v.title).toBe(INGEST_PHASES[0].title);
		expect(v.log).toEqual([]);
		expect(v.pct).toBe(0);
	});

	test("activates a mid phase, logging the completed phases behind it", () => {
		const v = processingView(2);
		expect(v.title).toBe(INGEST_PHASES[2].title);
		expect(v.log).toEqual([INGEST_PHASES[0].log, INGEST_PHASES[1].log]);
		expect(v.pct).toBe(INGEST_PHASES[1].pct);
	});

	test("holds on the final heading at 100% with the full log when fully revealed", () => {
		const v = processingView(INGEST_PHASES.length);
		expect(v.title).toBe(INGEST_PHASES[INGEST_PHASES.length - 1].title);
		expect(v.log).toHaveLength(INGEST_PHASES.length);
		expect(v.pct).toBe(100);
	});

	test("clamps out-of-range input", () => {
		expect(processingView(-3).log).toEqual([]);
		expect(processingView(999).log).toHaveLength(INGEST_PHASES.length);
	});
});

describe("isDraftReady", () => {
	test("false while still processing with no proposal", () => {
		expect(isDraftReady(progress())).toBe(false);
	});

	test("true once the step reaches review", () => {
		expect(
			isDraftReady(progress({ step: "review", openProposalId: "prop-1" })),
		).toBe(true);
	});

	test("true once a draft is generated with an open proposal", () => {
		expect(
			isDraftReady(
				progress({ draftGenerated: true, openProposalId: "prop-1" }),
			),
		).toBe(true);
	});

	test("false when a draft is generated but no proposal is open", () => {
		expect(isDraftReady(progress({ draftGenerated: true }))).toBe(false);
	});
});
