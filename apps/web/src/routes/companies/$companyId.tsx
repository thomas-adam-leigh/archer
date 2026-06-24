import { createFileRoute } from "@tanstack/react-router";
import { CompanyDetailView } from "#/components/company-detail.tsx";
import { useCompanyDetail } from "#/lib/hooks.ts";

export const Route = createFileRoute("/companies/$companyId")({
	component: CompanyDetailRoute,
});

/**
 * The company-detail route (ARC-151): one company in full — the enrichment Archer
 * materialized (description, links, recruitment email) plus its contacts.
 */
function CompanyDetailRoute() {
	const { companyId } = Route.useParams();
	const detail = useCompanyDetail(companyId);
	return <CompanyDetailView detail={detail} />;
}
