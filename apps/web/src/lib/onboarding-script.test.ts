import { describe, expect, test } from "vitest";
import {
	answerStep,
	capturedEntries,
	currentStep,
	goBack,
	initialScriptState,
	isComplete,
	ONBOARDING_QUESTION_COUNT,
	ONBOARDING_SCRIPT,
	questionNumber,
	type ScriptState,
	skipStep,
} from "#/lib/onboarding-script.ts";

describe("ONBOARDING_SCRIPT", () => {
	test("leads with identity and ends on ambition, with unique keys", () => {
		expect(ONBOARDING_SCRIPT[0].key).toBe("about");
		expect(ONBOARDING_SCRIPT.at(-1)?.key).toBe("ambition");
		const keys = ONBOARDING_SCRIPT.map((s) => s.key);
		expect(new Set(keys).size).toBe(keys.length);
	});

	test("does not include negative criteria (that's its own later stage)", () => {
		expect(ONBOARDING_SCRIPT.map((s) => s.key)).not.toContain("avoid");
	});

	test("the question count matches the script length", () => {
		expect(ONBOARDING_QUESTION_COUNT).toBe(ONBOARDING_SCRIPT.length);
	});
});

describe("initialScriptState", () => {
	test("parks on the first question with nothing captured", () => {
		const s = initialScriptState();
		expect(s.index).toBe(0);
		expect(s.answers).toEqual({});
		expect(currentStep(s)).toBe(ONBOARDING_SCRIPT[0]);
		expect(isComplete(s)).toBe(false);
		expect(questionNumber(s)).toBe(1);
	});
});

/** Walk the whole script by answering each step with "<key> answer". */
function answerAll(): ScriptState {
	return ONBOARDING_SCRIPT.reduce(
		(s, step) => answerStep(s, `${step.key} answer`),
		initialScriptState(),
	);
}

describe("answerStep", () => {
	test("captures the trimmed answer under the step key and advances", () => {
		const s = answerStep(initialScriptState(), "  Ada — a staff engineer.  ");
		expect(s.index).toBe(1);
		expect(s.answers.about).toBe("Ada — a staff engineer.");
		expect(currentStep(s)?.key).toBe("recent");
	});

	test("ignores an empty or whitespace-only answer", () => {
		const start = initialScriptState();
		expect(answerStep(start, "   ")).toEqual(start);
		expect(answerStep(start, "")).toEqual(start);
	});

	test("is a no-op once the sequence is complete", () => {
		const done = answerAll();
		expect(isComplete(done)).toBe(true);
		expect(answerStep(done, "extra")).toEqual(done);
	});
});

describe("skipStep", () => {
	test("advances past an optional step without capturing", () => {
		// about → recent → (path is optional)
		let s = answerStep(initialScriptState(), "a");
		s = answerStep(s, "b");
		expect(currentStep(s)?.key).toBe("path");
		expect(currentStep(s)?.optional).toBe(true);
		const skipped = skipStep(s);
		expect(skipped.index).toBe(s.index + 1);
		expect(skipped.answers).not.toHaveProperty("path");
	});

	test("is a no-op on a required step", () => {
		const s = initialScriptState();
		expect(currentStep(s)?.optional).toBeUndefined();
		expect(skipStep(s)).toEqual(s);
	});

	test("clears any answer previously given before skipping", () => {
		let s = answerStep(initialScriptState(), "a");
		s = answerStep(s, "b"); // now on optional "path"
		const answered = answerStep(s, "some path"); // capture then go back to skip it
		const back = goBack(answered);
		expect(back.answers.path).toBe("some path");
		expect(skipStep(back).answers).not.toHaveProperty("path");
	});
});

describe("goBack", () => {
	test("returns to the previous step, keeping captured answers", () => {
		const s = answerStep(initialScriptState(), "Ada");
		const back = goBack(s);
		expect(back.index).toBe(0);
		expect(back.answers.about).toBe("Ada");
		expect(currentStep(back)?.key).toBe("about");
	});

	test("is a no-op on the first step", () => {
		const s = initialScriptState();
		expect(goBack(s)).toEqual(s);
	});
});

describe("isComplete / questionNumber", () => {
	test("completes after the last answer and clamps the question number", () => {
		const done = answerAll();
		expect(done.index).toBe(ONBOARDING_SCRIPT.length);
		expect(isComplete(done)).toBe(true);
		expect(currentStep(done)).toBeNull();
		expect(questionNumber(done)).toBe(ONBOARDING_QUESTION_COUNT);
	});
});

describe("capturedEntries", () => {
	test("returns answered steps in script order as label/value pairs", () => {
		let s = answerStep(initialScriptState(), "Ada — staff engineer");
		s = answerStep(s, "Acme, lead on billing");
		expect(capturedEntries(s)).toEqual([
			{ key: "about", label: "About", value: "Ada — staff engineer" },
			{ key: "recent", label: "Recent role", value: "Acme, lead on billing" },
		]);
	});

	test("omits skipped and not-yet-reached steps", () => {
		let s = answerStep(initialScriptState(), "Ada");
		s = answerStep(s, "Acme");
		s = skipStep(s); // skip optional "path"
		expect(capturedEntries(s).map((e) => e.key)).toEqual(["about", "recent"]);
	});
});
