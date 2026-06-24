// ARC-165 — apply-safety config. The apply step is the one irreversible
// outside-world action, so an `approved` candidacy waits behind an explicit owner
// confirmation before it may submit. This module decides WHEN that confirmation is
// required, governed by the ARCHER_APPLY_CONFIRM_MODE env var:
//
//   always   (default)  every application must be owner-confirmed — the safe default.
//   <N>      first-N     the first N applications a user fires require confirmation;
//                        once they have N applications in flight or completed, later
//                        ones may fire without it (the owner has built up trust).
//
// The default is `always` for safety: an unset, blank, or unparseable value all fall
// back to it rather than silently relaxing the gate.
import type { Db } from "./client.js";

/** How the apply-confirm gate behaves — always require, or only for the first N. */
export type ApplyConfirmMode = { kind: "always" } | { kind: "first-n"; n: number };

/**
 * Parse the apply-confirm mode from the environment (default `process.env`).
 * `always`/unset/blank → always; a positive integer N → first-N; anything else
 * (zero, negative, non-numeric) fails safe to `always`.
 */
export function applyConfirmMode(
  env: Record<string, string | undefined> = process.env,
): ApplyConfirmMode {
  const raw = env.ARCHER_APPLY_CONFIRM_MODE?.trim();
  if (!raw || raw.toLowerCase() === "always") return { kind: "always" };
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0) return { kind: "first-n", n };
  return { kind: "always" };
}

/** The candidacy statuses that count as an application already fired (in flight or
 *  terminal) — used to decide whether a user is still within their first-N window. */
const APPLIED_STATUSES = ["applying", "applied", "external_pending", "application_failed"] as const;

/**
 * Whether this user's next application must be owner-confirmed under `mode`.
 * `always` → always true. `first-n` → true until the user has N applications that
 * have already fired (counting in-flight, succeeded, and failed attempts), then false.
 */
export async function isApplyConfirmationRequired(
  db: Db,
  userId: string,
  mode: ApplyConfirmMode,
): Promise<boolean> {
  if (mode.kind === "always") return true;
  const [{ count }] = await db<{ count: number }[]>`
    select count(*)::int as count from public.candidacies
    where user_id = ${userId} and status = any(${APPLIED_STATUSES as unknown as string[]}::candidacy_status[])`;
  return count < mode.n;
}
