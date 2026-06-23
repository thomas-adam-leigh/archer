"use client";

import { Loader2, LogOutIcon } from "lucide-react";
import { Avatar, AvatarFallback } from "#/components/ui/avatar.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";

/**
 * Header account menu. The candidate's profile isn't surfaced to the dashboard
 * yet, so the trigger is a neutral Archer avatar; the one real action is "Log
 * out", wired to the session sign-out passed down from the route.
 */
export function NavUser({
	onSignOut,
	signingOut = false,
}: {
	onSignOut: () => void;
	signingOut?: boolean;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label="Account menu"
				className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
				data-testid="dashboard-account"
			>
				<Avatar className="size-8">
					<AvatarFallback>A</AvatarFallback>
				</Avatar>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-48">
				<DropdownMenuItem
					className="w-full cursor-pointer"
					disabled={signingOut}
					onClick={() => onSignOut()}
					variant="destructive"
				>
					{signingOut ? <Loader2 className="animate-spin" /> : <LogOutIcon />}
					Log out
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
