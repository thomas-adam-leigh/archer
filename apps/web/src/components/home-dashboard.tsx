import {
	Ban,
	Building2,
	Clock,
	Crosshair,
	FileText,
	Loader2,
	Radar,
	Search,
	Send,
	Sparkles,
} from "lucide-react";
import type { ComponentType } from "react";
import { ArcherOrb } from "#/components/archer-orb.tsx";
import {
	type ActivityItem,
	activityFeed,
	type BoardStatus,
	boardCollectState,
	type CollectionSchedule,
	type DailyRun,
	dailyRunHeadline,
	type FeedItem,
	researchingNow,
	runTrailLines,
} from "#/lib/dashboard.ts";
import { formatRun, scheduleCadence } from "#/lib/next-run.ts";
import type { NegativeCriterion } from "#/lib/preferences.ts";

/**
 * The post-onboarding home — where the candidate is "directed out of onboarding"
 * (M8: ARC-113) and watches Archer work (M1: ARC-148). A resting dashboard:
 * Archer's next scheduled run, a "where I'll look" summary of the onboarding
 * outputs (target titles + rule-outs), the boards it sweeps with their live
 * integration status, today's collect run rolled up into a readable trail, and a
 * recent-activity feed (incl. the live "Archer is researching …" indicator right
 * after a shortlist). Presentational — the route owns the queries and the
 * start-over action; this renders calm loading / empty / error states throughout
 * (no activity, no jobs and no companies is the launch default).
 */

/** A read the dashboard renders, narrowed from a TanStack Query result. */
interface QueryView<T> {
	data?: T;
	isPending: boolean;
	isError: boolean;
}

/** Shared card chrome for the dashboard sections. */
function Eyebrow({ children }: { children: string }) {
	return (
		<div className="mb-3 text-[11px] font-bold uppercase tracking-[0.09em] text-[var(--txt3)]">
			{children}
		</div>
	);
}

/** A muted single-line note used for loading / empty / error states. */
function Note({ children }: { children: string }) {
	return <p className="text-[13px] text-[var(--txt3)]">{children}</p>;
}

/**
 * Archer's next scheduled run, the cadence, and the last actual run — all from the
 * real API schedule (ARC-172), rendered in the user's local timezone. Honest empty
 * state: when no run has happened yet we say so rather than imply one did.
 */
function NextRunCard({
	schedule,
}: {
	schedule: QueryView<CollectionSchedule>;
}) {
	const data = schedule.data;
	const now = new Date();
	const next = data ? formatRun(new Date(data.nextRunAt), now) : null;
	const last = data?.lastRunAt
		? formatRun(new Date(data.lastRunAt), now)
		: null;
	return (
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
				{schedule.isPending ? (
					<Note>Loading schedule…</Note>
				) : schedule.isError || !data || !next ? (
					<Note>Couldn't load the schedule just now.</Note>
				) : (
					<>
						<div
							data-testid="home-next-run-time"
							className="font-heading text-[19px] font-semibold text-[var(--txt)]"
						>
							{next.label} · {next.time}
						</div>
						<div
							data-testid="home-cadence"
							className="mt-[3px] text-[13px] text-[var(--txt2)]"
						>
							{scheduleCadence(data.schedule, new Date(data.nextRunAt))}
						</div>
						<div
							data-testid="home-last-run"
							className="mt-[3px] text-[12px] text-[var(--txt3)]"
						>
							{last ? `Last run · ${last.label} ${last.time}` : "No runs yet."}
						</div>
					</>
				)}
			</div>
		</section>
	);
}

const FEED_ICONS: Record<
	FeedItem["kind"],
	ComponentType<{ className?: string }>
> = {
	collect: Search,
	match: Sparkles,
	enrich: Building2,
	cover_letter: FileText,
	apply: Send,
};

/** The status dot beside a board, coloured by its collect integration state. */
function boardDotClass(
	tone: ReturnType<typeof boardCollectState>["tone"],
): string {
	if (tone === "live")
		return "bg-emerald-400 shadow-[0_0_8px_theme(colors.emerald.400)]";
	if (tone === "attention") return "bg-amber-400";
	return "bg-white/[0.18]";
}

/** The boards Archer sweeps, with their live collect integration status. */
function BoardsPanel({ boards }: { boards: QueryView<BoardStatus[]> }) {
	return (
		<section
			data-testid="home-boards"
			className="rounded-[18px] border border-[var(--line-2)] bg-[var(--card-2)] px-[18px] py-4"
		>
			<Eyebrow>Boards I'll sweep</Eyebrow>
			{boards.isPending ? (
				<Note>Loading boards…</Note>
			) : boards.isError ? (
				<Note>Couldn't load boards just now.</Note>
			) : !boards.data || boards.data.length === 0 ? (
				<Note>No boards configured yet.</Note>
			) : (
				<ul className="flex flex-col gap-2">
					{boards.data.map((b) => {
						const state = boardCollectState(b.collect_status);
						return (
							<li
								key={b.slug}
								data-testid="home-board"
								className="flex items-center gap-3 rounded-xl border border-[var(--line-2)] bg-[var(--card)] px-3 py-2.5"
							>
								<span className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-white/5 font-heading text-[14px] font-bold text-[var(--txt2)]">
									{b.name[0]}
								</span>
								<span className="flex-1 text-[14px] font-semibold">
									{b.name}
								</span>
								<span className="text-[11px] font-semibold text-[var(--txt3)]">
									{state.label}
								</span>
								<span
									className={`size-2 shrink-0 rounded-full ${boardDotClass(state.tone)}`}
								/>
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}

/** Today's collect run rolled up into a headline + per-board trail. */
function TodaysRun({
	dailyRun,
	boardName,
}: {
	dailyRun: QueryView<DailyRun>;
	boardName: (slug: string | null) => string;
}) {
	const run = dailyRun.data;
	const headline = run ? dailyRunHeadline(run) : null;
	const trail = run ? runTrailLines(run, boardName) : [];
	return (
		<section
			data-testid="home-todays-run"
			className="rounded-[18px] border border-[var(--line-2)] bg-[var(--card-2)] px-[18px] py-4"
		>
			<Eyebrow>Today's run</Eyebrow>
			{dailyRun.isPending ? (
				<Note>Loading today's run…</Note>
			) : dailyRun.isError ? (
				<Note>Couldn't load today's run just now.</Note>
			) : headline === null ? (
				<Note>Archer is searching for opportunities…</Note>
			) : (
				<>
					<p
						data-testid="home-todays-run-headline"
						className="mb-3 text-[14px] font-semibold text-[var(--txt)]"
					>
						{headline}
					</p>
					{trail.length > 0 ? (
						<ul data-testid="home-run-trail" className="flex flex-col gap-2">
							{trail.map((line) => (
								<li
									key={line.activityId}
									className="flex items-center gap-3 rounded-xl border border-[var(--line-2)] bg-[var(--card)] px-3 py-2.5"
								>
									<span className="flex-1 text-[13px] font-semibold text-[var(--txt2)]">
										{line.board}
									</span>
									<span className="text-[13px] text-[var(--txt3)]">
										{line.detail}
									</span>
								</li>
							))}
						</ul>
					) : null}
				</>
			)}
		</section>
	);
}

/** The recent-activity feed + the live "Archer is researching …" indicator. */
function ActivityFeed({
	activities,
}: {
	activities: QueryView<ActivityItem[]>;
}) {
	const rows = activities.data ?? [];
	const researching = researchingNow(rows);
	const feed = activityFeed(rows);
	return (
		<section
			data-testid="home-activity"
			className="rounded-[18px] border border-[var(--line-2)] bg-[var(--card-2)] px-[18px] py-4"
		>
			<Eyebrow>Recent activity</Eyebrow>

			{researching.length > 0 ? (
				<div
					data-testid="home-researching"
					className="mb-2 flex items-center gap-3 rounded-xl border border-brand/28 bg-brand/[0.08] px-3 py-2.5"
				>
					<Loader2 className="size-[15px] shrink-0 animate-spin text-[var(--accent)]" />
					<span className="text-[13px] font-semibold text-[var(--txt)]">
						Archer is researching {researching.join(", ")}…
					</span>
				</div>
			) : null}

			{activities.isPending ? (
				<Note>Loading recent activity…</Note>
			) : activities.isError ? (
				<Note>Couldn't load recent activity just now.</Note>
			) : feed.length === 0 && researching.length === 0 ? (
				<div
					data-testid="home-activity-empty"
					className="flex items-center gap-3 py-1"
				>
					<Radar className="size-[15px] shrink-0 text-[var(--txt3)]" />
					<Note>No activity yet — Archer will start on its next run.</Note>
				</div>
			) : feed.length > 0 ? (
				<ul className="flex flex-col gap-2">
					{feed.map((item) => {
						const Icon = FEED_ICONS[item.kind];
						return (
							<li
								key={item.id}
								data-testid="home-activity-item"
								className="flex items-center gap-3 rounded-xl border border-[var(--line-2)] bg-[var(--card)] px-3 py-2.5"
							>
								<Icon className="size-[15px] shrink-0 text-[var(--accent)]" />
								<span className="text-[13px] font-semibold text-[var(--txt)]">
									{item.label}
								</span>
							</li>
						);
					})}
				</ul>
			) : null}
		</section>
	);
}

export function HomeDashboard({
	schedule,
	titles,
	ruleOuts,
	boards,
	dailyRun,
	activities,
	onStartOver,
	startingOver = false,
}: {
	schedule: QueryView<CollectionSchedule>;
	titles: string[];
	ruleOuts: NegativeCriterion[];
	boards: QueryView<BoardStatus[]>;
	dailyRun: QueryView<DailyRun>;
	activities: QueryView<ActivityItem[]>;
	onStartOver: () => void;
	startingOver?: boolean;
}) {
	// Resolve a board's display name from its slug for the run trail; falls back to
	// the slug when the boards read hasn't landed (or the board isn't listed).
	const boardName = (slug: string | null): string => {
		if (!slug) return "A board";
		return boards.data?.find((b) => b.slug === slug)?.name ?? slug;
	};

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
				{/* Next run — the real schedule + next/last run from the API */}
				<NextRunCard schedule={schedule} />

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

				{/* Today's collect run (live) */}
				<TodaysRun dailyRun={dailyRun} boardName={boardName} />

				{/* The boards Archer sweeps (live integration status) */}
				<BoardsPanel boards={boards} />

				{/* Recent activity (live) + the "researching now" indicator */}
				<ActivityFeed activities={activities} />
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
