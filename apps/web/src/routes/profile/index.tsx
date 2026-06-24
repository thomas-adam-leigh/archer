import { createFileRoute } from "@tanstack/react-router";
import { ProfileView } from "#/components/profile-view.tsx";
import { useProfileOverview, useUpdatePreferences } from "#/lib/hooks.ts";

export const Route = createFileRoute("/profile/")({
	component: ProfileRoute,
});

/**
 * The profile route (ARC-152): the candidate's live profile + structured spine
 * (read-only, proposal-gated), their editable work preferences, and the version
 * history. The overview read backs the page; the preferences mutation is the one
 * direct write, invalidating the overview on save.
 */
function ProfileRoute() {
	const overview = useProfileOverview();
	const save = useUpdatePreferences();
	return <ProfileView overview={overview} save={save} />;
}
