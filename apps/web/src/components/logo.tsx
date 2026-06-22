import { cn } from "#/lib/utils.ts";

/** Archer wordmark — orange rounded-square mark + "Archer" in Space Grotesk. */
export function Logo({ className }: { className?: string }) {
	return (
		<div
			className={cn("flex items-center gap-[11px]", className)}
			data-testid="app-logo"
		>
			<div
				className="flex size-[30px] items-center justify-center rounded-[9px]"
				style={{
					background: "linear-gradient(140deg, var(--accent-2), var(--accent))",
					boxShadow: "0 6px 22px var(--glow)",
				}}
			>
				<div className="size-[11px] rounded-full bg-[#0c0c0d]" />
			</div>
			<span className="font-heading text-[18px] font-bold tracking-[-0.01em] text-foreground">
				Archer
			</span>
		</div>
	);
}
