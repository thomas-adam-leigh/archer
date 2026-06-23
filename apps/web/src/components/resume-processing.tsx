import { useEffect, useState } from "react";
import {
	INGEST_PHASES,
	PROCESSING_SUBTEXT,
	processingView,
} from "#/lib/resume-processing.ts";

/**
 * The résumé "reading every line" processing screen (ARC-102): a full-screen,
 * non-interruptible state shown while the ingest run builds the draft profile.
 *
 * It renders the spec's build experience — a breathing orb, an advancing heading
 * (`buildStageText`), a progress bar (`buildPct`), and an accreting build log
 * (`buildLog`) — driven by a presentational cadence ({@link processingView} over a
 * ticking counter). That cadence is reassurance only: it advances through the
 * phases and then *holds* on the last one. The owning route ends the wait on the
 * real `/onboarding/progress` readiness signal, never on this timer.
 *
 * On failure the route flips `status` to `"error"` and the card offers a single
 * **Try again** — the only action available in this otherwise actionless stage.
 */
interface ResumeProcessingProps {
	/** The chosen résumé's filename, shown as the eyebrow above the heading. */
	fileName: string;
	/** `processing` runs the build cadence; `error` shows the recoverable failure. */
	status: "processing" | "error";
	/** Body copy for the failure card; defaults to the résumé ingest wording. */
	failureMessage?: string;
	/** Restart the résumé path from intake (the failure card's only action). */
	onRetry: () => void;
	/** Milliseconds between revealed phases; overridable so tests/Cypress run fast. */
	cadenceMs?: number;
}

const DEFAULT_FAILURE =
	"Archer couldn't finish reading your résumé. Please try again.";

export function ResumeProcessing({
	fileName,
	status,
	failureMessage = DEFAULT_FAILURE,
	onRetry,
	cadenceMs = 1500,
}: ResumeProcessingProps) {
	// The presentational cadence: how many phases have been revealed so far.
	const [revealed, setRevealed] = useState(0);

	useEffect(() => {
		if (status !== "processing") return;
		setRevealed(0);
		const id = setInterval(() => {
			setRevealed((n) => Math.min(n + 1, INGEST_PHASES.length));
		}, cadenceMs);
		return () => clearInterval(id);
	}, [status, cadenceMs]);

	if (status === "error") {
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

	const view = processingView(revealed);

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
				{view.title}
			</h1>
			<p className="mt-2 text-[15px] text-[var(--txt2)]">
				{PROCESSING_SUBTEXT}
			</p>

			<div className="mx-auto mt-7 mb-9 max-w-[420px]">
				<div className="h-1.5 overflow-hidden rounded-[6px] bg-[rgba(255,255,255,0.08)]">
					<div
						className="h-full rounded-[6px] bg-[linear-gradient(90deg,var(--accent-2),var(--accent))] transition-[width] duration-500 ease-out"
						style={{ width: `${view.pct}%` }}
					/>
				</div>
			</div>

			<ul
				data-testid="resume-build-log"
				className="mx-auto flex max-w-[380px] flex-col gap-2.5 text-left"
			>
				{view.log.map((line) => (
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
