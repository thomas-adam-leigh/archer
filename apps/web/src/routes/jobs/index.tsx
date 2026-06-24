import { createFileRoute } from "@tanstack/react-router";
import { JobsList } from "#/components/jobs-list.tsx";
import { useBoards, useJobs } from "#/lib/hooks.ts";

export const Route = createFileRoute("/jobs/")({
	component: JobsRoute,
});

/**
 * The jobs route (ARC-149): the curated feed of `shortlisted` +
 * `alternative_outreach` candidacies. Boards are read alongside so a job's
 * `board_slug` resolves to its display name (the read is shared/deduped with the
 * home dashboard's boards panel).
 */
function JobsRoute() {
	const jobs = useJobs();
	const boards = useBoards();
	const boardName = (slug: string): string =>
		boards.data?.find((b) => b.slug === slug)?.name ?? slug;
	return <JobsList jobs={jobs} boardName={boardName} />;
}
