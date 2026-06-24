import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { ErrorState } from "./components/ui/error-state";
import { getContext } from "./integrations/tanstack-query/root-provider";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
	const context = getContext();

	const router = createTanStackRouter({
		routeTree,
		context,
		scrollRestoration: true,
		defaultPreload: "intent",
		// Preload-on-intent (hovering a sidebar `<Link>`) is only useful if the
		// warmed data is treated as fresh on the subsequent click — `0` made it
		// stale immediately, forcing a refetch. Match the query `staleTime` (see
		// the QueryClient defaults) so a hover actually primes the next view.
		defaultPreloadStaleTime: 30_000,
		// A last-resort boundary so an unexpected render/load error shows a
		// friendly, retryable surface instead of a blank screen.
		defaultErrorComponent: ({ reset }) => (
			<ErrorState
				testId="route-error"
				message="We hit an unexpected error. Please try again."
				onRetry={reset}
			/>
		),
	});

	setupRouterSsrQueryIntegration({ router, queryClient: context.queryClient });

	return router;
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}

	/** Per-route onboarding metadata read by the app shell's progress indicator. */
	interface StaticDataRouteOption {
		/** The 1-based progress segment this route lights, or omitted to hide it. */
		onboardingStep?: number;
		/**
		 * Set on the post-onboarding dashboard route so the root skips the
		 * onboarding chrome — the dashboard supplies its own (the `DashboardShell`
		 * built on the @efferd/app-shell-2 block).
		 */
		dashboard?: boolean;
	}
}
