// The per-action autonomy resolver — owned ONCE here for every project.
//
// One question: "does action X for user U need approval?" An action either runs
// autonomously or pauses the run for a human (an AG-UI interrupt → a durable
// proposal). The resolver is a pure policy lookup so the run loop can consult it
// without IO, and so the policy is the single place that decides what is safe to
// do unattended. It fails CLOSED: an action with no policy needs approval.
import type { Json } from "@archer/db";

/** What may happen to an action without asking: pause for a human, or just run. */
export type AutonomyLevel = "always_ask" | "auto";

/** A per-action policy. Maps an action name to its autonomy level. A user's own
 *  overrides layer on top of the defaults (see needsApproval). */
export type AutonomyPolicy = Record<string, AutonomyLevel>;

/**
 * The built-in baseline. Only safe, read-only actions are auto; everything that
 * touches the outside world (email, applications) is absent and so falls through
 * to the fail-closed default of "always_ask".
 */
export const DEFAULT_POLICY: AutonomyPolicy = {
  readProfile: "auto",
  listJobs: "auto",
};

/**
 * Does `action` for this user need human approval? The user's `policy` overrides
 * the baseline; an unknown action defaults to "always_ask" (fail closed), so a
 * new capability is never run unattended until the policy explicitly allows it.
 */
export function needsApproval(action: string, policy: AutonomyPolicy = {}): boolean {
  const level = policy[action] ?? DEFAULT_POLICY[action] ?? "always_ask";
  return level === "always_ask";
}

/** Coerce loosely-typed forwardedProps/JSON into an AutonomyPolicy (auto levels
 *  only; anything else is dropped, keeping the fail-closed default in force). */
export function asPolicy(value: Json | undefined): AutonomyPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: AutonomyPolicy = {};
  for (const [action, level] of Object.entries(value)) {
    if (level === "auto" || level === "always_ask") out[action] = level;
  }
  return out;
}
