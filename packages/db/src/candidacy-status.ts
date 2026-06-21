// The candidacy status machine — the apply-phase kanban as code. This is the single
// source of truth for which moves are legal, mirroring the diagram in
// docs/Archer-Terminology-and-Architecture.md (§2.3). Enforced by transitionCandidacy()
// (and the API kanban-move route); raw setCandidacyStatus() stays the unguarded
// primitive used for seeding and the deliberate `jobs status` escape hatch.
import type { Database } from "./database.types.js";

type CandidacyStatus = Database["public"]["Enums"]["candidacy_status"];

/**
 * Each candidacy status mapped to the statuses it may legally move to (terminal
 * states map to an empty list):
 *
 *   new → dismissed | shortlisted | alternative_outreach
 *   shortlisted | alternative_outreach → awaiting_cover_letter (company enriched) | dismissed
 *   awaiting_cover_letter → drafting → in_review ⇄ drafting → approved
 *   approved → applying → applied | external_pending | application_failed
 *   external_pending → applied | application_failed
 *
 * `dismissed`, `applied` and `application_failed` are terminal. The `satisfies`
 * clause makes TypeScript reject the map if a status is ever added to the enum
 * without a row here, so the machine can never silently drift from the schema.
 */
export const CANDIDACY_TRANSITIONS = {
  new: ["dismissed", "shortlisted", "alternative_outreach"],
  shortlisted: ["awaiting_cover_letter", "dismissed"],
  alternative_outreach: ["awaiting_cover_letter", "dismissed"],
  awaiting_cover_letter: ["drafting"],
  drafting: ["in_review"],
  in_review: ["drafting", "approved"],
  approved: ["applying"],
  applying: ["applied", "external_pending", "application_failed"],
  external_pending: ["applied", "application_failed"],
  applied: [],
  application_failed: [],
  dismissed: [],
} satisfies Record<CandidacyStatus, readonly CandidacyStatus[]>;

/** True when `to` is a legal next status from `from` per the candidacy machine. */
export function isLegalCandidacyTransition(from: CandidacyStatus, to: CandidacyStatus): boolean {
  return (CANDIDACY_TRANSITIONS[from] as readonly CandidacyStatus[]).includes(to);
}

/** Thrown when a candidacy is asked to make a move the status machine forbids. */
export class IllegalCandidacyTransitionError extends Error {
  readonly from: CandidacyStatus;
  readonly to: CandidacyStatus;
  constructor(from: CandidacyStatus, to: CandidacyStatus) {
    super(`illegal candidacy transition: ${from} → ${to}`);
    this.name = "IllegalCandidacyTransitionError";
    this.from = from;
    this.to = to;
  }
}

/** Assert a candidacy may move `from → to`, or throw IllegalCandidacyTransitionError. */
export function assertCandidacyTransition(from: CandidacyStatus, to: CandidacyStatus): void {
  if (!isLegalCandidacyTransition(from, to)) {
    throw new IllegalCandidacyTransitionError(from, to);
  }
}
