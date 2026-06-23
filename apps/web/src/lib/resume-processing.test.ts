import type { ThreadView } from "@archer/agui-client";
import { describe, expect, test } from "vitest";
import type { OnboardingProgress } from "#/lib/onboarding.ts";
import {
	INGEST_PHASES,
	isDraftReady,
	processingView,
	readIngestView,
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

/** Build a folded view with a given shared state + lifecycle phase. */
function view(
	state: Record<string, string>,
	phase: ThreadView["phase"] = "running",
): ThreadView {
	return { state, messages: [], interrupts: [], phase };
}

describe("processingView", () => {
	test("starts on the first heading with nothing logged on the reading phase", () => {
		const v = processingView("reading");
		expect(v.title).toBe(INGEST_PHASES[0].title);
		expect(v.log).toEqual([]);
		expect(v.pct).toBe(INGEST_PHASES[0].pct);
	});

	test("activates a mid phase, logging the completed phases behind it", () => {
		const v = processingView("building");
		expect(v.title).toBe(INGEST_PHASES[2].title);
		expect(v.log).toEqual([INGEST_PHASES[0].log, INGEST_PHASES[1].log]);
		expect(v.pct).toBe(INGEST_PHASES[2].pct);
	});

	test("holds on the final heading at 100% with the full log when complete", () => {
		const v = processingView("complete");
		expect(v.title).toBe(INGEST_PHASES[INGEST_PHASES.length - 1].title);
		expect(v.log).toHaveLength(INGEST_PHASES.length);
		expect(v.pct).toBe(100);
	});

	test("falls back to the first phase for an unknown/absent phase", () => {
		expect(processingView(undefined).log).toEqual([]);
		expect(processingView("nonsense").title).toBe(INGEST_PHASES[0].title);
	});
});

describe("readIngestView", () => {
	test("a null view reads as the first phase, still running", () => {
		const s = readIngestView(null);
		expect(s.phase).toBe(INGEST_PHASES[0].key);
		expect(s.failed).toBe(false);
		expect(s.complete).toBe(false);
	});

	test("surfaces the live state.phase", () => {
		expect(readIngestView(view({ phase: "extracting" })).phase).toBe(
			"extracting",
		);
	});

	test("marks complete only with phase complete AND both ids present", () => {
		expect(readIngestView(view({ phase: "complete" })).complete).toBe(false);
		const done = readIngestView(
			view({ phase: "complete", versionId: "v1", proposalId: "p1" }),
		);
		expect(done.complete).toBe(true);
		expect(done.versionId).toBe("v1");
		expect(done.proposalId).toBe("p1");
	});

	test("a finished run with ids also reads complete", () => {
		const done = readIngestView(
			view(
				{ phase: "building", versionId: "v1", proposalId: "p1" },
				"completed",
			),
		);
		expect(done.complete).toBe(true);
	});

	test("a run-level error is a terminal failure", () => {
		expect(readIngestView(view({ phase: "building" }, "error")).failed).toBe(
			true,
		);
	});

	test("state.phase === 'error' is a terminal failure", () => {
		expect(readIngestView(view({ phase: "error" })).failed).toBe(true);
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
