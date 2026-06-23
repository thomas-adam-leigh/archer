import type { ReactNode } from "react";
import { AppHeader } from "#/components/app-header.tsx";
import { AppSidebar } from "#/components/app-sidebar.tsx";
import { SidebarInset, SidebarProvider } from "#/components/ui/sidebar.tsx";
import { TooltipProvider } from "#/components/ui/tooltip.tsx";
import { cn } from "#/lib/utils.ts";

/**
 * Post-onboarding dashboard chrome — the `@efferd/app-shell-2` block (sidebar +
 * top bar) adapted to Archer's branding and palette. Only the authenticated
 * home (ARC-113) renders inside it; onboarding and auth keep their standalone
 * centered layout, so this shell mounts at the dashboard route, never the root.
 * `onSignOut` wires the header user menu's "Log out" to the real session
 * sign-out (the same action as the dashboard's "Start over").
 */
export function DashboardShell({
	children,
	onSignOut,
	signingOut = false,
}: {
	children: ReactNode;
	onSignOut: () => void;
	signingOut?: boolean;
}) {
	return (
		<TooltipProvider>
			<SidebarProvider className={cn("[--app-wrapper-max-width:80rem]")}>
				<AppSidebar />
				{/* Transparent so the app's signature radial background shows through
				    the content (matching every other route) instead of a flat panel. */}
				<SidebarInset className="bg-transparent">
					<AppHeader onSignOut={onSignOut} signingOut={signingOut} />
					<div
						className={cn(
							"flex flex-1 flex-col p-4 md:p-6",
							"mx-auto w-full max-w-(--app-wrapper-max-width)",
						)}
					>
						{children}
					</div>
				</SidebarInset>
			</SidebarProvider>
		</TooltipProvider>
	);
}
