import { Button } from "#/components/ui/button.tsx";

/**
 * The shared, retryable "something went wrong" surface for failed async reads.
 *
 * Used wherever a network read can dead-end the flow — the resume-at-step
 * progress fetch (see `onboarding-guard.ts`), a route's own data load, and the
 * router's default error boundary — so every failure offers a friendly message
 * and a way forward instead of a blank or stuck screen. Mirrors the inline
 * pattern already used in `TargetTitles`: a `role="alert"` message plus an
 * optional "Try again" action.
 */
export function ErrorState({
	title = "Something went wrong.",
	message = "We couldn't reach Archer just now. Please try again.",
	onRetry,
	testId,
}: {
	title?: string;
	message?: string;
	onRetry?: () => void;
	testId?: string;
}) {
	return (
		<div
			data-testid={testId}
			className="mx-auto flex min-h-[70vh] max-w-xl flex-col items-center justify-center gap-3 text-center"
		>
			<h1 className="font-heading text-2xl font-bold tracking-tight">
				{title}
			</h1>
			<p className="max-w-sm text-sm text-[var(--txt2)]" role="alert">
				{message}
			</p>
			{onRetry ? (
				<Button
					type="button"
					variant="outline"
					className="mt-1"
					onClick={onRetry}
				>
					Try again
				</Button>
			) : null}
		</div>
	);
}
