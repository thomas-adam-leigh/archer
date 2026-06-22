import { cn } from "#/lib/utils.ts";

interface ProgressStepsProps {
	/** Number of completed/active segments (1-based). */
	current?: number;
	/** Total segments in the onboarding flow. */
	total?: number;
	className?: string;
}

/**
 * The top-center onboarding progress indicator: `total` segments, the first
 * `current` of which are lit orange. Route-state wiring lands in ARC-99.
 */
export function ProgressSteps({
	current = 1,
	total = 4,
	className,
}: ProgressStepsProps) {
	return (
		<div
			className={cn("flex items-center gap-[7px]", className)}
			data-testid="onboarding-progress"
			role="progressbar"
			aria-valuemin={0}
			aria-valuemax={total}
			aria-valuenow={current}
			aria-label={`Onboarding step ${current} of ${total}`}
		>
			{Array.from({ length: total }, (_, i) => {
				const active = i < current;
				return (
					<span
						// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length, non-reordering progress segments
						key={`segment-${total}-${i}`}
						className="h-1 w-[30px] rounded-[3px] transition-[background,box-shadow] duration-300"
						style={
							active
								? {
										background:
											"linear-gradient(90deg, var(--accent-2), var(--accent))",
										boxShadow: "0 0 12px var(--glow)",
									}
								: { background: "var(--line)" }
						}
					/>
				);
			})}
		</div>
	);
}
