import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ARC-58 — CLI robustness. Two review findings, both verified in CI with no live DB:
//
//  M4 (partial-failure ordering): the enrich/apply/external-fill orchestrations used
//  to move the entity into its in-flight status BEFORE opening the Activity, both
//  outside the surrounding try. If `startActivity` then threw, the entity was stranded
//  in-flight with no failed Activity — so the self-heal Mechanic never saw it. We mock
//  @archer/db to force `startActivity` to throw and assert the Activity is opened first
//  (so a throw there can't strand the entity) and that any later throw still lands in
//  the catch that records the failed Activity. This control-flow invariant can't be
//  exercised by the DB-backed e2e tests (they can't make a real insert fail).
//
//  M5 (fixture parse guard): `readJsonFixture` turns a missing/malformed --fixture file
//  into a clean CliError instead of a raw ENOENT/SyntaxError.

const h = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("@archer/db", () => ({
  // reads / preconditions (defaults; overridden per-test where a different shape is needed)
  getCompany: vi.fn(async () => ({
    id: "co-1",
    name: "Acme",
    domain: null,
    website_url: null,
    status: "new",
  })),
  companyHasShortlistedCandidacy: vi.fn(async () => true),
  getCandidacyContext: vi.fn(async () => ({
    id: "cand-1",
    user_id: "user-1",
    status: "approved",
    posting_title: "Engineer",
    company_name: "Acme",
    board_slug: "careerjunction",
    // Already apply-confirmed (ARC-165) so these robustness cases exercise the apply
    // orchestration past the confirm gate.
    apply_confirmed_at: "2026-06-24T00:00:00Z",
  })),
  // Apply-confirm gate config (ARC-165) — present so a non-confirmed path would still
  // resolve, though the confirmed candidacy above skips this branch.
  applyConfirmMode: vi.fn(() => ({ kind: "always" })),
  isApplyConfirmationRequired: vi.fn(async () => true),
  getActiveCoverLetterVersion: vi.fn(async () => ({ id: "v-1", content: "Dear team" })),
  getOpenExternalApplicationForm: vi.fn(async () => ({
    id: "form-1",
    url: "https://apply.example/form/1",
    status: "pending",
  })),
  // in-flight status writes — recorded so we can assert ordering
  setCompanyStatus: vi.fn(async () => {
    h.calls.push("setCompanyStatus");
  }),
  transitionCandidacy: vi.fn(async () => {
    h.calls.push("transitionCandidacy");
  }),
  setExternalApplicationFormStatus: vi.fn(async () => {
    h.calls.push("setExternalApplicationFormStatus");
  }),
  // the Activity opener — recorded
  startActivity: vi.fn(async () => {
    h.calls.push("startActivity");
    return { id: "act-1" };
  }),
  // catch-path writes — recorded
  failActivity: vi.fn(async () => {
    h.calls.push("failActivity");
  }),
  failCompanyEnrichment: vi.fn(async () => {
    h.calls.push("failCompanyEnrichment");
  }),
  // success-path writes (not reached by the throw cases below)
  succeedActivity: vi.fn(),
  saveCompanyEnrichment: vi.fn(),
  upsertContacts: vi.fn(),
  advanceCandidaciesToCoverLetter: vi.fn(async () => []),
  createNotification: vi.fn(),
  openExternalApplicationForm: vi.fn(),
}));

import * as db from "@archer/db";
import { runApply } from "./commands/apply.js";
import { runEnrich } from "./commands/enrich.js";
import { runExternalFill } from "./commands/external-fill.js";
import { CliError, readJsonFixture } from "./context.js";

const fakeDb = {} as db.Db;

const throwsOnStart = () =>
  vi.mocked(db.startActivity).mockImplementationOnce(async () => {
    h.calls.push("startActivity");
    throw new Error("activity insert failed");
  });

beforeEach(() => {
  h.calls.length = 0;
  vi.clearAllMocks();
});

describe("M4 — the Activity is opened before any in-flight status write", () => {
  it("enrich: a thrown startActivity never moves the company to researching", async () => {
    throwsOnStart();
    await expect(runEnrich(fakeDb, { companyId: "co-1" })).rejects.toThrow(
      /activity insert failed/,
    );
    expect(h.calls).toEqual(["startActivity"]);
    expect(db.setCompanyStatus).not.toHaveBeenCalled();
  });

  it("enrich: a throw after the Activity is open records a failed Activity", async () => {
    vi.mocked(db.setCompanyStatus).mockImplementationOnce(async () => {
      h.calls.push("setCompanyStatus");
      throw new Error("status write failed");
    });
    await expect(runEnrich(fakeDb, { companyId: "co-1" })).rejects.toThrow(/status write failed/);
    expect(h.calls).toEqual([
      "startActivity",
      "setCompanyStatus",
      "failCompanyEnrichment",
      "failActivity",
    ]);
  });

  it("apply: a thrown startActivity never moves the candidacy to applying", async () => {
    throwsOnStart();
    await expect(runApply(fakeDb, { candidacyId: "cand-1" })).rejects.toThrow(
      /activity insert failed/,
    );
    expect(h.calls).toEqual(["startActivity"]);
    expect(db.transitionCandidacy).not.toHaveBeenCalled();
  });

  it("apply: a throw while moving to applying fails the Activity without an illegal revert", async () => {
    vi.mocked(db.transitionCandidacy).mockImplementationOnce(async () => {
      h.calls.push("transitionCandidacy");
      throw new Error("applying write failed");
    });
    await expect(runApply(fakeDb, { candidacyId: "cand-1" })).rejects.toThrow(
      /applying write failed/,
    );
    // Activity opened first, so the failure is recorded…
    expect(db.failActivity).toHaveBeenCalledWith(
      fakeDb,
      "act-1",
      expect.stringContaining("applying write failed"),
      expect.anything(),
    );
    // …but the candidacy never reached `applying`, so the catch does NOT attempt the
    // illegal approved → application_failed revert (it is called exactly once — the
    // failed applying attempt — and never again).
    expect(vi.mocked(db.transitionCandidacy).mock.calls).toHaveLength(1);
  });

  it("external-fill: a thrown startActivity never moves the form to in_progress", async () => {
    vi.mocked(db.getCandidacyContext).mockResolvedValueOnce({
      id: "cand-1",
      user_id: "user-1",
      status: "external_pending",
      posting_title: "Engineer",
      company_name: "Acme",
      board_slug: "careerjunction",
    });
    throwsOnStart();
    await expect(runExternalFill(fakeDb, { candidacyId: "cand-1" })).rejects.toThrow(
      /activity insert failed/,
    );
    expect(h.calls).toEqual(["startActivity"]);
    expect(db.setExternalApplicationFormStatus).not.toHaveBeenCalled();
  });
});

describe("M5 — readJsonFixture guards malformed/missing fixture files", () => {
  it("parses a valid JSON file", () => {
    const dir = mkdtempSync(join(tmpdir(), "arc58-"));
    try {
      const p = join(dir, "ok.json");
      writeFileSync(p, JSON.stringify({ kind: "submitted" }));
      expect(readJsonFixture(p, "--fixture")).toEqual({ kind: "submitted" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws a clean CliError naming the flag for a missing file", () => {
    expect(() => readJsonFixture("/no/such/arc58/file.json", "--fixture")).toThrow(CliError);
    expect(() => readJsonFixture("/no/such/arc58/file.json", "--fixture")).toThrow(/--fixture/);
  });

  it("throws a clean CliError for malformed JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "arc58-"));
    try {
      const p = join(dir, "bad.json");
      writeFileSync(p, "{ not valid json ");
      expect(() => readJsonFixture(p, "--fixture")).toThrow(CliError);
      expect(() => readJsonFixture(p, "--fixture")).toThrow(/valid JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
