import { describe, expect, it } from "vitest";
import { NotIntegratedError } from "./adapters/types.js";
import { classifyCollectError, nextCollectStatus } from "./commands/collect.js";

// ARC-10 — the pure decision behind the board collect-status lifecycle. A live
// collect run drives boards.collect_status so it reflects the adapter's reality:
// a clean run proves the adapter healthy (→ integrated, restoring a broken board),
// while a failure breaks the board ONLY if it was actually integrated. A run that
// merely refuses because the board was never integrated (not_integrated / still
// in_progress) leaves its status untouched. Returns null when no write is needed,
// so collect/apply stay independent and writes stay minimal. DB-free → runs in CI.
describe("ARC-10 — nextCollectStatus (collect-status lifecycle decision)", () => {
  it("a clean run restores a broken board to integrated", () => {
    expect(nextCollectStatus(false, "broken")).toBe("integrated");
  });

  it("a clean run integrates a board that was still wiring up", () => {
    expect(nextCollectStatus(false, "not_integrated")).toBe("integrated");
    expect(nextCollectStatus(false, "in_progress")).toBe("integrated");
  });

  it("a clean run on an already-integrated board needs no write", () => {
    expect(nextCollectStatus(false, "integrated")).toBeNull();
  });

  it("a failed run breaks a board that was integrated", () => {
    expect(nextCollectStatus(true, "integrated")).toBe("broken");
  });

  it("a failed run leaves a not-yet-integrated board untouched (refusal, not breakage)", () => {
    expect(nextCollectStatus(true, "not_integrated")).toBeNull();
    expect(nextCollectStatus(true, "in_progress")).toBeNull();
  });

  it("a failed run on an already-broken board needs no write", () => {
    expect(nextCollectStatus(true, "broken")).toBeNull();
  });
});

// ARC-140 — the pure policy behind "not integrated" being a clean outcome rather
// than a failure. A NotIntegratedError (a board whose adapter isn't wired up yet)
// is classified `not_integrated` so the run records a succeeded Activity and leaves
// the board status untouched; any other error is a genuine `failed` run that breaks
// an integrated board. DB-free → runs in CI; the wiring is proven DB-backed in
// collect-lifecycle.test.ts.
describe("ARC-140 — classifyCollectError (not-integrated vs genuine failure)", () => {
  it("a NotIntegratedError is the calm not-integrated outcome, not a failure", () => {
    expect(classifyCollectError(new NotIntegratedError("no adapter yet"))).toBe("not_integrated");
  });

  it("any other error is a genuine failure", () => {
    expect(classifyCollectError(new Error("scrape blew up"))).toBe("failed");
    expect(classifyCollectError("login timed out")).toBe("failed");
  });
});
