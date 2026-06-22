import type { ReactNode } from "react";
import { Logo } from "#/components/logo.tsx";
import { ProgressSteps } from "#/components/progress-steps.tsx";

interface AppShellProps {
	children: ReactNode;
	/** Current onboarding step (1-based). Omit to hide the progress indicator. */
	step?: number;
	totalSteps?: number;
}

/**
 * Persistent onboarding chrome: Archer logo (top-left) and the optional
 * progress indicator (top-center), over the radial dark background. Page
 * content renders in the centered <main>.
 */
export function AppShell({ children, step, totalSteps = 4 }: AppShellProps) {
	return (
		<div className="relative flex min-h-svh flex-col">
			<header className="relative z-10 mx-auto flex w-full max-w-[1180px] items-center justify-between gap-4 px-[26px] py-[22px]">
				<Logo />
				{step != null ? (
					<ProgressSteps current={step} total={totalSteps} />
				) : (
					<div />
				)}
				{/* Right-side spacer keeps the indicator visually centred. */}
				<div className="w-[74px]" />
			</header>
			<main className="relative z-[2] mx-auto w-full max-w-[1180px] flex-1 px-[26px] pb-[90px]">
				{children}
			</main>
		</div>
	);
}
