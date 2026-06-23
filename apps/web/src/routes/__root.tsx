import { TanStackDevtools } from "@tanstack/react-devtools";
import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	HeadContent,
	Scripts,
	useRouterState,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { AppShell } from "#/components/app-shell.tsx";
import { useHydrateSession } from "#/lib/session.ts";
import TanStackQueryDevtools from "../integrations/tanstack-query/devtools";
import appCss from "../styles.css?url";

interface MyRouterContext {
	queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
	head: () => ({
		meta: [
			{
				charSet: "utf-8",
			},
			{
				name: "viewport",
				content: "width=device-width, initial-scale=1",
			},
			{
				title: "Archer",
			},
		],
		links: [
			{
				rel: "stylesheet",
				href: appCss,
			},
		],
	}),
	shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
	// Restore any persisted session once on the client so returning users stay
	// signed in across reloads (and route guards know when to act).
	useHydrateSession();

	// The progress indicator is route-driven: each onboarding stage declares its
	// segment via `staticData.onboardingStep`; the deepest match that sets one
	// wins, and routes outside the flow (e.g. /auth) leave it hidden.
	const step = useRouterState({
		select: (state) => {
			for (let i = state.matches.length - 1; i >= 0; i--) {
				const segment = state.matches[i].staticData.onboardingStep;
				if (segment != null) return segment;
			}
			return undefined;
		},
	});

	return (
		<html lang="en">
			<head>
				<HeadContent />
			</head>
			<body>
				<AppShell step={step}>{children}</AppShell>
				<TanStackDevtools
					config={{
						position: "bottom-right",
					}}
					plugins={[
						{
							name: "Tanstack Router",
							render: <TanStackRouterDevtoolsPanel />,
						},
						TanStackQueryDevtools,
					]}
				/>
				<Scripts />
			</body>
		</html>
	);
}
