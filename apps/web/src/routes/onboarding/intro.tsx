import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowRight, FileUp, Mic } from "lucide-react";
import type { ReactNode } from "react";
import { ArcherOrb } from "#/components/archer-orb.tsx";
import { progressSegmentForRoute, routePath } from "#/lib/onboarding-flow.ts";
import { useOnboardingResume } from "#/lib/onboarding-guard.ts";
import { cn } from "#/lib/utils.ts";
import { OnboardingGate } from "./route.tsx";

export const Route = createFileRoute("/onboarding/intro")({
	component: IntroRoute,
	staticData: { onboardingStep: progressSegmentForRoute("intro") },
});

/**
 * The onboarding entry — "Meet Archer". The brand orb, a short framing, and the
 * two-path choice. Each card dispatches its path (résumé upload or the scratch
 * conversation); both remain the backend `intro` step until a profile draft
 * exists. Visual treatment ported from the design spec's intro stage (ARC-98).
 */
function IntroRoute() {
	const navigate = useNavigate();
	const resume = useOnboardingResume("intro");
	if (resume.status !== "ready") return <OnboardingGate resume={resume} />;

	return (
		<div className="a-fadeup mx-auto flex max-w-[760px] flex-col items-center pt-[5vh] text-center">
			<ArcherOrb size={74} className="mb-[26px]" />

			<h1 className="font-heading text-[clamp(26px,3.4vw,38px)] font-bold tracking-tight">
				Hi, I'm Archer.
			</h1>
			<p className="mt-4 max-w-[560px] text-[clamp(16px,1.6vw,19px)] leading-relaxed text-[var(--txt2)]">
				I'm here to find your next role. Before I can search on your behalf, I
				need to understand who you are, what you've done, and where you want to
				go. Two ways to start —
			</p>

			<div className="mt-10 grid w-full gap-[18px] text-left sm:grid-cols-2">
				<PathCard
					testid="intro-path-resume"
					icon={<FileUp className="size-[22px]" strokeWidth={2} />}
					title="Upload my résumé"
					blurb="The fast track. I'll read your document and build your profile from it in seconds."
					cta="Word document"
					onClick={() => navigate({ to: routePath("resume"), replace: true })}
				/>
				<PathCard
					testid="intro-path-conversation"
					icon={<Mic className="size-[22px]" strokeWidth={2} />}
					title="Start from scratch"
					blurb="No résumé needed. Just talk to me — I'll interview you and build it as we go."
					cta="A quick conversation"
					onClick={() =>
						navigate({ to: routePath("conversation"), replace: true })
					}
				/>
			</div>
		</div>
	);
}

interface PathCardProps {
	testid: string;
	icon: ReactNode;
	title: string;
	blurb: string;
	cta: string;
	onClick: () => void;
}

function PathCard({ testid, icon, title, blurb, cta, onClick }: PathCardProps) {
	return (
		<button
			type="button"
			data-testid={testid}
			onClick={onClick}
			className={cn(
				"group relative overflow-hidden rounded-[22px] border border-[var(--line)] bg-[var(--card)] p-[30px_26px] text-left text-[var(--txt)]",
				"transition-[border-color,transform,background,box-shadow] duration-200",
				"hover:-translate-y-0.5 hover:border-brand/45 hover:bg-white/[0.055] hover:shadow-[0_18px_44px_var(--glow-soft)]",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]",
			)}
		>
			<div className="mb-[18px] flex size-[46px] items-center justify-center rounded-[13px] border border-[color-mix(in_srgb,var(--accent)_30%,transparent)] bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-brand">
				{icon}
			</div>
			<div className="mb-[7px] font-heading text-[19px] font-semibold">
				{title}
			</div>
			<div className="text-sm leading-relaxed text-[var(--txt2)]">{blurb}</div>
			<div className="mt-4 flex items-center gap-1.5 text-[13px] font-semibold text-brand">
				{cta}
				<ArrowRight className="size-4 transition-transform duration-200 group-hover:translate-x-0.5" />
			</div>
		</button>
	);
}
