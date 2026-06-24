import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Cover-letter read endpoints (ARC-145): the version history for a candidacy and a
// single version's full content. Stub the pool + the reads so the tests stay
// hermetic — the point under test is the routes: they require auth and gate to the
// owner. The list checks ownership via the candidacy (404 unknown, 403 someone
// else's); the single-version read gates on the version row's own user_id.
vi.mock("./db.js", () => ({ getDb: () => ({}) }));
vi.mock("@archer/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archer/db")>();
  return {
    ...actual,
    getCandidacy: vi.fn(),
    listCoverLetterVersionSummaries: vi.fn(),
    getOpenCoverLetterVersionProposal: vi.fn(),
    getCoverLetterVersion: vi.fn(),
  };
});

import {
  type Candidacy,
  type CoverLetterVersion,
  type CoverLetterVersionSummary,
  getCandidacy,
  getCoverLetterVersion,
  getOpenCoverLetterVersionProposal,
  listCoverLetterVersionSummaries,
} from "@archer/db";

const app = (await import("./app")).default;
const mockGetCandidacy = vi.mocked(getCandidacy);
const mockListSummaries = vi.mocked(listCoverLetterVersionSummaries);
const mockGetOpenProposal = vi.mocked(getOpenCoverLetterVersionProposal);
const mockGetVersion = vi.mocked(getCoverLetterVersion);
const PROPOSAL = "77777777-7777-7777-7777-777777777777";

const SECRET = "test-jwt-secret-value";
const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";
const CANDIDACY = "33333333-3333-3333-3333-333333333333";
const VERSION = "55555555-5555-5555-5555-555555555555";

const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
function signJwt(sub: string): string {
  const header = b64url({ alg: "HS256", typ: "JWT" });
  const body = b64url({ sub, aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 });
  const sig = createHmac("sha256", SECRET).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}
const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

const candidacy = (userId: string): Candidacy =>
  ({ id: CANDIDACY, user_id: userId, status: "drafting" }) as Candidacy;

const summaries: CoverLetterVersionSummary[] = [
  {
    id: VERSION,
    version_no: 1,
    status: "superseded",
    label: "first pass",
    created_at: "2026-06-24T00:00:00Z",
  },
  {
    id: "66666666-6666-6666-6666-666666666666",
    version_no: 2,
    status: "approved",
    label: null,
    created_at: "2026-06-24T01:00:00Z",
  },
];

const version = (userId: string): CoverLetterVersion =>
  ({
    id: VERSION,
    candidacy_id: CANDIDACY,
    user_id: userId,
    version_no: 2,
    status: "approved",
    label: null,
    content: "Dear hiring manager, ...",
    details: { spoken_note: { audioUrl: "https://cdn.example/note.mp3", provider: "elevenlabs" } },
    created_at: "2026-06-24T01:00:00Z",
    updated_at: "2026-06-24T01:00:00Z",
  }) as unknown as CoverLetterVersion;

describe("GET /candidacies/{id}/cover-letters (ARC-145)", () => {
  beforeEach(() => {
    delete process.env.ARCHER_API_DEV_OPEN;
    delete process.env.ARCHER_API_SECRET;
    delete process.env.ARCHER_USER_ID;
    delete process.env.SUPABASE_URL;
    process.env.SUPABASE_JWT_SECRET = SECRET;
    mockGetCandidacy.mockReset();
    mockListSummaries.mockReset();
    mockGetOpenProposal.mockReset();
    mockGetOpenProposal.mockResolvedValue(null);
  });
  afterEach(() => {
    delete process.env.SUPABASE_JWT_SECRET;
  });

  it("returns the version history for the owner (200)", async () => {
    mockGetCandidacy.mockResolvedValue(candidacy(USER_A));
    mockListSummaries.mockResolvedValue(summaries);
    const res = await app.request(
      `/candidacies/${CANDIDACY}/cover-letters`,
      bearer(signJwt(USER_A)),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { versions: CoverLetterVersionSummary[] };
    expect(body.versions).toEqual(summaries);
    expect(mockListSummaries).toHaveBeenCalledWith(expect.anything(), CANDIDACY);
  });

  it("carries the open proposal id + target version when one is awaiting a decision (ARC-150)", async () => {
    mockGetCandidacy.mockResolvedValue(candidacy(USER_A));
    mockListSummaries.mockResolvedValue(summaries);
    mockGetOpenProposal.mockResolvedValue({ proposalId: PROPOSAL, versionId: VERSION });
    const res = await app.request(
      `/candidacies/${CANDIDACY}/cover-letters`,
      bearer(signJwt(USER_A)),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      openProposalId: string | null;
      proposedVersionId: string | null;
    };
    expect(body.openProposalId).toBe(PROPOSAL);
    expect(body.proposedVersionId).toBe(VERSION);
    expect(mockGetOpenProposal).toHaveBeenCalledWith(expect.anything(), CANDIDACY);
  });

  it("reports a null open proposal when none is awaiting a decision", async () => {
    mockGetCandidacy.mockResolvedValue(candidacy(USER_A));
    mockListSummaries.mockResolvedValue(summaries);
    mockGetOpenProposal.mockResolvedValue(null);
    const res = await app.request(
      `/candidacies/${CANDIDACY}/cover-letters`,
      bearer(signJwt(USER_A)),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { openProposalId: string | null };
    expect(body.openProposalId).toBeNull();
  });

  it("404s an unknown candidacy (and does not list)", async () => {
    mockGetCandidacy.mockResolvedValue(undefined);
    const res = await app.request(
      `/candidacies/${CANDIDACY}/cover-letters`,
      bearer(signJwt(USER_A)),
    );
    expect(res.status).toBe(404);
    expect(mockListSummaries).not.toHaveBeenCalled();
  });

  it("403s another user's candidacy (no cross-user read)", async () => {
    mockGetCandidacy.mockResolvedValue(candidacy(USER_B));
    const res = await app.request(
      `/candidacies/${CANDIDACY}/cover-letters`,
      bearer(signJwt(USER_A)),
    );
    expect(res.status).toBe(403);
    expect(mockListSummaries).not.toHaveBeenCalled();
  });

  it("fails closed: 401 with no token", async () => {
    const res = await app.request(`/candidacies/${CANDIDACY}/cover-letters`);
    expect(res.status).toBe(401);
    expect(mockGetCandidacy).not.toHaveBeenCalled();
  });
});

describe("GET /cover-letters/{versionId} (ARC-145)", () => {
  beforeEach(() => {
    delete process.env.ARCHER_API_DEV_OPEN;
    delete process.env.ARCHER_API_SECRET;
    delete process.env.ARCHER_USER_ID;
    delete process.env.SUPABASE_URL;
    process.env.SUPABASE_JWT_SECRET = SECRET;
    mockGetVersion.mockReset();
  });
  afterEach(() => {
    delete process.env.SUPABASE_JWT_SECRET;
  });

  it("returns the full version incl. spoken-note artifact for the owner (200)", async () => {
    mockGetVersion.mockResolvedValue(version(USER_A));
    const res = await app.request(`/cover-letters/${VERSION}`, bearer(signJwt(USER_A)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: CoverLetterVersion };
    expect(body.version).toEqual(version(USER_A));
    expect(mockGetVersion).toHaveBeenCalledWith(expect.anything(), VERSION);
  });

  it("404s an unknown version", async () => {
    mockGetVersion.mockResolvedValue(undefined);
    const res = await app.request(`/cover-letters/${VERSION}`, bearer(signJwt(USER_A)));
    expect(res.status).toBe(404);
  });

  it("403s another user's version (no cross-user read)", async () => {
    mockGetVersion.mockResolvedValue(version(USER_B));
    const res = await app.request(`/cover-letters/${VERSION}`, bearer(signJwt(USER_A)));
    expect(res.status).toBe(403);
  });

  it("fails closed: 401 with no token", async () => {
    const res = await app.request(`/cover-letters/${VERSION}`);
    expect(res.status).toBe(401);
    expect(mockGetVersion).not.toHaveBeenCalled();
  });
});
