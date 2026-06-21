import { describe, expect, it } from "vitest";
import {
  assertCandidacyTransition,
  CANDIDACY_TRANSITIONS,
  IllegalCandidacyTransitionError,
  isLegalCandidacyTransition,
} from "./candidacy-status.js";
import { Constants } from "./database.types.js";

// The candidacy status machine is the apply-phase contract (ARC-42): the documented,
// enforced set of legal moves. This proves the machine directly — pure, no DB — so it
// runs in the default CI vitest pass and fails the build if the graph ever drifts from
// awaiting_cover_letter → drafting ⇄ in_review → approved → applying → applied |
// external_pending → applied | application_failed.

describe("candidacy status machine", () => {
  it("covers every candidacy_status enum value (no status without a transition row)", () => {
    const keys = Object.keys(CANDIDACY_TRANSITIONS).sort();
    const statuses = [...Constants.public.Enums.candidacy_status].sort();
    expect(keys).toEqual(statuses);
  });

  it("accepts the full apply-phase happy path, step by step", () => {
    const onBoard = [
      ["awaiting_cover_letter", "drafting"],
      ["drafting", "in_review"],
      ["in_review", "approved"],
      ["approved", "applying"],
      ["applying", "applied"],
    ] as const;
    for (const [from, to] of onBoard) {
      expect(isLegalCandidacyTransition(from, to)).toBe(true);
      expect(() => assertCandidacyTransition(from, to)).not.toThrow();
    }
  });

  it("accepts the external-redirect branch (applying → external_pending → applied)", () => {
    expect(isLegalCandidacyTransition("applying", "external_pending")).toBe(true);
    expect(isLegalCandidacyTransition("external_pending", "applied")).toBe(true);
  });

  it("accepts the failure + revision branches", () => {
    expect(isLegalCandidacyTransition("applying", "application_failed")).toBe(true);
    expect(isLegalCandidacyTransition("external_pending", "application_failed")).toBe(true);
    // in_review ⇄ drafting (swipe-left feedback loop).
    expect(isLegalCandidacyTransition("in_review", "drafting")).toBe(true);
  });

  it("rejects illegal jumps that skip the machine", () => {
    const illegal = [
      ["new", "applied"],
      ["new", "applying"],
      ["approved", "applied"], // must pass through applying
      ["drafting", "approved"], // must pass through in_review
      ["awaiting_cover_letter", "approved"],
      ["external_pending", "approved"], // no going back from the apply step
    ] as const;
    for (const [from, to] of illegal) {
      expect(isLegalCandidacyTransition(from, to)).toBe(false);
      expect(() => assertCandidacyTransition(from, to)).toThrow(IllegalCandidacyTransitionError);
    }
  });

  it("treats applied / application_failed / dismissed as terminal (no exits)", () => {
    for (const terminal of ["applied", "application_failed", "dismissed"] as const) {
      expect(CANDIDACY_TRANSITIONS[terminal]).toEqual([]);
      expect(isLegalCandidacyTransition(terminal, "applying")).toBe(false);
    }
  });

  it("rejects self-transitions (a no-op move is not a legal kanban move)", () => {
    expect(isLegalCandidacyTransition("approved", "approved")).toBe(false);
  });

  it("carries the offending from/to on the thrown error", () => {
    try {
      assertCandidacyTransition("new", "applied");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IllegalCandidacyTransitionError);
      const e = err as IllegalCandidacyTransitionError;
      expect(e.from).toBe("new");
      expect(e.to).toBe("applied");
      expect(e.message).toContain("new");
      expect(e.message).toContain("applied");
    }
  });
});
