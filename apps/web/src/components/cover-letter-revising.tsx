import { Loader2 } from "lucide-react";

/**
 * The "Archer is reworking your letter" overlay (ARC-150), shown over the cover-letter
 * review right after the candidate sends feedback — the cover-letter sibling of the
 * profile review's {@link file://./profile-revising.tsx ProfileRevising} overlay
 * (ARC-129), reusing its visual language.
 *
 * Unlike the profile revise — which streams a run the web app owns — a cover letter
 * is reworked by Archer's daily pipeline (the web app is the human gate, not the
 * compute trigger), so there's no client-owned run thread to stream. The owning
 * route instead polls for the reworked draft's fresh proposal and re-presents it the
 * moment it lands; this overlay is the calm "reworking…" surface shown meanwhile. It
 * is presentational — completion is the route's real fresh-proposal signal, never a
 * timer.
 */
export function CoverLetterRevising() {
	return (
		<div
			data-testid="cover-letter-reworking"
			className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-5 rounded-[24px] bg-[rgba(8,8,9,0.82)] px-6 text-center backdrop-blur-[6px]"
			aria-busy="true"
		>
			<div className="relative flex size-[96px] items-center justify-center">
				<div
					className="a-glowpulse absolute inset-0 rounded-full"
					style={{
						background:
							"radial-gradient(circle, var(--glow) 0%, transparent 68%)",
					}}
				/>
				<Loader2 className="size-7 animate-spin text-[var(--accent)]" />
			</div>

			<div>
				<h2 className="min-h-[30px] font-heading text-[clamp(18px,2.2vw,22px)] font-bold tracking-tight">
					Reworking your letter…
				</h2>
				<p className="mt-2 text-sm text-[var(--txt2)]">
					I've taken your feedback on board — bringing you a new draft.
				</p>
			</div>

			<div className="w-full max-w-[360px]">
				<div className="h-1.5 overflow-hidden rounded-[6px] bg-[rgba(255,255,255,0.08)]">
					<div className="a-glowpulse h-full w-1/2 rounded-[6px] bg-[linear-gradient(90deg,var(--accent-2),var(--accent))]" />
				</div>
			</div>
		</div>
	);
}
