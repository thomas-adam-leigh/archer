import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScribeContext } from "./agui";

// /cover-letters/run enriched context (ARC-37): the route must feed the Scribe the
// candidate's résumé, the company's About, and the job description — not just the
// role title + company name — so the draft is specific. Stub the pool + the reads so
// the test stays hermetic (no DB): the point under test is that the handler LOADS the
// enriched context (getCoverLetterContext) and PASSES it into the Scribe. We inject a
// fake Scribe via setScribe and capture the context it receives. The event-log + fold
// helpers (./agui.js) are pure and run for real; only @archer/db reads are mocked.
vi.mock("./db.js", () => ({ getDb: () => ({}) }));
vi.mock("@archer/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archer/db")>();
  return {
    ...actual,
    getThreadOwner: vi.fn(),
    getCandidacyContext: vi.fn(),
    getCoverLetterContext: vi.fn(),
    getLiveProfileVersion: vi.fn(),
    createRun: vi.fn(),
    appendEvents: vi.fn(),
    finishRun: vi.fn(),
    createCoverLetterVersion: vi.fn(),
    submitCoverLetterVersion: vi.fn(),
    setCandidacyStatus: vi.fn(),
  };
});

import {
  type CandidacyContext,
  type CoverLetterContext,
  type CoverLetterVersion,
  createCoverLetterVersion,
  createRun,
  getCandidacyContext,
  getCoverLetterContext,
  getLiveProfileVersion,
  getThreadOwner,
  type ProfileVersion,
  type Run,
  setCandidacyStatus,
  submitCoverLetterVersion,
} from "@archer/db";
import { type Scribe, setScribe } from "./scribe";

const app = (await import("./app")).default;
const mockThreadOwner = vi.mocked(getThreadOwner);
const mockCandidacy = vi.mocked(getCandidacyContext);
const mockCoverCtx = vi.mocked(getCoverLetterContext);
const mockLive = vi.mocked(getLiveProfileVersion);
const mockCreateRun = vi.mocked(createRun);
const mockCreateVersion = vi.mocked(createCoverLetterVersion);
const mockSubmitVersion = vi.mocked(submitCoverLetterVersion);
const mockSetStatus = vi.mocked(setCandidacyStatus);

const USER = "11111111-1111-1111-1111-111111111111";
const THREAD = "22222222-2222-2222-2222-222222222222";
const CANDIDACY = "33333333-3333-3333-3333-333333333333";
const RUN = "44444444-4444-4444-4444-444444444444";
const VERSION = "55555555-5555-5555-5555-555555555555";

const post = (body: unknown) => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

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

describe("POST /cover-letters/run — enriched Scribe context (ARC-37)", () => {
  let received: ScribeContext | undefined;

  beforeEach(() => {
    // Dev opt-in clears the service gate without a shared secret (as app.test.ts).
    process.env.ARCHER_API_DEV_OPEN = "1";
    delete process.env.ARCHER_API_SECRET;

    received = undefined;
    const capturing: Scribe = async (ctx) => {
      received = ctx;
      return "Dear Acme Corp Hiring Team,\n\nDrafted.\n\nKind regards,";
    };
    setScribe(capturing);

    mockThreadOwner.mockResolvedValue(USER);
    mockCandidacy.mockResolvedValue(candidacy);
    mockCoverCtx.mockResolvedValue(enriched);
    // No live profile attrs ⇒ the existing highlights logic yields an empty list,
    // which is left untouched by this change.
    mockLive.mockResolvedValue({ attributes: {} } as unknown as ProfileVersion);
    mockCreateRun.mockResolvedValue({ id: RUN } as Run);
    mockCreateVersion.mockResolvedValue({ id: VERSION, status: "draft" } as CoverLetterVersion);
    mockSubmitVersion.mockResolvedValue({ id: VERSION, status: "submitted" } as CoverLetterVersion);
    mockSetStatus.mockResolvedValue(undefined as never);
  });
  afterEach(() => {
    delete process.env.ARCHER_API_DEV_OPEN;
    delete process.env.ARCHER_API_SECRET;
    setScribe(undefined); // reset the memoized scribe between tests
    vi.clearAllMocks();
  });

  it("loads the enriched context and passes résumé / job description / About to the Scribe", async () => {
    const res = await app.request(
      "/cover-letters/run",
      post({ threadId: THREAD, candidacyId: CANDIDACY }),
    );
    expect(res.status).toBe(200);

    // The handler asked for the enriched context for this candidacy …
    expect(mockCoverCtx).toHaveBeenCalledWith(expect.anything(), CANDIDACY);
    // … and handed every rich field to the Scribe (not just role + company).
    expect(received).toBeDefined();
    expect(received?.roleTitle).toBe("Platform Engineer");
    expect(received?.companyName).toBe("Acme Corp");
    expect(received?.resumeText).toBe(enriched.resumeText);
    expect(received?.jobDescription).toBe(enriched.jobDescription);
    expect(received?.companyAbout).toBe(enriched.companyAbout);
  });

  it("degrades gracefully when the enriched context is absent (nulls, role from the gate)", async () => {
    mockCoverCtx.mockResolvedValue(undefined);
    const res = await app.request(
      "/cover-letters/run",
      post({ threadId: THREAD, candidacyId: CANDIDACY }),
    );
    expect(res.status).toBe(200);
    // Role/company fall back to the gate's candidacy row; rich fields are null.
    expect(received?.roleTitle).toBe(candidacy.posting_title);
    expect(received?.companyName).toBe(candidacy.company_name);
    expect(received?.resumeText).toBeNull();
    expect(received?.jobDescription).toBeNull();
    expect(received?.companyAbout).toBeNull();
  });
});
