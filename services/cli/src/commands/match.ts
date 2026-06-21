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
import {
  LlmConfigError,
  type LlmEnv,
  type LlmProvider,
  type ResolveOptions,
  resolveLlm,
} from "@archer/llm";
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
 * The Matchmaker brain: judges one posting against one profile. The default is the
 * real single-shot LLM call (`createLlmJudge`, picked by `resolveJudge` when a
 * provider key is present); `stubJudge` is the deterministic fallback so the whole
 * triage loop runs (and is tested) without a live model.
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

// ── The real Matchmaker brain: a single-shot LLM triage call ──────────────────
// The deterministic stubJudge above is the test/fallback stand-in; this is the
// real judge that drops into the same `Judge` seam, using the @archer/llm provider
// abstraction (MiniMax M3 by default, OpenRouter BYOK, mock in tests). It is the
// default when a provider key is configured; with no key, triage falls back to
// stubJudge (see resolveJudge), so the matcher never makes a live call unbidden.

const DECISIONS: ReadonlySet<string> = new Set<Enums<"triage_decision">>([
  "shortlisted",
  "alternative_outreach",
  "dismissed",
]);

const JUDGE_SYSTEM =
  "You are Archer's Matchmaker, triaging one job posting against one candidate's " +
  "target titles and deal-breakers. Choose exactly one decision: " +
  '"shortlisted" (a strong, direct fit for a target title), ' +
  '"dismissed" (hits a deal-breaker or is clearly the wrong role), or ' +
  '"alternative_outreach" (a plausible adjacent role, not a direct hit). ' +
  'Reply with ONLY a JSON object: {"decision": <one of the three>, ' +
  '"score": <0-100 fit>, "reason": <one short sentence>}. No prose, no markdown.';

/** The posting+profile triage question, as the user turn the judge scores. */
function judgePrompt(posting: MatchPosting, profile: MatchProfile): string {
  return [
    `Candidate target titles: ${profile.titles.join(", ") || "(none)"}`,
    `Deal-breakers: ${profile.negativeCriteria.join(", ") || "(none)"}`,
    `Work preference: ${profile.workPref}${profile.willingRemote ? " (open to remote)" : ""}`,
    profile.about ? `About the candidate: ${profile.about}` : "",
    "",
    `Posting title: ${posting.title}`,
    `Company: ${posting.companyName ?? "(unknown)"}`,
    `Location: ${posting.location ?? "(unspecified)"} | Work mode: ${posting.workMode}`,
    posting.description ? `Description: ${posting.description}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Pull the first JSON object out of a model reply, tolerating ```json fences. */
function extractJsonObject(raw: string): Record<string, unknown> {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("Matchmaker reply had no JSON object");
  return JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
}

/** Parse + validate a model reply into a verdict. `score` is left raw (runMatch
 *  clamps to 0–100); an invalid/missing decision is a hard error so a malformed
 *  judgment fails the match Activity rather than silently mis-triaging. */
function parseVerdict(raw: string): MatchVerdict {
  const obj = extractJsonObject(raw);
  const decision = String(obj.decision ?? "");
  if (!DECISIONS.has(decision)) {
    throw new Error(`Matchmaker returned an invalid decision: "${decision}"`);
  }
  const score = Number(obj.score);
  const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";
  return {
    decision: decision as Enums<"triage_decision">,
    score: Number.isFinite(score) ? score : 0,
    reason: reason || "no reason given",
  };
}

/** Build a real `Judge` over a provider — one deterministic-temperature completion
 *  per posting. Exposed for tests (inject a mock provider). */
export function createLlmJudge(provider: LlmProvider): Judge {
  return async (posting, profile) => {
    const { text } = await provider.complete(
      [
        { role: "system", content: JUDGE_SYSTEM },
        { role: "user", content: judgePrompt(posting, profile) },
      ],
      { temperature: 0 },
    );
    return parseVerdict(text);
  };
}

/**
 * The default Matchmaker judge: the real LLM when a provider key is configured
 * (mock in tests via `LLM_PROVIDER=mock`), else the deterministic `stubJudge`.
 * Mirrors the conversational brain's resolution (services/api/src/brain.ts) but
 * keeps a network-free fallback, so a keyless matcher run stays correct and cheap.
 */
export function resolveJudge(env: LlmEnv = process.env, opts: ResolveOptions = {}): Judge {
  try {
    return createLlmJudge(resolveLlm(env, opts));
  } catch (err) {
    if (err instanceof LlmConfigError) return stubJudge;
    throw err;
  }
}

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
  const judge = args.judge ?? resolveJudge();
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
