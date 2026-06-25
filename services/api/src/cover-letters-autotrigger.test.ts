import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// POST /commands/cover-letter/{candidacyId} — the autonomous draft+submit endpoint
// the DB trigger (archer_cover_letter_gate) fires when a candidacy enters
// `awaiting_cover_letter`. It fuses what /cover-letters/run then /cover-letters/submit
// do, resolving the owner from the CANDIDACY (no caller thread) and minting a system
// thread. Same hermetic shape as cover-letters-run.test.ts: the @archer/db reads are
// mocked, a capturing Scribe is injected via setScribe, and the pure event-log + fold
// helpers (./agui.js) run for real. We assert the happy path (drafts + submits → a
// proposal, candidacy ends in_review), the fire-and-forget skips (200 {skipped}), and
// the unknown-candidacy 404.
vi.mock("./db.js", () => ({ getDb: () => ({}) }));
vi.mock("@archer/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archer/db")>();
  return {
    ...actual,
    getCandidacyContext: vi.fn(),
    getCoverLetterContext: vi.fn(),
    getLiveProfileVersion: vi.fn(),
    listCoverLetterVersions: vi.fn(),
    createThread: vi.fn(),
    createRun: vi.fn(),
    appendEvents: vi.fn(),
    finishRun: vi.fn(),
    createCoverLetterVersion: vi.fn(),
    submitCoverLetterVersion: vi.fn(),
    setCandidacyStatus: vi.fn(),
    submitCoverLetterVersionProposal: vi.fn(),
  };
});

import {
  type CandidacyContext,
  type CoverLetterContext,
  type CoverLetterVersion,
  createCoverLetterVersion,
  createRun,
  createThread,
  getCandidacyContext,
  getCoverLetterContext,
  getLiveProfileVersion,
  listCoverLetterVersions,
  type ProfileVersion,
  type Run,
  setCandidacyStatus,
  submitCoverLetterVersion,
  submitCoverLetterVersionProposal,
  type Thread,
} from "@archer/db";
import { type Scribe, setScribe } from "./scribe";

const app = (await import("./app")).default;
const mockCandidacy = vi.mocked(getCandidacyContext);
const mockCoverCtx = vi.mocked(getCoverLetterContext);
const mockLive = vi.mocked(getLiveProfileVersion);
const mockListVersions = vi.mocked(listCoverLetterVersions);
const mockCreateThread = vi.mocked(createThread);
const mockCreateRun = vi.mocked(createRun);
const mockCreateVersion = vi.mocked(createCoverLetterVersion);
const mockSubmitVersion = vi.mocked(submitCoverLetterVersion);
const mockSetStatus = vi.mocked(setCandidacyStatus);
const mockSubmitProposal = vi.mocked(submitCoverLetterVersionProposal);

const USER = "11111111-1111-1111-1111-111111111111";
const THREAD = "22222222-2222-2222-2222-222222222222";
const CANDIDACY = "33333333-3333-3333-3333-333333333333";
const RUN = "44444444-4444-4444-4444-444444444444";
const VERSION = "55555555-5555-5555-5555-555555555555";
const PROPOSAL = "66666666-6666-6666-6666-666666666666";

const candidacy: CandidacyContext = {
  id: CANDIDACY,
  user_id: USER,
  status: "awaiting_cover_letter",
  posting_title: "Platform Engineer",
  company_name: "Acme Corp",
  board_slug: "greenhouse",
  apply_confirmed_at: null,
};

const enriched: CoverLetterContext = {
  roleTitle: "Platform Engineer",
  companyName: "Acme Corp",
  jobDescription: "Own the billing platform and mentor the engineering team.",
  companyAbout: "Acme Corp builds developer tooling for fintech teams.",
  resumeText: "Adam Leigh — 8 years building payment platforms in TypeScript and Go.",
};

const post = () => ({ method: "POST", headers: { "content-type": "application/json" } });

describe("POST /commands/cover-letter/{candidacyId} — autonomous draft + submit", () => {
  let received: Parameters<Scribe>[0] | undefined;

  beforeEach(() => {
    // Dev opt-in clears the service gate without a shared secret (as cover-letters-run).
    process.env.ARCHER_API_DEV_OPEN = "1";
    delete process.env.ARCHER_API_SECRET;

    received = undefined;
    const capturing: Scribe = async (ctx) => {
      received = ctx;
      return "Dear Acme Corp Hiring Team,\n\nDrafted.\n\nKind regards,";
    };
    setScribe(capturing);

    mockCandidacy.mockResolvedValue(candidacy);
    mockCoverCtx.mockResolvedValue(enriched);
    mockLive.mockResolvedValue({ attributes: {} } as unknown as ProfileVersion);
    mockListVersions.mockResolvedValue([]); // nothing drafted yet
    mockCreateThread.mockResolvedValue({ id: THREAD, user_id: USER } as Thread);
    mockCreateRun.mockResolvedValue({ id: RUN } as Run);
    mockCreateVersion.mockResolvedValue({ id: VERSION, status: "draft" } as CoverLetterVersion);
    mockSubmitVersion.mockResolvedValue({ id: VERSION, status: "proposed" } as CoverLetterVersion);
    mockSetStatus.mockResolvedValue(undefined as never);
    mockSubmitProposal.mockResolvedValue({ id: PROPOSAL });
  });
  afterEach(() => {
    delete process.env.ARCHER_API_DEV_OPEN;
    delete process.env.ARCHER_API_SECRET;
    setScribe(undefined); // reset the memoized scribe between tests
    vi.clearAllMocks();
  });

  it("drafts + submits an awaiting candidacy and ends in_review with a version + proposal", async () => {
    const res = await app.request(`/commands/cover-letter/${CANDIDACY}`, post());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      candidacyId: CANDIDACY,
      versionId: VERSION,
      proposalId: PROPOSAL,
      status: "in_review",
    });

    // It minted a system thread for the owner resolved from the candidacy …
    expect(mockCreateThread).toHaveBeenCalledWith(expect.anything(), USER, expect.anything());
    // … fed the enriched context to the Scribe (drafting half) …
    expect(mockCoverCtx).toHaveBeenCalledWith(expect.anything(), CANDIDACY);
    expect(received?.resumeText).toBe(enriched.resumeText);
    expect(received?.jobDescription).toBe(enriched.jobDescription);
    expect(received?.companyAbout).toBe(enriched.companyAbout);
    // … created + submitted a version and advanced into drafting before submit …
    expect(mockCreateVersion).toHaveBeenCalledTimes(1);
    expect(mockSubmitVersion).toHaveBeenCalledWith(expect.anything(), VERSION);
    expect(mockSetStatus).toHaveBeenCalledWith(expect.anything(), CANDIDACY, "drafting");
    // … and opened the cover_letter_version proposal (submit half → in_review).
    expect(mockSubmitProposal).toHaveBeenCalledTimes(1);
    expect(mockSubmitProposal.mock.calls[0][1]).toMatchObject({
      candidacyId: CANDIDACY,
      userId: USER,
      versionId: VERSION,
    });
  });

  it("skips (200) when the candidacy is not awaiting a cover letter", async () => {
    mockCandidacy.mockResolvedValue({ ...candidacy, status: "in_review" });
    const res = await app.request(`/commands/cover-letter/${CANDIDACY}`, post());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: true, reason: "not awaiting" });
    // Nothing was drafted.
    expect(mockCreateThread).not.toHaveBeenCalled();
    expect(mockCreateVersion).not.toHaveBeenCalled();
    expect(mockSubmitProposal).not.toHaveBeenCalled();
  });

  it("skips (200) when a non-draft version already exists for the candidacy", async () => {
    mockListVersions.mockResolvedValue([{ id: VERSION, status: "proposed" } as CoverLetterVersion]);
    const res = await app.request(`/commands/cover-letter/${CANDIDACY}`, post());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: true, reason: "already drafted" });
    expect(mockCreateThread).not.toHaveBeenCalled();
    expect(mockCreateVersion).not.toHaveBeenCalled();
  });

  it("does NOT skip on a stray draft-only version (proceeds to draft + submit)", async () => {
    mockListVersions.mockResolvedValue([{ id: VERSION, status: "draft" } as CoverLetterVersion]);
    const res = await app.request(`/commands/cover-letter/${CANDIDACY}`, post());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "in_review" });
    expect(mockCreateVersion).toHaveBeenCalledTimes(1);
  });

  it("returns 404 for an unknown candidacy", async () => {
    mockCandidacy.mockResolvedValue(undefined);
    const res = await app.request(`/commands/cover-letter/${CANDIDACY}`, post());
    expect(res.status).toBe(404);
    expect(mockCreateThread).not.toHaveBeenCalled();
  });
});
