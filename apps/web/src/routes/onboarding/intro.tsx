import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Button } from "#/components/ui/button.tsx";
import { progressSegmentForRoute, routePath } from "#/lib/onboarding-flow.ts";
import { useOnboardingResume } from "#/lib/onboarding-guard.ts";
import { OnboardingPending } from "./route.tsx";

export const Route = createFileRoute("/onboarding/intro")({
	component: IntroRoute,
	staticData: { onboardingStep: progressSegmentForRoute("intro") },
});

/**
 * The onboarding entry: "Hi, I'm Archer" and the two-path choice. Dispatches the
 * chosen path — résumé upload or the scratch conversation — both of which are
 * still the backend `intro` step until a profile draft exists. The pixel-faithful
 * card treatment is ARC-98; this lands the route + dispatch the router needs.
 */
function IntroRoute() {
	const navigate = useNavigate();
	const { status } = useOnboardingResume("intro");
	if (status !== "ready") return <OnboardingPending />;

	return (
		<div className="mx-auto flex min-h-[70vh] max-w-2xl flex-col items-center justify-center text-center">
			<h1 className="font-heading text-4xl font-bold tracking-tight">
				Hi, I'm Archer.
			</h1>
			<p className="mt-3 text-muted-foreground">
				Takes about 3 minutes · just talk
			</p>

			<div className="mt-10 grid w-full gap-4 sm:grid-cols-2">
				<PathCard
					testid="intro-path-resume"
					title="Upload my résumé"
					blurb="The fast track. I'll read your document and build your profile from it in seconds."
					cta="Word document →"
					onClick={() => navigate({ to: routePath("resume"), replace: true })}
				/>
				<PathCard
					testid="intro-path-conversation"
					title="Start from scratch"
					blurb="No résumé needed. Just talk to me — I'll interview you and build it as we go."
					cta="A quick conversation →"
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
	title: string;
	blurb: string;
	cta: string;
	onClick: () => void;
}

function PathCard({ testid, title, blurb, cta, onClick }: PathCardProps) {
	return (
		<Button
			type="button"
			variant="outline"
			data-testid={testid}
			onClick={onClick}
			className="flex h-auto flex-col items-start gap-2 rounded-xl p-6 text-left whitespace-normal"
		>
			<span className="font-heading text-lg font-semibold">{title}</span>
			<span className="text-sm leading-relaxed text-muted-foreground">
				{blurb}
			</span>
			<span className="mt-2 text-sm font-semibold text-brand">{cta}</span>
		</Button>
	);
}
