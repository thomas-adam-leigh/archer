import { useNavigate } from "@tanstack/react-router";
import {
	ArrowLeft,
	ArrowRight,
	Loader2,
	Mic,
	Sparkles,
	Square,
} from "lucide-react";
import { type FormEvent, useCallback, useState } from "react";
import { ArcherOrb } from "#/components/archer-orb.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { useFinalizeScratchOnboarding } from "#/lib/hooks.ts";
import { routePath } from "#/lib/onboarding-flow.ts";
import {
	answerStep,
	capturedEntries,
	currentStep,
	goBack,
	initialScriptState,
	isComplete,
	ONBOARDING_QUESTION_COUNT,
	questionNumber,
	type ScriptState,
	skipStep,
} from "#/lib/onboarding-script.ts";
import { fetchPrimaryThreadId } from "#/lib/threads.ts";
import {
	type UseVoiceCapture,
	useVoiceCapture,
} from "#/lib/use-voice-capture.ts";

/**
 * The start-from-scratch screen (ARC-104): the FIXED, preset onboarding sequence
 * the candidate answers when they have no résumé. Archer asks one authored
 * question at a time (no LLM generates them — see `onboarding-script.ts`); each
 * answer is captured and accreted into the live "profile, taking shape" panel.
 *
 * Voice is the primary input (`MediaRecorder` → transcribe, ARC-119) with the text
 * box as the fallback; each captured answer accretes into the live "profile, taking
 * shape" panel. When the script completes, finalize (ARC-105) structures the
 * answers into a PROPOSED profile draft and hands off to review — see
 * {@link CompletePanel}.
 */
export function ScriptedConversation() {
	const [state, setState] = useState<ScriptState>(initialScriptState);

	if (isComplete(state)) {
		return (
			<Layout state={state}>
				<CompletePanel state={state} />
			</Layout>
		);
	}

	return (
		<Layout state={state}>
			<QuestionPanel
				state={state}
				onAnswer={(text) => setState((s) => answerStep(s, text))}
				onSkip={() => setState((s) => skipStep(s))}
				onBack={() => setState((s) => goBack(s))}
			/>
		</Layout>
	);
}

/** The two-column shell: the conversation on the left, the live profile on the right. */
function Layout({
	state,
	children,
}: {
	state: ScriptState;
	children: React.ReactNode;
}) {
	return (
		<div
			data-testid="scripted-conversation"
			className="mx-auto grid w-full max-w-[1040px] gap-10 pt-[4vh] lg:grid-cols-[1fr_320px]"
		>
			<div className="min-w-0">{children}</div>
			<ProfileShapePanel state={state} />
		</div>
	);
}

interface QuestionPanelProps {
	state: ScriptState;
	onAnswer: (text: string) => void;
	onSkip: () => void;
	onBack: () => void;
}

/** The current question, the text composer, and back/skip controls. */
function QuestionPanel({
	state,
	onAnswer,
	onSkip,
	onBack,
}: QuestionPanelProps) {
	const [draft, setDraft] = useState("");
	// Spoken answers land in the same box as typed ones, so the candidate can
	// review/edit before submitting; repeated takes accrete onto the draft.
	const appendTranscript = useCallback(
		(text: string) =>
			setDraft((d) => (d.trim() ? `${d.trim()} ${text}` : text)),
		[],
	);
	const voice = useVoiceCapture(appendTranscript);
	const step = currentStep(state);
	if (!step) return null;

	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (draft.trim() === "") return;
		onAnswer(draft);
		setDraft("");
	};

	const back = () => {
		onBack();
		setDraft("");
	};

	const skip = () => {
		onSkip();
		setDraft("");
	};

	return (
		<div className="a-fadeup">
			<header className="mb-[22px] flex items-center gap-3.5">
				<ArcherOrb size={38} className="!h-[46px] !w-[46px]" />
				<div>
					<div className="font-heading text-[15px] font-semibold">Archer</div>
					<div
						data-testid="conversation-progress"
						className="text-xs text-[var(--txt3)]"
					>
						Question {questionNumber(state)} of {ONBOARDING_QUESTION_COUNT}
					</div>
				</div>
			</header>

			<div className="max-w-[560px] rounded-[20px] rounded-tl-[6px] border border-[var(--line)] bg-[var(--card)] px-[26px] py-6">
				<p
					data-testid="conversation-prompt"
					className="font-heading text-[clamp(19px,2.2vw,24px)] font-medium leading-[1.38] tracking-[-0.01em]"
				>
					{step.prompt}
				</p>
				<p className="mt-3 text-sm text-[var(--txt3)]">{step.hint}</p>
			</div>

			<form onSubmit={submit} className="mt-5 max-w-[560px]">
				<Textarea
					data-testid="conversation-answer"
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					rows={4}
					placeholder="Type your answer…"
					aria-label={step.prompt}
					className="min-h-[120px] resize-none rounded-2xl border-[var(--line)] bg-[var(--card-2)] px-4 py-3.5 text-base"
				/>

				<VoiceControl voice={voice} />
				{voice.error ? (
					<p
						data-testid="voice-error"
						role="alert"
						className="mt-2 text-xs text-[#f0936c]"
					>
						{voice.error}
					</p>
				) : null}

				<div className="mt-4 flex items-center gap-3">
					{state.index > 0 ? (
						<button
							type="button"
							data-testid="conversation-back"
							onClick={back}
							className="flex items-center gap-1.5 rounded-xl border border-[var(--line)] px-4 py-2.5 text-sm font-semibold text-[var(--txt2)] transition-colors hover:border-brand/45 hover:text-[var(--txt)]"
						>
							<ArrowLeft className="size-4" />
							Back
						</button>
					) : null}

					{step.optional ? (
						<button
							type="button"
							data-testid="conversation-skip"
							onClick={skip}
							className="rounded-xl px-3 py-2.5 text-sm font-semibold text-[var(--txt3)] transition-colors hover:text-[var(--txt2)]"
						>
							Skip
						</button>
					) : null}

					<button
						type="submit"
						data-testid="conversation-submit"
						disabled={draft.trim() === ""}
						className="ml-auto flex items-center gap-1.5 rounded-xl bg-[linear-gradient(135deg,var(--accent-2),var(--accent))] px-6 py-3 text-[15px] font-bold text-[#160a02] shadow-[0_10px_28px_var(--glow)] transition-transform hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
					>
						Looks right
						<ArrowRight className="size-4" />
					</button>
				</div>
			</form>
		</div>
	);
}

/**
 * The voice-first capture control: a record/stop pill with a status line.
 * Voice is the primary input for this path; when the browser can't record we
 * fall back to the text box (always present), so onboarding never dead-ends.
 */
function VoiceControl({ voice }: { voice: UseVoiceCapture }) {
	if (!voice.supported) {
		return (
			<p className="mt-2 text-xs text-[var(--txt3)]">Type your answer below.</p>
		);
	}

	const recording = voice.status === "recording";
	const transcribing = voice.status === "transcribing";
	const hint = recording
		? "Listening… tap to stop."
		: transcribing
			? "Structuring what you said…"
			: "Speak your answer, or type it below.";

	return (
		<div className="mt-3 flex items-center gap-3">
			<button
				type="button"
				data-testid="voice-record"
				onClick={recording ? voice.stop : voice.start}
				disabled={transcribing}
				aria-pressed={recording}
				aria-label={recording ? "Stop recording" : "Record your answer"}
				className={`flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
					recording
						? "border-[#f0936c]/60 bg-[#f0936c]/10 text-[#f0936c]"
						: "border-[var(--line)] text-[var(--txt2)] hover:border-brand/45 hover:text-[var(--txt)]"
				}`}
			>
				{transcribing ? (
					<Loader2 className="size-4 animate-spin" />
				) : recording ? (
					<Square className="size-4 fill-current" />
				) : (
					<Mic className="size-4" />
				)}
				{transcribing ? "Transcribing…" : recording ? "Stop" : "Record"}
			</button>
			<p
				data-testid="voice-status"
				className={`text-xs ${recording ? "a-glowpulse text-[#f0936c]" : "text-[var(--txt3)]"}`}
			>
				{hint}
			</p>
		</div>
	);
}

/**
 * The terminal step once every question has been passed: finalize the captured
 * answers into a PROPOSED profile draft (ARC-105) and converge on review (M6).
 *
 * Finalize persists the answers to the thread and runs the guided structurer
 * (`buildProfileFromAnswers`) — the only AI in this path. On success the candidate
 * is sent to the profile review; a failure is recoverable in place with "Try again".
 */
function CompletePanel({ state }: { state: ScriptState }) {
	const navigate = useNavigate();
	const finalize = useFinalizeScratchOnboarding();

	const build = useCallback(() => {
		finalize.mutate(
			{
				answers: capturedEntries(state).map((c) => c.value),
				deps: { resolveThreadId: (s) => fetchPrimaryThreadId(s) },
			},
			{ onSuccess: () => navigate({ to: routePath("review"), replace: true }) },
		);
	}, [finalize, state, navigate]);

	const captured = capturedEntries(state).length;

	return (
		<div data-testid="conversation-complete" className="a-fadeup max-w-[560px]">
			<header className="mb-[22px] flex items-center gap-3.5">
				<ArcherOrb size={38} className="!h-[46px] !w-[46px]" />
				<div>
					<div className="font-heading text-[15px] font-semibold">Archer</div>
					<div className="text-xs text-[var(--txt3)]">
						All questions answered
					</div>
				</div>
			</header>
			<div className="rounded-[20px] rounded-tl-[6px] border border-[var(--line)] bg-[var(--card)] px-[26px] py-6">
				<p className="font-heading text-[clamp(19px,2.2vw,24px)] font-medium leading-[1.38] tracking-[-0.01em]">
					That's everything I need.
				</p>
				<p className="mt-3 text-sm text-[var(--txt2)]">
					{finalize.isPending
						? "Structuring your answers into your profile…"
						: "I've captured your answers — I'll structure them into your profile for you to review."}
				</p>
				<div className="mt-5 inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--card-2)] px-3.5 py-1.5 text-xs font-semibold text-[var(--txt2)]">
					<Sparkles className="size-3.5 text-brand" />
					{captured} answers captured
				</div>

				{finalize.isError ? (
					<p
						data-testid="finalize-error"
						role="alert"
						className="mt-4 text-sm text-[#f0936c]"
					>
						I couldn't build your profile just now. Please try again.
					</p>
				) : null}

				<button
					type="button"
					data-testid="conversation-finalize"
					onClick={build}
					disabled={finalize.isPending}
					className="mt-5 flex items-center gap-1.5 rounded-xl bg-[linear-gradient(135deg,var(--accent-2),var(--accent))] px-6 py-3 text-[15px] font-bold text-[#160a02] shadow-[0_10px_28px_var(--glow)] transition-transform hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0"
				>
					{finalize.isPending ? (
						<Loader2 className="size-4 animate-spin" />
					) : null}
					{finalize.isPending
						? "Building…"
						: finalize.isError
							? "Try again"
							: "Build my profile"}
					{finalize.isPending ? null : <ArrowRight className="size-4" />}
				</button>
			</div>
		</div>
	);
}

/** The live "profile, taking shape" column: captured answers, or an empty state. */
function ProfileShapePanel({ state }: { state: ScriptState }) {
	const captured = capturedEntries(state);
	return (
		<aside
			data-testid="profile-shape"
			className="self-start rounded-[20px] border border-[var(--line)] bg-[var(--card)] px-[22px] py-[22px] lg:sticky lg:top-[18px]"
		>
			<div className="mb-1.5 flex items-center justify-between">
				<div className="font-heading text-[15px] font-semibold">
					Your profile, taking shape
				</div>
				<span className="a-glowpulse size-2 rounded-full bg-[var(--accent)] shadow-[0_0_8px_var(--accent)]" />
			</div>
			<p className="mb-[18px] text-[13px] text-[var(--txt3)]">
				I'm structuring this as we talk.
			</p>

			{captured.length > 0 ? (
				<div className="flex flex-col gap-3.5">
					{captured.map((c) => (
						<div
							key={c.key}
							data-testid={`captured-${c.key}`}
							className="a-fadeup"
						>
							<div className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.09em] text-brand">
								{c.label}
							</div>
							<div className="rounded-xl border border-[var(--line-2)] bg-[var(--card-2)] px-3 py-2.5 text-sm leading-[1.5]">
								{c.value}
							</div>
						</div>
					))}
				</div>
			) : (
				<div className="rounded-[14px] border border-dashed border-[var(--line-2)] px-2.5 py-[30px] text-center text-[13px] leading-[1.6] text-[var(--txt3)]">
					Nothing yet.
					<br />
					Answer my first question and watch this fill in.
				</div>
			)}
		</aside>
	);
}
