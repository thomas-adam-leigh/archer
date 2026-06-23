import type { ThreadView } from "@archer/agui-client";
import { describe, expect, test } from "vitest";
import {
	REVISE_PHASES,
	readReviseView,
	reviseProcessingView,
} from "#/lib/revise-processing.ts";

/** Build a folded view with a given shared state + lifecycle phase. */
function view(
	state: Record<string, string>,
	phase: ThreadView["phase"] = "running",
): ThreadView {
	return { state, messages: [], interrupts: [], phase };
}

describe("reviseProcessingView", () => {
	test("starts on the first heading with nothing logged on the reading phase", () => {
		const v = reviseProcessingView("reading");
		expect(v.title).toBe(REVISE_PHASES[0].title);
		expect(v.log).toEqual([]);
		expect(v.pct).toBe(REVISE_PHASES[0].pct);
	});

	test("activates the revising phase, logging the read phase behind it", () => {
		const v = reviseProcessingView("revising");
		expect(v.title).toBe(REVISE_PHASES[1].title);
		expect(v.log).toEqual([REVISE_PHASES[0].log]);
		expect(v.pct).toBe(REVISE_PHASES[1].pct);
	});

	test("holds on the final heading at 100% with the full log when complete", () => {
		const v = reviseProcessingView("complete");
		expect(v.title).toBe(REVISE_PHASES[REVISE_PHASES.length - 1].title);
		expect(v.log).toHaveLength(REVISE_PHASES.length);
		expect(v.pct).toBe(100);
	});

	test("falls back to the first phase for an unknown/absent phase", () => {
		expect(reviseProcessingView(undefined).log).toEqual([]);
		expect(reviseProcessingView("nonsense").title).toBe(REVISE_PHASES[0].title);
	});
});

describe("readReviseView", () => {
	test("a null view reads as the first phase, still running", () => {
		const s = readReviseView(null, "v1");
		expect(s.phase).toBe(REVISE_PHASES[0].key);
		expect(s.failed).toBe(false);
		expect(s.complete).toBe(false);
	});

	test("surfaces the live state.phase while revising", () => {
		expect(readReviseView(view({ phase: "revising" }), "v1").phase).toBe(
			"revising",
		);
	});

	test("the stale prior-run complete (same version) is shown as the first phase, not done", () => {
		// On arrival the thread carries the current proposed version's terminal state.
		const stale = readReviseView(
			view(
				{ phase: "complete", versionId: "v1", proposalId: "p1" },
				"completed",
			),
			"v1",
		);
		expect(stale.complete).toBe(false);
		expect(stale.phase).toBe(REVISE_PHASES[0].key);
	});

	test("completes only once a FRESH version (different from the on-screen one) lands", () => {
		const fresh = readReviseView(
			view(
				{ phase: "complete", versionId: "v2", proposalId: "p2" },
				"completed",
			),
			"v1",
		);
		expect(fresh.complete).toBe(true);
		expect(fresh.versionId).toBe("v2");
		expect(fresh.proposalId).toBe("p2");
	});

	test("does not complete on a complete phase that carries no version yet", () => {
		// The new run's opening snapshot resets state to just `{ phase: 'reading' }`.
		expect(readReviseView(view({ phase: "reading" }), "v1").complete).toBe(
			false,
		);
	});

	test("a run-level error is a terminal failure", () => {
		expect(
			readReviseView(view({ phase: "revising" }, "error"), "v1").failed,
		).toBe(true);
	});

	test("state.phase === 'error' is a terminal failure", () => {
		expect(readReviseView(view({ phase: "error" }), "v1").failed).toBe(true);
	});
});
