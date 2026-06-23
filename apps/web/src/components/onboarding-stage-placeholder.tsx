/**
 * A neutral placeholder for an onboarding stage whose screen hasn't been built
 * yet. ARC-99 lands the route + resume/guard wiring for every stage; each later
 * milestone replaces its placeholder with the real screen. The `data-testid`
 * lets the resume/guard E2E (ARC-100) assert which stage it landed on before the
 * stage's own UI exists.
 */
export function OnboardingStagePlaceholder({
	stage,
	title,
	issue,
}: {
	stage: string;
	title: string;
	issue: string;
}) {
	return (
		<div
			data-testid={`onboarding-stage-${stage}`}
			className="mx-auto flex min-h-[70vh] max-w-xl flex-col items-center justify-center text-center"
		>
			<h1 className="font-heading text-3xl font-bold tracking-tight">
				{title}
			</h1>
			<p className="mt-3 text-sm text-muted-foreground">
				This stage's screen arrives in {issue}.
			</p>
		</div>
	);
}
