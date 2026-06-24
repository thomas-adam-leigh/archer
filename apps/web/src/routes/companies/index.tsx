import { createFileRoute } from "@tanstack/react-router";
import { CompaniesList } from "#/components/companies-list.tsx";
import { useCompanies } from "#/lib/hooks.ts";

export const Route = createFileRoute("/companies/")({
	component: CompaniesRoute,
});

/**
 * The companies route (ARC-151): the browsable directory of `enriched` companies,
 * with the live "Archer is researching …" set surfaced separately as an in-action
 * indicator. Both come from one overview read (two status-filtered fetches).
 */
function CompaniesRoute() {
	const companies = useCompanies();
	return <CompaniesList companies={companies} />;
}
