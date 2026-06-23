import {
	Ban,
	Clock,
	Crosshair,
	FileText,
	Loader2,
	Search,
	Send,
} from "lucide-react";
import { ArcherOrb } from "#/components/archer-orb.tsx";
import type { NextRun } from "#/lib/next-run.ts";
import type { NegativeCriterion } from "#/lib/preferences.ts";

/**
 * The post-onboarding home — where the candidate is "directed out of onboarding"
 * (M8: ARC-113). A resting dashboard ported from the design spec's done/home
 * stage: Archer's next scheduled run, a "where I'll look" summary of the
 * onboarding outputs (target titles + rule-outs) over the boards it sweeps, a
 * recent-activity feed, and "Start over". Presentational — the route owns the
 * queries and the start-over action.
 *
 * Live data fills the hunt summary (the candidate's approved titles and captured
 * rule-outs); the scan sources and the activity feed are placeholders until the
 * backend exposes per-account board config and a real activity stream.
 */

/** The boards Archer sweeps each run (the design spec's fixed source list). */
const SCAN_SOURCES = [
	"Career Junction",
	"CareerJet",
	"PNet",
	"LinkedIn Jobs",
	"Indeed",
] as const;

/**
 * Placeholder recent-activity items. Archer doesn't expose a live activity API to
 * onboarding yet, so these mirror the design spec's examples until real run
 * history is wired (see the ARC-113 note on the missing endpoint).
 */
const PLACEHOLDER_ACTIVITY = [
	{ icon: Search, label: "Scanned 214 roles" },
	{ icon: FileText, label: "Cover letter drafted" },
	{ icon: Send, label: "Applied — Stripe" },
] as const;

/** Shared card chrome for the dashboard sections. */
function Eyebrow({ children }: { children: string }) {
	return (
		<div className="mb-3 text-[11px] font-bold uppercase tracking-[0.09em] text-[var(--txt3)]">
			{children}
		</div>
	);
}

export function HomeDashboard({
	nextRun,
	titles,
	ruleOuts,
	onStartOver,
	startingOver = false,
}: {
	nextRun: NextRun;
	titles: string[];
	ruleOuts: NegativeCriterion[];
	onStartOver: () => void;
	startingOver?: boolean;
}) {
	return (
		<div
			data-testid="onboarding-stage-home"
			className="a-fadeup mx-auto max-w-[600px] pt-[6vh] text-center"
		>
			<ArcherOrb size={92} className="mx-auto mb-6" />

			<div className="mb-5 inline-flex items-center gap-2.5 rounded-full border border-[var(--line)] bg-[var(--card-2)] px-[15px] py-[7px] text-[13px] font-semibold text-[var(--txt2)]">
				<span className="a-glowpulse size-2 rounded-full bg-[#7d8aa0] shadow-[0_0_8px_#7d8aa0]" />
				Scheduled · resting
			</div>

			<h2 className="mb-4 font-heading text-[clamp(26px,3.4vw,38px)] font-bold leading-[1.1] tracking-[-0.02em]">
				You're all set. Archer takes it from here.
			</h2>
			<p className="mx-auto mb-9 max-w-[460px] text-[clamp(15px,1.6vw,18px)] leading-[1.6] text-[var(--txt2)]">
				From here on the work happens in the background. Archer wakes on weekday
				mornings, sweeps the boards for roles that fit, and only brings you the
				ones worth your time.
			</p>

			<div className="mx-auto flex max-w-[460px] flex-col gap-3.5 text-left">
				{/* Next run */}
				<section
					data-testid="home-next-run"
					className="flex items-center gap-[15px] rounded-[18px] border border-[var(--line)] bg-[var(--card)] px-5 py-[18px]"
				>
					<div className="flex size-[46px] shrink-0 items-center justify-center rounded-[13px] border border-brand/28 bg-brand/12 text-[var(--accent)]">
						<Clock className="size-[22px]" />
					</div>
					<div className="flex-1">
						<div className="mb-[3px] text-[11px] font-bold uppercase tracking-[0.09em] text-[var(--txt3)]">
							Next run
						</div>
						<div
							data-testid="home-next-run-time"
							className="font-heading text-[19px] font-semibold text-[var(--txt)]"
						>
							{nextRun.label} · {nextRun.time}
						</div>
						<div className="mt-[3px] text-[13px] text-[var(--txt2)]">
							Archer runs every weekday at 08:00 and 13:00, then rests.
						</div>
					</div>
				</section>

				{/* Where I'll look — the live onboarding outputs */}
				<section
					data-testid="home-where-i-look"
					className="rounded-[18px] border border-[var(--line-2)] bg-[var(--card-2)] px-[18px] py-4"
				>
					<Eyebrow>Where I'll look</Eyebrow>

					<div className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold text-[var(--txt2)]">
						<Crosshair className="size-[15px] text-[var(--accent)]" />
						Hunting for
					</div>
					{titles.length > 0 ? (
						<ul
							data-testid="home-target-titles"
							className="mb-4 flex flex-wrap gap-2"
						>
							{titles.map((title) => (
								<li
									key={title}
									className="rounded-full border border-[var(--line)] bg-[var(--card)] px-3 py-1.5 text-[13px] font-semibold"
								>
									{title}
								</li>
							))}
						</ul>
					) : (
						<p className="mb-4 text-[13px] text-[var(--txt3)]">
							Your target roles will appear here.
						</p>
					)}

					<div className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold text-[var(--txt2)]">
						<Ban className="size-[15px] text-[var(--txt3)]" />
						Ruling out
					</div>
					{ruleOuts.length > 0 ? (
						<ul data-testid="home-rule-outs" className="flex flex-wrap gap-2">
							{ruleOuts.map((rule) => (
								<li
									key={rule.id}
									className="rounded-full border border-[var(--line)] bg-[var(--card)] px-3 py-1.5 text-[13px] text-[var(--txt2)]"
								>
									{rule.text}
								</li>
							))}
						</ul>
					) : (
						<p className="text-[13px] text-[var(--txt3)]">
							Nothing ruled out yet.
						</p>
					)}
				</section>

				{/* The boards Archer sweeps */}
				<section className="rounded-[18px] border border-[var(--line-2)] bg-[var(--card-2)] px-[18px] py-4">
					<Eyebrow>Boards I'll sweep</Eyebrow>
					<ul className="flex flex-col gap-2">
						{SCAN_SOURCES.map((name) => (
							<li
								key={name}
								className="flex items-center gap-3 rounded-xl border border-[var(--line-2)] bg-[var(--card)] px-3 py-2.5"
							>
								<span className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-white/5 font-heading text-[14px] font-bold text-[var(--txt2)]">
									{name[0]}
								</span>
								<span className="flex-1 text-[14px] font-semibold">{name}</span>
								<span className="size-2 shrink-0 rounded-full bg-white/[0.18]" />
							</li>
						))}
					</ul>
				</section>

				{/* Recent activity (placeholder until the activity API exists) */}
				<section
					data-testid="home-activity"
					className="rounded-[18px] border border-[var(--line-2)] bg-[var(--card-2)] px-[18px] py-4"
				>
					<Eyebrow>Recent activity</Eyebrow>
					<ul className="flex flex-col gap-2">
						{PLACEHOLDER_ACTIVITY.map(({ icon: Icon, label }) => (
							<li
								key={label}
								className="flex items-center gap-3 rounded-xl border border-[var(--line-2)] bg-[var(--card)] px-3 py-2.5"
							>
								<Icon className="size-[15px] shrink-0 text-[var(--accent)]" />
								<span className="text-[13px] font-semibold text-[var(--txt)]">
									{label}
								</span>
							</li>
						))}
					</ul>
				</section>
			</div>

			<div className="mt-7 flex justify-center">
				<button
					type="button"
					data-testid="home-start-over"
					onClick={onStartOver}
					disabled={startingOver}
					className="flex items-center gap-2 rounded-[13px] border border-[var(--line)] bg-transparent px-[22px] py-[13px] text-[14px] font-semibold text-[var(--txt2)] transition-colors hover:border-brand/45 hover:bg-white/[0.055] disabled:cursor-not-allowed disabled:opacity-50"
				>
					{startingOver ? (
						<Loader2 className="size-[18px] animate-spin" />
					) : null}
					Start over
				</button>
			</div>
		</div>
	);
}
