import { describe, expect, it } from "vitest";
import { asPolicy, DEFAULT_POLICY, needsApproval } from "./autonomy";

describe("needsApproval — the per-action autonomy resolver", () => {
  it("fails closed: an unknown action needs approval", () => {
    expect(needsApproval("sendEmail")).toBe(true);
    expect(needsApproval("applyToJob")).toBe(true);
  });

  it("auto-approves the safe baseline actions", () => {
    expect(needsApproval("readProfile")).toBe(false);
    expect(needsApproval("listJobs")).toBe(false);
    expect(DEFAULT_POLICY.readProfile).toBe("auto");
  });

  it("a user policy overrides the baseline either way", () => {
    // The user grants autonomy for an otherwise-gated action…
    expect(needsApproval("sendEmail", { sendEmail: "auto" })).toBe(false);
    // …and revokes it for a baseline-auto action.
    expect(needsApproval("readProfile", { readProfile: "always_ask" })).toBe(true);
  });

  it("asPolicy keeps only valid levels (fail-closed on junk)", () => {
    expect(asPolicy({ sendEmail: "auto", bogus: "maybe", listJobs: "always_ask" })).toEqual({
      sendEmail: "auto",
      listJobs: "always_ask",
    });
    expect(asPolicy(undefined)).toEqual({});
    expect(asPolicy("nope")).toEqual({});
    expect(asPolicy(["auto"])).toEqual({});
  });
});
