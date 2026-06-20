import {
  type Db,
  type Enums,
  failActivity,
  getProfile,
  listNegativeCriteria,
  listNewCandidacies,
  listTargetTitles,
  setCandidacyStatus,
  startActivity,
  succeedActivity,
} from "@archer/db";
import type { Command } from "commander";
import { type GlobalOpts, output, requireUser, run } from "../context.js";

/** The posting context the Matchmaker scores (the candidacy's joined posting). */
export interface MatchPosting {
  title: string;
  companyName: string | null;
  location: string | null;
  workMode: Enums<"work_mode">;
  description: string | null;
}

/** The user's match key: their target titles + deal-breaker criteria + flat profile. */
export interface MatchProfile {
  titles: string[];
  negativeCriteria: string[];
  about: string | null;
  willingRemote: boolean;
  workPref: Enums<"work_mode">;
}

/** One triage verdict. `decision` doubles as the candidacy's next status (the three
 *  triage_decision values are all valid candidacy_status values). `score` is 0–100. */
export interface MatchVerdict {
  decision: Enums<"triage_decision">;
  score: number;
  reason: string;
}

/**
 * The Matchmaker brain: judges one posting against one profile. The real model is a
 * single-shot LLM call dropped in here; the default `stubJudge` is a deterministic
 * stand-in so the whole triage loop runs (and is tested) without a live model.
 */
export type Judge = (
  posting: MatchPosting,
  profile: MatchProfile,
) => MatchVerdict | Promise<MatchVerdict>;

/** Lowercase ≥4-char tokens of a string — the crude keyword unit the stub matches on. */
function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 4);
}

/**
 * A deterministic, network-free stand-in for the Matchmaker LLM. Rules, in order:
 *  1. any negative-criterion keyword present in the posting → dismissed (low score),
 *     the reason naming the deal-breaker that matched;
 *  2. else the posting title matches a target title (either contains the other) →
 *     shortlisted (high score);
 *  3. else → alternative_outreach (mid score) — a plausible reach, not a direct hit.
 * Mockable seam: pass your own `Judge` to `runMatch` to swap in a real provider.
 */
export const stubJudge: Judge = (posting, profile) => {
  const haystack = [posting.title, posting.companyName ?? "", posting.description ?? ""]
    .join(" ")
    .toLowerCase();

  for (const criterion of profile.negativeCriteria) {
    const hit = tokens(criterion).find((t) => haystack.includes(t));
    if (hit) {
      return {
        decision: "dismissed",
        score: 10,
        reason: `matched negative criterion "${criterion}" (keyword "${hit}")`,
      };
    }
  }

  const title = posting.title.toLowerCase();
  const matched = profile.titles.find((t) => {
    const want = t.toLowerCase().trim();
    return want.length > 0 && (title.includes(want) || want.includes(title));
  });
  if (matched) {
    return { decision: "shortlisted", score: 85, reason: `matches target title "${matched}"` };
  }

  return {
    decision: "alternative_outreach",
    score: 50,
    reason: "no direct target-title match; flagged for alternative outreach",
  };
};

/** The structured detail a match run records on its Activity and prints. */
export interface MatchSummary {
  processed: number;
  shortlisted: number;
  alternative_outreach: number;
  dismissed: number;
  /** The match Activity's id, or null when there were no `new` candidacies (no run). */
  activityId: string | null;
}

/**
 * Run one Matchmaker pass for a user: triage every `new` candidacy into
 * shortlisted / alternative_outreach / dismissed, recording status + triage_decision
 * + triage_reason + match_score on each. The whole pass is one `match` Activity
 * (queued→succeeded/failed) — but only when work exists: with no `new` candidacies it
 * is a no-op that opens no Activity, so the per-minute matcher stays cheap. Only
 * `new` rows are read, so a re-run never re-triages an already-decided candidacy.
 */
export async function runMatch(
  db: Db,
  args: { userId: string; judge?: Judge },
): Promise<MatchSummary> {
  const judge = args.judge ?? stubJudge;
  const candidacies = await listNewCandidacies(db, args.userId);
  if (candidacies.length === 0) {
    return {
      processed: 0,
      shortlisted: 0,
      alternative_outreach: 0,
      dismissed: 0,
      activityId: null,
    };
  }

  const [profile, criteria, titles] = await Promise.all([
    getProfile(db, args.userId),
    listNegativeCriteria(db, args.userId),
    listTargetTitles(db, args.userId, { activeOnly: true }),
  ]);
  const matchProfile: MatchProfile = {
    titles: titles.map((t) => t.title),
    negativeCriteria: criteria.map((c) => c.text),
    about: profile?.about ?? null,
    willingRemote: profile?.willing_remote ?? false,
    workPref: profile?.work_pref ?? "unknown",
  };

  const activity = await startActivity(db, {
    type: "match",
    userId: args.userId,
    detail: { candidacies: candidacies.length },
  });
  try {
    const tally = { shortlisted: 0, alternative_outreach: 0, dismissed: 0 };
    for (const c of candidacies) {
      const verdict = await judge(
        {
          title: c.posting_title,
          companyName: c.company_name,
          location: c.location,
          workMode: c.work_mode,
          description: c.description,
        },
        matchProfile,
      );
      // Clamp to the 0–100 contract; decision is both the new status and the triage.
      const score = Math.max(0, Math.min(100, Math.round(verdict.score)));
      await setCandidacyStatus(db, c.id, verdict.decision, {
        triageDecision: verdict.decision,
        reason: verdict.reason,
        score,
      });
      tally[verdict.decision]++;
    }
    const summary = {
      processed: candidacies.length,
      ...tally,
      activityId: activity.id as string | null,
    };
    await succeedActivity(db, activity.id, summary);
    return summary;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failActivity(db, activity.id, msg);
    throw err;
  }
}

export function registerMatch(program: Command): void {
  program
    .command("match")
    .description("Triage the user's new candidacies against their profile and negative criteria")
    .action(async (_opts, cmd) => {
      await run(cmd.optsWithGlobals() as GlobalOpts, async (ctx) => {
        const summary = await runMatch(ctx.db, { userId: requireUser(ctx) });
        output(ctx, summary, (s) =>
          console.log(
            s.activityId === null
              ? "match: no new candidacies"
              : `match: ${s.processed} triaged — ${s.shortlisted} shortlisted, ` +
                  `${s.alternative_outreach} alternative, ${s.dismissed} dismissed`,
          ),
        );
      });
    });
}
