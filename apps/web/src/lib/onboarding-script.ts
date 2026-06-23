/**
 * The start-from-scratch onboarding script — a FIXED, designed sequence of preset
 * prompts and a tiny pure step machine over them.
 *
 * This path is deliberately NOT the mobile LLM `/agui/run` conversation: no model
 * generates the questions. The copy below is static, authored here, and the order
 * is deterministic. The only AI in this path is per-answer extraction (ARC-105),
 * which reads the captured answers this machine accumulates; voice capture of each
 * answer (ARC-119) layers on top of the text fallback the screen ships with.
 *
 * Kept pure (no React, no router) so the progression rules are unit-tested in
 * isolation; the conversation screen just renders {@link currentStep} and feeds
 * answers back through {@link answerStep} / {@link skipStep} / {@link goBack}.
 */

/** One preset step: Archer's question plus how it shows in the live profile panel. */
export interface ScriptStep {
	/** Stable identity, also the key the captured answer is stored under. */
	readonly key: string;
	/** Short label for the "profile, taking shape" panel (e.g. "Recent role"). */
	readonly label: string;
	/** The preset question Archer asks (static copy). */
	readonly prompt: string;
	/** A small steer shown under the prompt to make a good answer easy to give. */
	readonly hint: string;
	/** Whether the candidate may move on without answering (back/skip where sensible). */
	readonly optional?: boolean;
}

/**
 * The authored sequence: identity → recent role → earlier path → education →
 * skills → ambition. It mirrors the spec's "start from scratch" interview but is
 * owned here. Negative criteria ("never send me") is its own later stage (M7), so
 * it is intentionally not part of this profile-building script.
 */
export const ONBOARDING_SCRIPT: readonly ScriptStep[] = [
	{
		key: "about",
		label: "About",
		prompt: "To start — what's your name, and what do you do?",
		hint: "Your name and the one line you'd lead with.",
	},
	{
		key: "recent",
		label: "Recent role",
		prompt:
			"Tell me about your most recent role. Where, and what did you work on?",
		hint: "Company, your title, and what you actually built or owned.",
	},
	{
		key: "path",
		label: "Background",
		prompt: "What came before that? Walk me through your path.",
		hint: "Earlier roles or projects that shaped you — a sentence each is plenty.",
		optional: true,
	},
	{
		key: "education",
		label: "Education",
		prompt: "Where did you study, or how did you learn your craft?",
		hint: "Degrees, courses, or self-taught — whatever's true.",
		optional: true,
	},
	{
		key: "skills",
		label: "Skills",
		prompt:
			"What are you genuinely great at — the tools and languages you reach for?",
		hint: "The strengths you'd want me to lead with.",
	},
	{
		key: "ambition",
		label: "Ambition",
		prompt:
			"Now the fun part: what do you want next? The role you'd be thrilled to land.",
		hint: "Target role, level, and what would make it a yes.",
	},
];

/** How many questions the candidate sees — the "of N" in "Question 2 of N". */
export const ONBOARDING_QUESTION_COUNT = ONBOARDING_SCRIPT.length;

/**
 * Progress through the script: the current step index and the answers captured so
 * far, keyed by step. `index === ONBOARDING_SCRIPT.length` means every step has
 * been passed (the sequence is complete).
 */
export interface ScriptState {
	readonly index: number;
	readonly answers: Readonly<Record<string, string>>;
}

/** A fresh run, parked on the first question with nothing captured. */
export function initialScriptState(): ScriptState {
	return { index: 0, answers: {} };
}

/** Whether the whole sequence has been passed (no current step remains). */
export function isComplete(state: ScriptState): boolean {
	return state.index >= ONBOARDING_SCRIPT.length;
}

/** The step the candidate is on, or `null` once the sequence is complete. */
export function currentStep(state: ScriptState): ScriptStep | null {
	return ONBOARDING_SCRIPT[state.index] ?? null;
}

/** The 1-based number of the current question, clamped to the script length. */
export function questionNumber(state: ScriptState): number {
	return Math.min(state.index + 1, ONBOARDING_QUESTION_COUNT);
}

/**
 * Record the current step's answer and advance. Trims surrounding whitespace; an
 * empty (or whitespace-only) answer is ignored so the screen can't bank a blank —
 * callers gate the submit, this is the backstop. A no-op once complete.
 */
export function answerStep(state: ScriptState, text: string): ScriptState {
	const step = currentStep(state);
	if (!step) return state;
	const value = text.trim();
	if (value === "") return state;
	return {
		index: state.index + 1,
		answers: { ...state.answers, [step.key]: value },
	};
}

/**
 * Advance past the current step without capturing an answer. Only optional steps
 * may be skipped (a no-op otherwise); any answer previously given for the step is
 * cleared so a skip after editing doesn't leave stale text behind.
 */
export function skipStep(state: ScriptState): ScriptState {
	const step = currentStep(state);
	if (!step || !step.optional) return state;
	const { [step.key]: _dropped, ...rest } = state.answers;
	return { index: state.index + 1, answers: rest };
}

/**
 * Step back to the previous question, keeping every captured answer so it can be
 * reviewed or revised. A no-op on the first step.
 */
export function goBack(state: ScriptState): ScriptState {
	if (state.index === 0) return state;
	return { index: state.index - 1, answers: state.answers };
}

/** One captured answer, ready to render in the "profile, taking shape" panel. */
export interface CapturedAnswer {
	readonly key: string;
	readonly label: string;
	readonly value: string;
}

/**
 * The answered steps, in script order, as label/value pairs for the live panel.
 * Steps that were skipped (or not yet reached) are omitted.
 */
export function capturedEntries(state: ScriptState): CapturedAnswer[] {
	return ONBOARDING_SCRIPT.flatMap((step) => {
		const value = state.answers[step.key];
		return value ? [{ key: step.key, label: step.label, value }] : [];
	});
}
