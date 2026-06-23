import type { createThreadSession, ThreadView } from "@archer/agui-client";
import { useEffect, useRef, useState } from "react";
import { createWebThreadSession } from "#/lib/agui.ts";
import type { Session } from "#/lib/auth.ts";
import {
	PROCESSING_SUBTEXT,
	processingView,
	readIngestView,
} from "#/lib/resume-processing.ts";

/**
 * The résumé "reading every line" processing screen (ARC-102/ARC-125): a
 * full-screen, non-interruptible state shown while the ingest run builds the
 * draft profile.
 *
 * It subscribes to the run's AG-UI `events` via the shared client
 * (`createWebThreadSession`) — seeding from history, streaming live over Supabase
 * Realtime, and folding the run response — and renders the spec's build
 * experience (breathing orb, advancing heading, progress bar, accreting log)
 * **from the live `state.phase`** the backend emits (`reading → extracting →
 * building → complete`). There is no timer: the card only ever shows progress the
 * backend has actually made.
 *
 * It signals upward rather than navigating: {@link onComplete} fires once the
 * proposed draft lands (`state.phase === 'complete'` with ids, or the run finishes
 * successfully), and {@link onError} fires on a terminal run failure (`run_error`
 * / `state.phase === 'error'`). The owning route keeps polling
 * `/onboarding/progress` as a reconnect/fallback, so a dropped socket still
 * advances the flow.
 *
 * On failure the card shows a single **Try again** — the only action in this
 * otherwise actionless stage.
 */
interface ResumeProcessingProps {
	/** The authenticated session (its access token authorizes history + Realtime). */
	session: Session;
	/** The ingest run's thread; `null` until the upload's ingest start resolves it. */
	threadId: string | null;
	/** The chosen résumé's filename, shown as the eyebrow above the heading. */
	fileName: string;
	/** `processing` streams the live build; `error` shows the recoverable failure. */
	status: "processing" | "error";
	/** Body copy for the failure card; defaults to the résumé ingest wording. */
	failureMessage?: string;
	/** Fired once when the proposed draft lands — the route advances to review. */
	onComplete: () => void;
	/** Fired once on a terminal run failure — the route surfaces the error stage. */
	onError: (message?: string) => void;
	/** Restart the résumé path from intake (the failure card's only action). */
	onRetry: () => void;
	/** Injectable thread-session factory so the suite runs without a real socket. */
	createSession?: typeof createThreadSession;
}

const DEFAULT_FAILURE =
	"Archer couldn't finish reading your résumé. Please try again.";

export function ResumeProcessing({
	session,
	threadId,
	fileName,
	status,
	failureMessage = DEFAULT_FAILURE,
	onComplete,
	onError,
	onRetry,
	createSession,
}: ResumeProcessingProps) {
	const [view, setView] = useState<ThreadView | null>(null);
	// Fire each upward signal at most once per run.
	const completed = useRef(false);
	const errored = useRef(false);

	// Open the live session while processing a known thread. Seed from history,
	// stream live; a failed seed is non-fatal (Realtime + the poll still drive).
	useEffect(() => {
		if (status !== "processing" || !threadId) return;
		completed.current = false;
		errored.current = false;
		const ts = createWebThreadSession({
			session,
			threadId,
			onChange: setView,
			createSession,
		});
		try {
			ts.subscribe();
		} catch {
			// Opening the socket is best-effort: a host that can't (no WebSocket,
			// a bad URL) still gets history + the route's progress poll.
		}
		ts.loadHistory()
			.then(setView)
			.catch(() => {
				// Non-fatal: the live stream + the route's progress poll still advance.
			});
		return () => {
			ts.close();
			setView(null);
		};
	}, [status, threadId, session, createSession]);

	const ingest = readIngestView(view);

	// Signal completion / failure exactly once, while still processing.
	useEffect(() => {
		if (status !== "processing") return;
		if (ingest.failed && !errored.current) {
			errored.current = true;
			onError();
		} else if (ingest.complete && !completed.current) {
			completed.current = true;
			onComplete();
		}
	}, [status, ingest.failed, ingest.complete, onComplete, onError]);

	if (status === "error" || ingest.failed) {
		return (
			<div className="a-fadeup mx-auto w-full max-w-[460px] pt-[9vh] text-center">
				<h1 className="font-heading text-[clamp(22px,2.6vw,28px)] font-bold tracking-tight">
					Something went wrong
				</h1>
				<p
					data-testid="resume-processing-error"
					className="mx-auto mt-3 max-w-[400px] text-[15px] text-[var(--txt2)]"
				>
					{failureMessage}
				</p>
				<button
					type="button"
					data-testid="resume-retry"
					onClick={onRetry}
					className="mt-7 inline-block rounded-xl border border-[var(--line)] px-6 py-3 text-sm font-semibold text-[var(--txt2)] transition-colors hover:border-brand/45 hover:text-[var(--txt)]"
				>
					Try again
				</button>
			</div>
		);
	}

	const card = processingView(ingest.phase);

	return (
		<div
			data-testid="resume-processing"
			className="a-fadeup mx-auto w-full max-w-[560px] pt-[9vh] text-center"
		>
			<div className="relative mx-auto mb-10 flex size-[160px] items-center justify-center">
				<div
					className="a-glowpulse absolute inset-0 rounded-full"
					style={{
						background:
							"radial-gradient(circle, var(--glow) 0%, transparent 68%)",
					}}
				/>
				<div
					className="a-breathe size-[78px] rounded-full"
					style={{
						background:
							"linear-gradient(145deg, var(--accent-2), var(--accent) 60%, #9c4310)",
						boxShadow:
							"0 0 40px var(--glow), inset 0 4px 12px rgba(255,255,255,0.32)",
					}}
				/>
			</div>

			<div className="mb-2.5 text-[13px] font-bold uppercase tracking-[0.1em] text-[var(--txt3)]">
				{fileName}
			</div>
			<h1
				data-testid="resume-processing-stage"
				className="min-h-[34px] font-heading text-[clamp(22px,2.6vw,26px)] font-bold tracking-tight"
			>
				{card.title}
			</h1>
			<p className="mt-2 text-[15px] text-[var(--txt2)]">
				{PROCESSING_SUBTEXT}
			</p>

			<div className="mx-auto mt-7 mb-9 max-w-[420px]">
				<div className="h-1.5 overflow-hidden rounded-[6px] bg-[rgba(255,255,255,0.08)]">
					<div
						className="h-full rounded-[6px] bg-[linear-gradient(90deg,var(--accent-2),var(--accent))] transition-[width] duration-500 ease-out"
						style={{ width: `${card.pct}%` }}
					/>
				</div>
			</div>

			<ul
				data-testid="resume-build-log"
				className="mx-auto flex max-w-[380px] flex-col gap-2.5 text-left"
			>
				{card.log.map((line) => (
					<li
						key={line}
						className="a-fadeup flex items-center gap-3 text-sm text-[var(--txt2)]"
					>
						<span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] text-[11px] text-brand">
							✓
						</span>
						{line}
					</li>
				))}
			</ul>
		</div>
	);
}
