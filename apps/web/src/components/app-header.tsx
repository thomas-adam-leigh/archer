import { AppBreadcrumbs } from "#/components/app-breadcrumbs.tsx";
import { navLinks } from "#/components/app-shared.tsx";
import { CustomSidebarTrigger } from "#/components/custom-sidebar-trigger.tsx";
import { DecorIcon } from "#/components/decor-icon.tsx";
import { NavUser } from "#/components/nav-user.tsx";
import { Separator } from "#/components/ui/separator.tsx";
import { cn } from "#/lib/utils.ts";

const activeItem = navLinks.find((item) => item.isActive);

export function AppHeader({
	onSignOut,
	signingOut = false,
}: {
	onSignOut: () => void;
	signingOut?: boolean;
}) {
	return (
		<header
			className={cn(
				"sticky top-0 z-50 flex h-14 shrink-0 items-center justify-between gap-2 border-b px-4 md:px-6",
				"bg-background/95 backdrop-blur-sm supports-backdrop-filter:bg-background/50",
			)}
		>
			<DecorIcon className="hidden md:block" position="bottom-left" />
			<div className="flex items-center gap-3">
				<CustomSidebarTrigger />
				<Separator
					className="mr-2 h-4 data-[orientation=vertical]:self-center"
					orientation="vertical"
				/>
				<AppBreadcrumbs page={activeItem} />
			</div>
			<div className="flex items-center gap-3">
				<NavUser onSignOut={onSignOut} signingOut={signingOut} />
			</div>
		</header>
	);
}
