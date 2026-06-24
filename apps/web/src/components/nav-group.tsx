import { Link, useLocation } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import type { SidebarNavGroup } from "#/components/app-shared.tsx";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "#/components/ui/collapsible.tsx";
import {
	SidebarGroup,
	SidebarGroupLabel,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarMenuSub,
	SidebarMenuSubButton,
	SidebarMenuSubItem,
} from "#/components/ui/sidebar.tsx";

/** Whether `path` is the current route (exact, or a parent of a nested route). */
function isPathActive(pathname: string, path?: string): boolean {
	if (!path) return false;
	return pathname === path || pathname.startsWith(`${path}/`);
}

export function NavGroup({ label, items }: SidebarNavGroup) {
	// The active item is derived from the current route rather than a static flag,
	// so the highlight follows navigation (e.g. /jobs/:id keeps "Jobs" active).
	const { pathname } = useLocation();
	return (
		<SidebarGroup>
			{label && <SidebarGroupLabel>{label}</SidebarGroupLabel>}
			<SidebarMenu>
				{items.map((item) => {
					const active = isPathActive(pathname, item.path);
					const subActive = item.subItems?.some((i) =>
						isPathActive(pathname, i.path),
					);
					return (
						<Collapsible
							asChild
							className="group/collapsible"
							defaultOpen={active || subActive}
							key={item.title}
						>
							<SidebarMenuItem>
								{item.subItems?.length ? (
									<>
										<CollapsibleTrigger asChild>
											<SidebarMenuButton isActive={active}>
												{item.icon}
												<span>{item.title}</span>
												<ChevronRightIcon className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
											</SidebarMenuButton>
										</CollapsibleTrigger>
										<CollapsibleContent>
											<SidebarMenuSub>
												{item.subItems?.map((subItem) => (
													<SidebarMenuSubItem key={subItem.title}>
														<SidebarMenuSubButton
															asChild
															isActive={isPathActive(pathname, subItem.path)}
														>
															<Link to={subItem.path}>
																{subItem.icon}
																<span>{subItem.title}</span>
															</Link>
														</SidebarMenuSubButton>
													</SidebarMenuSubItem>
												))}
											</SidebarMenuSub>
										</CollapsibleContent>
									</>
								) : (
									<SidebarMenuButton asChild isActive={active}>
										<Link to={item.path}>
											{item.icon}
											<span>{item.title}</span>
										</Link>
									</SidebarMenuButton>
								)}
							</SidebarMenuItem>
						</Collapsible>
					);
				})}
			</SidebarMenu>
		</SidebarGroup>
	);
}
