/**
 * The post-onboarding home's live data: the boards Archer sweeps, the day's
 * collect run, and the recent-activity feed (ARC-148).
 *
 * Three reads back the resting dashboard:
 *   - `GET /boards` — the seeded boards with their per-capability collect/apply
 *     integration status (the "boards I'll sweep" panel).
 *   - `GET /activities/daily` — the day's collect run rolled up into one coherent
 *     story (ARC-143): per-board outcomes + the run totals (the "today's run" trail).
 *   - `GET /activities` — the user's recent activities, newest first (the feed,
 *     including the live "Archer is researching …" indicator from an in-flight
 *     enrich run).
 *
 * Reads are JWT-scoped own-rows-only; we pass `?user=` as the documented client
 * contract (preferences.ts) on top of the bearer token. The fetch seam is
 * injectable so the pure shaping helpers — the copy the dashboard renders — stay
 * testable offline.
 */

import { apiGet } from "#/lib/api.ts";
import type { Session } from "#/lib/auth.ts";

/** The GET surface these reads need — injectable so they can be tested offline. */
export type DashboardGet = <T>(path: string, accessToken: string) => Promise<T>;

// ── boards ─────────────────────────────────────────────────────────────────
/** A board capability's integration status (mirrors `board_capability_status`). */
export type BoardCapabilityStatus =
	| "not_integrated"
	| "in_progress"
	| "integrated"
	| "broken";

/** A seeded board with its per-capability integration status (`GET /boards`). */
export interface BoardStatus {
	slug: string;
	name: string;
	collect_status: BoardCapabilityStatus;
	apply_status: BoardCapabilityStatus;
}

/** Read the boards Archer sweeps with their integration status. */
export async function listBoards(
	session: Session,
	get: DashboardGet = apiGet,
): Promise<BoardStatus[]> {
	const resp = await get<{ boards: BoardStatus[] }>(
		"/boards",
		session.accessToken,
	);
	return resp.boards;
}

/** How a board's collect capability reads on the dashboard. */
export interface BoardCollectState {
	/** The short status word shown beside the board. */
	label: string;
	/** A coarse tone the UI maps to colour. */
	tone: "live" | "soon" | "attention";
}

/** Describe a board's collect capability for the "boards I'll sweep" panel. */
export function boardCollectState(
	status: BoardCapabilityStatus,
): BoardCollectState {
	switch (status) {
		case "integrated":
			return { label: "Live", tone: "live" };
		case "in_progress":
			return { label: "Connecting", tone: "soon" };
		case "broken":
			return { label: "Needs attention", tone: "attention" };
		default:
			return { label: "Coming soon", tone: "soon" };
	}
}

// ── daily run (the collect run trail) ────────────────────────────────────────
/** A collect run's terminal outcome (mirrors the CLI's `CollectOutcome`). */
export type CollectRunOutcome =
	| "found"
	| "nothing_today"
	| "not_integrated"
	| "failed";

/** One board's contribution to a daily run (mirrors db `DailyRunBoard`). */
export interface DailyRunBoard {
	activityId: string;
	board: string | null;
	status: "queued" | "in_progress" | "succeeded" | "failed";
	outcome: CollectRunOutcome | "collecting";
	scraped: number;
	postingsNew: number;
	candidaciesNew: number;
	error: string | null;
}

/** A day's collect run rolled up into one story (mirrors db `DailyRunSummary`). */
export interface DailyRun {
	date: string;
	status: "in_progress" | "done" | null;
	jobsNew: number;
	postingsNew: number;
	counts: Record<CollectRunOutcome | "collecting", number>;
	boards: DailyRunBoard[];
	startedAt: string | null;
	finishedAt: string | null;
}

/** Read today's collect run rolled up for the dashboard. */
export async function fetchDailyRun(
	session: Session,
	get: DashboardGet = apiGet,
): Promise<DailyRun> {
	const resp = await get<{ user: string; run: DailyRun }>(
		`/activities/daily?user=${encodeURIComponent(session.user.id)}`,
		session.accessToken,
	);
	return resp.run;
}

/** Pluralise a count with its noun (1 job / 2 jobs). */
function plural(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * The one-line headline for the day's collect run, or `null` when no run has
 * happened today (the launch default — the caller shows a calm empty state). While
 * the run is still going it reads "collecting"; once done it summarises the new
 * jobs found and how many boards aren't integrated yet.
 */
export function dailyRunHeadline(run: DailyRun): string | null {
	if (run.status === null) return null;
	if (run.status === "in_progress")
		return "Archer is collecting today's roles…";
	const notIntegrated = run.counts.not_integrated;
	const tail =
		notIntegrated > 0
			? `; ${plural(notIntegrated, "board")} not integrated yet`
			: "";
	if (run.jobsNew === 0) return `Searched today — no new roles yet${tail}.`;
	const boardsFound = run.counts.found;
	const across =
		boardsFound > 0 ? ` across ${plural(boardsFound, "board")}` : "";
	return `Collected today — ${plural(run.jobsNew, "new role")}${across}${tail}.`;
}

/** A per-board line in the run trail, named via the boards lookup. */
export interface RunTrailLine {
	activityId: string;
	board: string;
	detail: string;
	outcome: CollectRunOutcome | "collecting";
}

/** Resolve a board's display name from its slug, falling back to the slug. */
type BoardName = (slug: string | null) => string;

/** One board's outcome, phrased for the run trail. */
function boardOutcomeDetail(b: DailyRunBoard): string {
	switch (b.outcome) {
		case "found":
			return plural(b.candidaciesNew, "new role");
		case "nothing_today":
			return "nothing new today";
		case "not_integrated":
			return "not integrated yet";
		case "failed":
			return "run failed";
		default:
			return "collecting…";
	}
}

/** The per-board run-trail lines for the day's collect run, named via `boardName`. */
export function runTrailLines(
	run: DailyRun,
	boardName: BoardName,
): RunTrailLine[] {
	return run.boards.map((b) => ({
		activityId: b.activityId,
		board: boardName(b.board),
		detail: boardOutcomeDetail(b),
		outcome: b.outcome,
	}));
}

// ── activity feed ────────────────────────────────────────────────────────────
/** The activity-type values an activity row can carry. */
export type ActivityType =
	| "collect"
	| "match"
	| "enrich"
	| "cover_letter"
	| "apply"
	| "external_fill"
	| "proposal_exec"
	| "cli_repair"
	| "deploy"
	| "transcribe"
	| "spoken_note";

/** An activity row projected for the feed (mirrors db `ActivityListItem`). */
export interface ActivityItem {
	id: string;
	type: ActivityType;
	status: "queued" | "in_progress" | "succeeded" | "failed";
	detail: Record<string, unknown> | null;
	error: string | null;
	started_at: string | null;
	finished_at: string | null;
	created_at: string;
}

/** Read the user's recent activities, newest first. */
export async function listActivities(
	session: Session,
	get: DashboardGet = apiGet,
): Promise<ActivityItem[]> {
	const resp = await get<{ user: string; activities: ActivityItem[] }>(
		`/activities?user=${encodeURIComponent(session.user.id)}`,
		session.accessToken,
	);
	return resp.activities;
}

/** The company name an enrich activity records on its `detail` (enrich.ts). */
function detailCompany(item: ActivityItem): string | null {
	const company = item.detail?.company;
	return typeof company === "string" ? company : null;
}

/**
 * The companies Archer is researching right now — the "watch it in action" moment
 * after a shortlist, when an enrich run is open (company → researching) but not yet
 * done. Drawn from in-flight enrich activities, newest first, deduped by name.
 */
export function researchingNow(activities: ActivityItem[]): string[] {
	const names: string[] = [];
	for (const a of activities) {
		if (a.type !== "enrich") continue;
		if (a.status !== "queued" && a.status !== "in_progress") continue;
		const name = detailCompany(a);
		if (name && !names.includes(name)) names.push(name);
	}
	return names;
}

/** A humanised recent-activity feed row. */
export interface FeedItem {
	id: string;
	label: string;
	/** A coarse kind the UI maps to an icon. */
	kind: "collect" | "match" | "enrich" | "cover_letter" | "apply";
}

/**
 * Humanise an activity into a feed row, or `null` for the operational/in-flight
 * types the home feed doesn't surface (transcribe, deploy, repair, and the
 * in-flight enrich rows already shown by the "researching now" indicator). Only
 * terminal, candidate-facing milestones make the feed.
 */
export function activityFeedItem(item: ActivityItem): FeedItem | null {
	if (item.status === "queued" || item.status === "in_progress") return null;
	const company = detailCompany(item);
	switch (item.type) {
		case "enrich":
			return item.status === "succeeded" && company
				? { id: item.id, label: `Researched ${company}`, kind: "enrich" }
				: null;
		case "cover_letter":
			return item.status === "succeeded"
				? {
						id: item.id,
						label: company
							? `Cover letter drafted — ${company}`
							: "Cover letter drafted",
						kind: "cover_letter",
					}
				: null;
		case "apply":
			return item.status === "succeeded"
				? {
						id: item.id,
						label: company ? `Applied — ${company}` : "Applied",
						kind: "apply",
					}
				: null;
		case "match":
			return item.status === "succeeded"
				? { id: item.id, label: "Reviewed new roles", kind: "match" }
				: null;
		default:
			return null;
	}
}

/** The humanised, candidate-facing recent-activity feed (newest first, capped). */
export function activityFeed(
	activities: ActivityItem[],
	limit = 6,
): FeedItem[] {
	const items: FeedItem[] = [];
	for (const a of activities) {
		const item = activityFeedItem(a);
		if (item) items.push(item);
		if (items.length >= limit) break;
	}
	return items;
}
