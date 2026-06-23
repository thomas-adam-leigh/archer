import { Github, Globe, Linkedin, Mail, MapPin, Phone } from "lucide-react";
import type { ProfileReviewView, ReviewLink } from "#/lib/profile-review.ts";

/**
 * The "Here's you, as I understand you" résumé-style render (ARC-107) — the
 * convergence point of both onboarding paths. Given a flat view model
 * ({@link ProfileReviewView}, mapped from the proposed profile draft) it lays out
 * the header (avatar, name, headline, contact, links), then Summary, Experience,
 * Education + Courses & Certifications, and Skills, hiding any empty section per
 * the design's `hasExperience` / `hasEducation` / `hasCerts` / `hasSkills`
 * bindings. Feedback + approve (the action dock) land in ARC-108.
 */
export function ProfileReview({ view }: { view: ProfileReviewView }) {
	const hasContact = Boolean(view.location || view.email || view.phone);

	return (
		<div className="mx-auto max-w-[880px] pt-[2vh]">
			<header className="a-fadeup mb-[26px] text-center">
				<div className="mb-3.5 inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--card-2)] px-3.5 py-1.5 text-xs font-semibold text-[var(--txt2)]">
					<span className="size-1.5 rounded-full bg-[var(--accent)]" />
					{view.versionNo ? `Draft v${view.versionNo} · ` : ""}for your approval
				</div>
				<h2 className="mb-2 font-heading text-[clamp(24px,3vw,34px)] font-bold tracking-[-0.02em]">
					Here's you, as I understand you.
				</h2>
				<p className="m-0 text-[15px] text-[var(--txt2)]">
					Take a look. If anything's off or missing, just tell me out loud.
				</p>
			</header>

			<article
				data-testid="profile-review-card"
				className="a-pop overflow-hidden rounded-[24px] border border-[var(--line)] bg-[var(--card)]"
			>
				{/* header */}
				<div className="border-b border-[var(--line-2)] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--accent)_7%,transparent),transparent)] px-[34px] pt-8 pb-[26px]">
					<div className="flex flex-wrap items-center gap-5">
						<div className="flex size-[74px] flex-none items-center justify-center rounded-[20px] bg-[linear-gradient(140deg,var(--accent-2),var(--accent))] font-heading text-[28px] font-bold text-[#160a02] shadow-[0_10px_28px_var(--glow)]">
							{view.initials}
						</div>
						<div className="min-w-[200px] flex-1">
							<h3
								data-testid="profile-name"
								className="mb-1 font-heading text-[27px] font-bold tracking-[-0.02em]"
							>
								{view.name}
							</h3>
							{view.title ? (
								<div className="mb-2 text-base font-semibold text-[var(--accent-2)]">
									{view.title}
								</div>
							) : null}
							{hasContact ? (
								<div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[13px] text-[var(--txt2)]">
									{view.location ? (
										<span className="inline-flex items-center gap-1.5">
											<MapPin className="size-3.5 text-[var(--accent)]" />
											{view.location}
										</span>
									) : null}
									{view.email ? (
										<span className="inline-flex items-center gap-1.5">
											<Mail className="size-3.5 text-[var(--accent)]" />
											{view.email}
										</span>
									) : null}
									{view.phone ? (
										<span className="inline-flex items-center gap-1.5">
											<Phone className="size-3.5 text-[var(--accent)]" />
											{view.phone}
										</span>
									) : null}
								</div>
							) : null}
						</div>
					</div>
					{view.links.length > 0 ? (
						<div className="mt-4 flex flex-wrap gap-2.5">
							{view.links.map((link) => (
								<LinkChip key={link.kind} link={link} />
							))}
						</div>
					) : null}
				</div>

				{/* body */}
				<div className="flex flex-col gap-[26px] px-[34px] pt-7 pb-[34px]">
					{view.summary ? (
						<Section title="Summary">
							<p
								data-testid="profile-summary"
								className="m-0 text-[15px] leading-[1.65] text-[var(--txt)]"
							>
								{view.summary}
							</p>
						</Section>
					) : null}

					{view.experience.length > 0 ? (
						<Section title="Experience">
							<div
								data-testid="profile-experience"
								className="flex flex-col gap-5"
							>
								{view.experience.map((x) => (
									<div
										key={`${x.role}-${x.company ?? ""}-${x.period ?? ""}`}
										className="flex gap-[15px]"
									>
										<div className="flex flex-none flex-col items-center pt-1">
											<div className="size-2.5 rounded-full bg-[var(--accent)] shadow-[0_0_8px_var(--glow)]" />
											<div className="mt-1.5 w-px flex-1 bg-[var(--line)]" />
										</div>
										<div className="flex-1">
											<div className="flex flex-wrap items-baseline justify-between gap-3">
												<div className="font-heading text-base font-semibold">
													{x.role}
												</div>
												{x.period ? (
													<div className="whitespace-nowrap text-[13px] text-[var(--txt3)]">
														{x.period}
													</div>
												) : null}
											</div>
											{x.company ? (
												<div className="mt-0.5 mb-2 text-sm font-medium text-[var(--accent-2)]">
													{x.company}
												</div>
											) : null}
											{x.bullets.map((bullet) => (
												<div
													key={bullet}
													className="mb-1.5 flex gap-2.5 text-sm leading-[1.55] text-[var(--txt2)]"
												>
													<span className="flex-none text-[var(--accent)]">
														·
													</span>
													{bullet}
												</div>
											))}
										</div>
									</div>
								))}
							</div>
						</Section>
					) : null}

					{view.education.length > 0 || view.certifications.length > 0 ? (
						<div className="grid gap-[26px] sm:grid-cols-2">
							{view.education.length > 0 ? (
								<Section title="Education">
									<div data-testid="profile-education">
										{view.education.map((e) => (
											<div
												key={`${e.school}-${e.degree ?? ""}`}
												className="mb-3.5"
											>
												{e.degree ? (
													<div className="text-[15px] font-semibold">
														{e.degree}
													</div>
												) : null}
												<div className="mt-0.5 text-[13px] text-[var(--txt2)]">
													{e.school}
												</div>
												{e.period ? (
													<div className="mt-px text-xs text-[var(--txt3)]">
														{e.period}
													</div>
												) : null}
											</div>
										))}
									</div>
								</Section>
							) : null}
							{view.certifications.length > 0 ? (
								<Section title="Courses & Certifications">
									<div data-testid="profile-certifications">
										{view.certifications.map((cert) => (
											<div
												key={cert}
												className="mb-2 flex gap-2.5 text-sm leading-[1.5] text-[var(--txt)]"
											>
												<span className="flex-none text-[var(--accent)]">
													✦
												</span>
												{cert}
											</div>
										))}
									</div>
								</Section>
							) : null}
						</div>
					) : null}

					{view.skills.length > 0 ? (
						<Section title="Skills">
							<div
								data-testid="profile-skills"
								className="flex flex-wrap gap-2"
							>
								{view.skills.map((skill) => (
									<span
										key={skill}
										className="rounded-full border border-[var(--line)] bg-[var(--card-2)] px-3.5 py-1.5 text-[13px] font-medium text-[var(--txt)]"
									>
										{skill}
									</span>
								))}
							</div>
						</Section>
					) : null}
				</div>
			</article>
		</div>
	);
}

/** A labelled review section (uppercase eyebrow + body). */
function Section({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<section>
			<div className="mb-3 text-xs font-bold uppercase tracking-[0.09em] text-[var(--txt3)]">
				{title}
			</div>
			{children}
		</section>
	);
}

const LINK_ICON = {
	linkedin: Linkedin,
	github: Github,
	website: Globe,
} as const;

/** A single external-link chip (icon + stripped label), linking out in a new tab. */
function LinkChip({ link }: { link: ReviewLink }) {
	const Icon = LINK_ICON[link.kind];
	return (
		<a
			href={link.href}
			target="_blank"
			rel="noopener noreferrer"
			className="inline-flex items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--card-2)] px-3.5 py-1.5 text-[13px] font-medium text-[var(--txt)] transition-colors hover:border-brand/45"
		>
			<Icon className="size-3.5 text-[var(--accent)]" />
			{link.label}
		</a>
	);
}
