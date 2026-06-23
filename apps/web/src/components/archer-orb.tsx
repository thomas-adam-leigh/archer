import { cn } from "#/lib/utils.ts";

interface ArcherOrbProps {
	/** Diameter of the gradient sphere in px (the glow halo scales around it). */
	size?: number;
	className?: string;
}

/**
 * Archer's brand orb: a soft radial glow behind a breathing orange gradient
 * sphere. Ported from the design spec, where it heads the "Meet Archer" intro
 * and recurs across later stages. Decorative — hidden from assistive tech.
 */
export function ArcherOrb({ size = 74, className }: ArcherOrbProps) {
	return (
		<div
			aria-hidden="true"
			className={cn("relative flex items-center justify-center", className)}
			style={{ width: size + 28, height: size + 28 }}
		>
			<div
				className="a-glowpulse absolute rounded-full"
				style={{
					inset: 0,
					background:
						"radial-gradient(circle, var(--glow) 0%, transparent 70%)",
				}}
			/>
			<div
				className="a-breathe rounded-full"
				style={{
					width: size,
					height: size,
					background:
						"linear-gradient(145deg, var(--accent-2), var(--accent) 60%, #9c4310)",
					boxShadow:
						"0 0 44px var(--glow), inset 0 4px 12px rgba(255, 255, 255, 0.32)",
				}}
			/>
		</div>
	);
}
