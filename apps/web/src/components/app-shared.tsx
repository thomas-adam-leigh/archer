import {
	BriefcaseIcon,
	Building2Icon,
	FileTextIcon,
	LayoutGridIcon,
} from "lucide-react";
import type { ReactNode } from "react";

export type SidebarNavItem = {
	title: string;
	path?: string;
	icon?: ReactNode;
	isActive?: boolean;
	subItems?: SidebarNavItem[];
};

export type SidebarNavGroup = {
	label?: string;
	items: SidebarNavItem[];
};

/**
 * The post-onboarding shell's sidebar. The active item is derived from the
 * current route (see {@link NavGroup}), so entries carry no static `isActive`.
 */
export const navGroups: SidebarNavGroup[] = [
	{
		items: [
			{
				title: "Dashboard",
				path: "/onboarding/home",
				icon: <LayoutGridIcon />,
			},
			{
				title: "Jobs",
				path: "/jobs",
				icon: <BriefcaseIcon />,
			},
			{
				title: "Cover letters",
				path: "/cover-letters",
				icon: <FileTextIcon />,
			},
			{
				title: "Companies",
				path: "/companies",
				icon: <Building2Icon />,
			},
		],
	},
];

export const footerNavLinks: SidebarNavItem[] = [];

export const navLinks: SidebarNavItem[] = [
	...navGroups.flatMap((group) =>
		group.items.flatMap((item) =>
			item.subItems?.length ? [item, ...item.subItems] : [item],
		),
	),
	...footerNavLinks,
];
