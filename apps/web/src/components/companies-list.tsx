import { Link } from "@tanstack/react-router";
import { Building2, ChevronRight, Radar } from "lucide-react";
import { InlineErrorState } from "#/components/ui/error-state.tsx";
import {
	type CompanyListItem,
	type CompanyStatusBadge,
	companyStatusBadge,
	websiteLabel,
} from "#/lib/companies.ts";

/**
 * The companies route's directory (ARC-151) — the companies Archer has finished
 * researching (`enriched`), each linking to its detail, with the companies it's
 * researching right now surfaced above as a calm in-action indicator. The empty
 * state is the launch default: at first nothing has been researched yet.
 * Presentational: the route owns the query; this renders calm loading / empty /
 * error states.
 */

/** A read the list renders, narrowed from a TanStack Query result. */
interface QueryView<T> {
	data?: T;
	isPending: boolean;
	isError: boolean;
	refetch?: () => void;
}

/** The overview shape the list renders. */
interface CompaniesOverviewView {
	enriched: CompanyListItem[];
	researching: CompanyListItem[];
}

/** A muted single-line note used for loading / error states. */
function Note({ children }: { children: string }) {
	return <p className="text-[13px] text-[var(--txt3)]">{children}</p>;
}

/** The tints a status badge maps its tone to. */
const BADGE_TONE: Record<CompanyStatusBadge["tone"], string> = {
	enriched: "border-brand/28 bg-brand/[0.08] text-[var(--accent)]",
	researching: "border-[var(--line)] bg-white/[0.04] text-[var(--txt2)]",
	neutral: "border-[var(--line)] bg-white/[0.04] text-[var(--txt3)]",
};

/** A small coloured pill (status badge, website host). */
function Pill({
	children,
	className = "",
}: {
	children: string;
	className?: string;
}) {
	return (
		<span
			className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${className}`}
		>
			{children}
		</span>
	);
}

/** One company card in the directory, linking through to its detail. */
function CompanyCard({ company }: { company: CompanyListItem }) {
	const badge = companyStatusBadge(company.status);
	const host = websiteLabel(company.website_url);
	return (
		<li data-testid="companies-item">
			<Link
				to="/companies/$companyId"
				params={{ companyId: company.id }}
				className="flex items-center gap-3 rounded-xl border border-[var(--line-2)] bg-[var(--card)] px-4 py-3.5 transition-colors hover:border-brand/45 hover:bg-white/[0.03]"
			>
				<div className="flex min-w-0 flex-1 flex-col gap-1.5">
					<span className="flex items-center gap-1.5 truncate text-[15px] font-semibold text-[var(--txt)]">
						<Building2 className="size-[15px] shrink-0 text-[var(--txt3)]" />
						{company.name}
					</span>
					{company.description ? (
						<span className="line-clamp-1 text-[13px] text-[var(--txt2)]">
							{company.description}
						</span>
					) : null}
					<div className="mt-0.5 flex flex-wrap items-center gap-1.5">
						<Pill className={BADGE_TONE[badge.tone]}>{badge.label}</Pill>
						{host ? (
							<Pill className="border-[var(--line)] bg-white/[0.04] text-[var(--txt3)]">
								{host}
							</Pill>
						) : null}
					</div>
				</div>
				<ChevronRight className="size-[18px] shrink-0 text-[var(--txt3)]" />
			</Link>
		</li>
	);
}

/** The live "Archer is researching …" indicator, shown when any company is in
 *  the `researching` state — separate from the enriched directory below. */
function ResearchingIndicator({ companies }: { companies: CompanyListItem[] }) {
	const names = companies.map((c) => c.name).join(", ");
	return (
		<div
			data-testid="companies-researching"
			className="mb-5 flex items-start gap-2.5 rounded-[14px] border border-brand/25 bg-brand/[0.06] px-4 py-3"
		>
			<Radar className="mt-0.5 size-[16px] shrink-0 animate-pulse text-[var(--accent)]" />
			<p className="text-[13px] text-[var(--txt2)]">
				<span className="font-semibold text-[var(--txt)]">
					Archer is researching
				</span>{" "}
				{names} — their details will appear here once it's done.
			</p>
		</div>
	);
}

export function CompaniesList({
	companies,
}: {
	companies: QueryView<CompaniesOverviewView>;
}) {
	const enriched = companies.data?.enriched ?? [];
	const researching = companies.data?.researching ?? [];
	return (
		<div data-testid="companies-page" className="a-fadeup">
			<header className="mb-6">
				<h1 className="font-heading text-[clamp(22px,2.6vw,30px)] font-bold tracking-[-0.02em]">
					Companies
				</h1>
				<p className="mt-1.5 text-[14px] text-[var(--txt2)]">
					The companies Archer has researched behind your shortlisted roles.
				</p>
			</header>

			{companies.isPending ? (
				<Note>Loading companies…</Note>
			) : companies.isError ? (
				<InlineErrorState
					testId="companies-error"
					message="Couldn't load your companies just now."
					onRetry={() => companies.refetch?.()}
				/>
			) : (
				<>
					{researching.length > 0 ? (
						<ResearchingIndicator companies={researching} />
					) : null}

					{enriched.length === 0 ? (
						<div
							data-testid="companies-empty"
							className="flex flex-col items-center gap-3 rounded-[18px] border border-[var(--line-2)] bg-[var(--card-2)] px-6 py-12 text-center"
						>
							<Building2 className="size-7 text-[var(--txt3)]" />
							<p className="text-[15px] font-semibold text-[var(--txt)]">
								No researched companies yet
							</p>
							<p className="max-w-[400px] text-[13px] text-[var(--txt3)]">
								Archer researches a company once it shortlists a job there.
								They'll show up here as it learns about them.
							</p>
						</div>
					) : (
						<ul
							data-testid="companies-directory"
							className="flex flex-col gap-2.5"
						>
							{enriched.map((company) => (
								<CompanyCard key={company.id} company={company} />
							))}
						</ul>
					)}
				</>
			)}
		</div>
	);
}
