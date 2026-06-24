import { Link } from "@tanstack/react-router";
import { ArrowLeft, Building2, ExternalLink, Mail, User } from "lucide-react";
import type { ReactNode } from "react";
import {
	type CompanyDetail,
	type CompanyStatusBadge,
	companyStatusBadge,
	websiteLabel,
} from "#/lib/companies.ts";

/**
 * The company-detail view (ARC-151) — one company in full: the enrichment Archer
 * materialized (description, links, recruitment email) and its contacts.
 * Presentational: the route owns the query and renders calm loading / error
 * states around this.
 */

/** A read the detail view renders, narrowed from a TanStack Query result. */
interface QueryView<T> {
	data?: T;
	isPending: boolean;
	isError: boolean;
}

const BADGE_TONE: Record<CompanyStatusBadge["tone"], string> = {
	enriched: "border-brand/28 bg-brand/[0.08] text-[var(--accent)]",
	researching: "border-[var(--line)] bg-white/[0.04] text-[var(--txt2)]",
	neutral: "border-[var(--line)] bg-white/[0.04] text-[var(--txt3)]",
};

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

/** A titled card section. */
function Card({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="rounded-[18px] border border-[var(--line-2)] bg-[var(--card-2)] px-[18px] py-4">
			<div className="mb-3 text-[11px] font-bold uppercase tracking-[0.09em] text-[var(--txt3)]">
				{title}
			</div>
			{children}
		</section>
	);
}

/** The "← Back to companies" link shown above every state. */
function BackLink() {
	return (
		<Link
			to="/companies"
			data-testid="company-detail-back"
			className="mb-5 inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--txt2)] transition-colors hover:text-[var(--txt)]"
		>
			<ArrowLeft className="size-[15px]" />
			Back to companies
		</Link>
	);
}

/** An external link rendered as a labelled row. */
function LinkRow({ href, label }: { href: string; label: string }) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			className="inline-flex w-fit items-center gap-1.5 text-[13px] font-semibold text-[var(--accent)] hover:underline"
		>
			{label}
			<ExternalLink className="size-[13px]" />
		</a>
	);
}

/** One contact card (a person on the company's team). */
function ContactRow({
	contact,
}: {
	contact: CompanyDetail["contacts"][number];
}) {
	return (
		<li
			data-testid="company-contact"
			className="flex items-start gap-2.5 rounded-xl border border-[var(--line-2)] bg-[var(--card)] px-3.5 py-3"
		>
			<User className="mt-0.5 size-[15px] shrink-0 text-[var(--txt3)]" />
			<div className="flex min-w-0 flex-col gap-0.5">
				<span className="text-[14px] font-semibold text-[var(--txt)]">
					{contact.full_name}
				</span>
				{contact.role_title ? (
					<span className="text-[13px] text-[var(--txt2)]">
						{contact.role_title}
					</span>
				) : null}
				<div className="mt-1 flex flex-col gap-1">
					{contact.email ? (
						<a
							href={`mailto:${contact.email}`}
							className="inline-flex w-fit items-center gap-1.5 text-[13px] text-[var(--accent)] hover:underline"
						>
							<Mail className="size-[13px]" />
							{contact.email}
						</a>
					) : null}
					{contact.linkedin_url ? (
						<LinkRow href={contact.linkedin_url} label="LinkedIn" />
					) : null}
				</div>
				{contact.notes ? (
					<p className="mt-1 text-[13px] leading-[1.55] text-[var(--txt3)]">
						{contact.notes}
					</p>
				) : null}
			</div>
		</li>
	);
}

function DetailBody({ company }: { company: CompanyDetail }) {
	const badge = companyStatusBadge(company.status);
	const host = websiteLabel(company.website_url);
	const hasLinks = Boolean(
		company.website_url || company.linkedin_url || company.recruitment_email,
	);
	return (
		<div data-testid="company-detail" className="flex flex-col gap-3.5">
			{/* Heading: name + status pill + website host */}
			<header>
				<h1 className="flex items-center gap-2 font-heading text-[clamp(22px,2.8vw,32px)] font-bold leading-[1.15] tracking-[-0.02em]">
					<Building2 className="size-[26px] shrink-0 text-[var(--txt3)]" />
					{company.name}
				</h1>
				<div className="mt-3 flex flex-wrap items-center gap-1.5">
					<Pill className={BADGE_TONE[badge.tone]}>{badge.label}</Pill>
					{host ? (
						<Pill className="border-[var(--line)] bg-white/[0.04] text-[var(--txt3)]">
							{host}
						</Pill>
					) : null}
				</div>
			</header>

			{/* What Archer learned */}
			{company.description ? (
				<Card title="About">
					<p className="whitespace-pre-line text-[14px] leading-[1.6] text-[var(--txt2)]">
						{company.description}
					</p>
				</Card>
			) : null}

			{/* Links + recruitment contact */}
			{hasLinks ? (
				<Card title="Links">
					<div className="flex flex-col gap-2">
						{company.website_url ? (
							<LinkRow
								href={company.website_url}
								label={host ?? company.website_url}
							/>
						) : null}
						{company.linkedin_url ? (
							<LinkRow href={company.linkedin_url} label="LinkedIn" />
						) : null}
						{company.recruitment_email ? (
							<a
								href={`mailto:${company.recruitment_email}`}
								className="inline-flex w-fit items-center gap-1.5 text-[13px] font-semibold text-[var(--accent)] hover:underline"
							>
								<Mail className="size-[13px]" />
								{company.recruitment_email}
							</a>
						) : null}
					</div>
				</Card>
			) : null}

			{/* The people Archer found */}
			<Card title="Contacts">
				{company.contacts.length > 0 ? (
					<ul
						data-testid="company-detail-contacts"
						className="flex flex-col gap-2"
					>
						{company.contacts.map((contact) => (
							<ContactRow key={contact.id} contact={contact} />
						))}
					</ul>
				) : (
					<p
						data-testid="company-detail-contacts-empty"
						className="text-[13px] text-[var(--txt3)]"
					>
						No contacts found yet for this company.
					</p>
				)}
			</Card>
		</div>
	);
}

export function CompanyDetailView({
	detail,
}: {
	detail: QueryView<CompanyDetail>;
}) {
	return (
		<div className="a-fadeup mx-auto max-w-[680px]">
			<BackLink />
			{detail.isPending ? (
				<p className="text-[13px] text-[var(--txt3)]">Loading this company…</p>
			) : detail.isError || !detail.data ? (
				<p
					data-testid="company-detail-error"
					className="text-[13px] text-[var(--txt3)]"
				>
					Couldn't load this company — it may have moved on, or something went
					wrong reaching Archer.
				</p>
			) : (
				<DetailBody company={detail.data} />
			)}
		</div>
	);
}
