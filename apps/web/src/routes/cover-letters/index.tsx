import { createFileRoute } from "@tanstack/react-router";
import { CoverLettersList } from "#/components/cover-letters-list.tsx";
import { useBoards, useCoverLetters } from "#/lib/hooks.ts";

export const Route = createFileRoute("/cover-letters/")({
	component: CoverLettersRoute,
});

/**
 * The cover-letters route (ARC-150): the candidacies whose letter is the
 * candidate's to act on — in-review (needs you), drafting, and approved. Boards are
 * read alongside so a candidacy's `board_slug` resolves to its display name (the
 * read is shared/deduped with the home dashboard + jobs feed).
 */
function CoverLettersRoute() {
	const items = useCoverLetters();
	const boards = useBoards();
	const boardName = (slug: string): string =>
		boards.data?.find((b) => b.slug === slug)?.name ?? slug;
	return <CoverLettersList items={items} boardName={boardName} />;
}
