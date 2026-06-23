import { Crosshair, Loader2 } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";

/**
 * The ranked target-titles card for the hunt-setup stage (ARC-111).
 *
 * Archer suggests ~5 best-fit roles from the approved profile (read on mount by
 * the route); this renders them, ranked, as the "here's what I'll hunt for"
 * focus. Presentational — the route owns the suggest query and confirms the set
 * on the stage's single "Send to Archer →" submit, mirroring the spec's combined
 * titles + rule-outs screen.
 */
export function TargetTitles({
	titles,
	loading = false,
	error = null,
	onRetry,
}: {
	titles: string[];
	loading?: boolean;
	error?: string | null;
	onRetry?: () => void;
}) {
	return (
		<div className="mb-4 rounded-[18px] border border-[var(--line-2)] bg-[var(--card-2)] px-[22px] py-5">
			<div className="mb-1.5 flex items-center gap-2.5">
				<Crosshair className="size-[17px] text-[var(--accent)]" />
				<div className="font-heading text-[15px] font-semibold">
					Target titles
				</div>
			</div>
			<p className="mb-3.5 text-[13px] text-[var(--txt3)]">
				Where I'll focus first — your best-fit roles, ranked.
			</p>

			{loading ? (
				<output
					className="flex min-h-[96px] items-center justify-center"
					aria-busy="true"
					aria-label="Loading target titles"
				>
					<Loader2 className="size-5 animate-spin text-[var(--accent)]" />
				</output>
			) : error ? (
				<div className="flex flex-col items-start gap-2.5">
					<p
						className="text-[13px] font-semibold text-[var(--accent-2)]"
						role="alert"
					>
						{error}
					</p>
					{onRetry ? (
						<Button type="button" variant="outline" onClick={onRetry}>
							Try again
						</Button>
					) : null}
				</div>
			) : (
				<ol className="flex flex-col gap-2" data-testid="target-titles-list">
					{titles.map((title, i) => (
						<li
							key={title}
							className="flex items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--card)] px-3.5 py-2.5"
						>
							<span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-brand/12 font-heading text-[12px] font-bold text-[var(--accent-2)]">
								{i + 1}
							</span>
							<span className="text-[14px] font-semibold">{title}</span>
						</li>
					))}
				</ol>
			)}
		</div>
	);
}
