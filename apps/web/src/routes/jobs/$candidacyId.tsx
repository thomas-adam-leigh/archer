import { createFileRoute } from "@tanstack/react-router";
import { JobDetailView } from "#/components/job-detail.tsx";
import { useBoards, useJobDetail } from "#/lib/hooks.ts";

export const Route = createFileRoute("/jobs/$candidacyId")({
	component: JobDetailRoute,
});

/**
 * The job-detail route (ARC-149): one candidacy in full. Boards are read alongside
 * so the posting's `board_slug` resolves to its display name (the read is
 * shared/deduped with the home dashboard + jobs feed).
 */
function JobDetailRoute() {
	const { candidacyId } = Route.useParams();
	const detail = useJobDetail(candidacyId);
	const boards = useBoards();
	const boardName = (slug: string): string =>
		boards.data?.find((b) => b.slug === slug)?.name ?? slug;
	return <JobDetailView detail={detail} boardName={boardName} />;
}
