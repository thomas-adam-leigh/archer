import { beforeEach, describe, expect, it, vi } from "vitest";

// ARC-50 — the CLI kanban moves `jobs shortlist` / `jobs dismiss` used to call raw
// setCandidacyStatus, bypassing the candidacy status machine the API's transition route
// enforces. So the CLI could make illegal jumps the API rejects 409 (e.g.
// applied → shortlisted), and a hand-set status wedges downstream gates (apply gates on
// `approved`, enrich on the shortlist set). They now route through transitionCandidacy.
//
// We partially mock @archer/db so transitionCandidacy is controllable while the real
// IllegalCandidacyTransitionError class is kept (so `instanceof` holds). No live DB.

vi.mock("@archer/db", async (importActual) => {
  const actual = await importActual<typeof import("@archer/db")>();
  return {
    ...actual,
    transitionCandidacy: vi.fn(),
    setCandidacyStatus: vi.fn(),
  };
});

import * as db from "@archer/db";
import { IllegalCandidacyTransitionError } from "@archer/db";
import { runDismiss, runShortlist } from "./commands/jobs.js";
import { CliError } from "./context.js";

const fakeDb = {} as db.Db;
const candidacy = (status: string) => ({ id: "cand-1", status }) as db.Candidacy;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ARC-50 — jobs shortlist/dismiss route through the status machine", () => {
  it("shortlist goes through transitionCandidacy (not raw setCandidacyStatus)", async () => {
    vi.mocked(db.transitionCandidacy).mockResolvedValueOnce(candidacy("shortlisted"));
    const c = await runShortlist(fakeDb, "cand-1");
    expect(c.status).toBe("shortlisted");
    expect(db.transitionCandidacy).toHaveBeenCalledWith(fakeDb, "cand-1", "shortlisted", {
      triageDecision: "shortlisted",
    });
    expect(db.setCandidacyStatus).not.toHaveBeenCalled();
  });

  it("dismiss goes through transitionCandidacy and forwards the reason", async () => {
    vi.mocked(db.transitionCandidacy).mockResolvedValueOnce(candidacy("dismissed"));
    const c = await runDismiss(fakeDb, "cand-1", "not a fit");
    expect(c.status).toBe("dismissed");
    expect(db.transitionCandidacy).toHaveBeenCalledWith(fakeDb, "cand-1", "dismissed", {
      triageDecision: "dismissed",
      reason: "not a fit",
    });
    expect(db.setCandidacyStatus).not.toHaveBeenCalled();
  });

  it("an illegal shortlist surfaces as a clean CliError — the same rejection the API 409s", async () => {
    // applied is terminal: applied → shortlisted is exactly what the API rejects 409.
    vi.mocked(db.transitionCandidacy).mockRejectedValue(
      new IllegalCandidacyTransitionError("applied", "shortlisted"),
    );
    await expect(runShortlist(fakeDb, "cand-1")).rejects.toBeInstanceOf(CliError);
    await expect(runShortlist(fakeDb, "cand-1")).rejects.toThrow(/illegal candidacy transition/);
  });

  it("an illegal dismiss surfaces as a clean CliError too", async () => {
    vi.mocked(db.transitionCandidacy).mockRejectedValue(
      new IllegalCandidacyTransitionError("applying", "dismissed"),
    );
    await expect(runDismiss(fakeDb, "cand-1")).rejects.toBeInstanceOf(CliError);
  });

  it("an unknown candidacy is a clean CliError, not a crash", async () => {
    vi.mocked(db.transitionCandidacy).mockResolvedValue(undefined);
    await expect(runShortlist(fakeDb, "nope")).rejects.toBeInstanceOf(CliError);
    await expect(runShortlist(fakeDb, "nope")).rejects.toThrow(/unknown candidacy/);
  });
});
