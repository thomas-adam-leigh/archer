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

/**
 * The calm, retryable error treatment for an in-shell dashboard read (ARC-163).
 *
 * Where {@link ErrorState} fills the viewport for a full-page failure (onboarding,
 * the router boundary), this sits inline inside a dashboard route that already has
 * the app shell around it: a muted `role="alert"` note plus a "Try again" action
 * that re-runs the failed query. So a network failure on any daily-use read is
 * never a dead-end — the same no-dead-ends guarantee the onboarding flow proves.
 */
export function InlineErrorState({
	message = "Couldn't load this just now.",
	onRetry,
	testId,
}: {
	message?: string;
	onRetry?: () => void;
	testId?: string;
}) {
	return (
		<div data-testid={testId} className="flex flex-col items-start gap-2.5">
			<p className="text-[13px] text-[var(--txt3)]" role="alert">
				{message}
			</p>
			{onRetry ? (
				<Button type="button" variant="outline" size="sm" onClick={onRetry}>
					Try again
				</Button>
			) : null}
		</div>
	);
}
