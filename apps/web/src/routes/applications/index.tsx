import { createFileRoute } from "@tanstack/react-router";
import { ApplicationsList } from "#/components/applications-list.tsx";
import { useApplications, useBoards } from "#/lib/hooks.ts";

export const Route = createFileRoute("/applications/")({
	component: ApplicationsRoute,
});

/**
 * The applications route (ARC-166): the candidacies in the apply lifecycle — what
 * Archer has applied for, what it sent, and where each stands. Boards are read
 * alongside so a candidacy's `board_slug` resolves to its display name (the read is
 * shared/deduped with the home dashboard + jobs + cover-letters feeds).
 */
function ApplicationsRoute() {
	const items = useApplications();
	const boards = useBoards();
	const boardName = (slug: string): string =>
		boards.data?.find((b) => b.slug === slug)?.name ?? slug;
	return <ApplicationsList items={items} boardName={boardName} />;
}
