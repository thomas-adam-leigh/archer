"use client";

import { navGroups } from "#/components/app-shared.tsx";
import { LogoMark } from "#/components/logo.tsx";
import { NavGroup } from "#/components/nav-group.tsx";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarHeader,
	SidebarMenuButton,
} from "#/components/ui/sidebar.tsx";
import { cn } from "#/lib/utils.ts";

export function AppSidebar() {
	return (
		<Sidebar
			className={cn(
				"*:data-[slot=sidebar-inner]:bg-background",
				"**:data-[slot=sidebar-menu-button]:[&>span]:text-foreground/75",
			)}
			collapsible="icon"
			variant="sidebar"
		>
			<SidebarHeader className="h-14 justify-center border-b px-2">
				<SidebarMenuButton asChild>
					<a href="/onboarding/home">
						<LogoMark />
						<span className="font-heading font-bold text-foreground!">
							Archer
						</span>
					</a>
				</SidebarMenuButton>
			</SidebarHeader>
			<SidebarContent>
				{navGroups.map((group) => (
					<NavGroup key={group.label ?? group.items[0]?.title} {...group} />
				))}
			</SidebarContent>
			<SidebarFooter className="gap-0 p-0">
				<div className="px-4 pt-4 pb-2 transition-opacity group-data-[collapsible=icon]:pointer-events-none group-data-[collapsible=icon]:opacity-0">
					<p className="text-nowrap text-[9px] text-muted-foreground">
						© {new Date().getFullYear()} Archer
					</p>
				</div>
			</SidebarFooter>
		</Sidebar>
	);
}
