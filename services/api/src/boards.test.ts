import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// GET /boards reads the boards table (ARC-147). Stub the pool + the one read so the
// test stays hermetic — the point under test is the route's projection (the four
// public columns, internal credential columns stripped) and that it requires auth.
vi.mock("./db.js", () => ({ getDb: () => ({}) }));
vi.mock("@archer/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archer/db")>();
  return {
    ...actual,
    listBoards: vi.fn(async () => [
      {
        slug: "pnet",
        name: "PNet",
        collect_status: "integrated",
        apply_status: "not_integrated",
        base_url: "https://www.pnet.co.za",
        cred_env_prefix: "PNET",
        country: "ZA",
        created_at: "2026-06-20T00:00:00Z",
        updated_at: "2026-06-20T00:00:00Z",
      },
    ]),
  };
});

const app = (await import("./app")).default;

describe("GET /boards (ARC-147)", () => {
  beforeEach(() => {
    // Dev opt-in so the read is reachable without a shared secret.
    process.env.ARCHER_API_DEV_OPEN = "1";
    delete process.env.ARCHER_API_SECRET;
  });
  afterEach(() => {
    delete process.env.ARCHER_API_DEV_OPEN;
  });

  it("returns the seeded boards projected to their public status columns", async () => {
    const res = await app.request("/boards");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      boards: Array<Record<string, unknown>>;
    };
    expect(body.boards).toEqual([
      {
        slug: "pnet",
        name: "PNet",
        collect_status: "integrated",
        apply_status: "not_integrated",
      },
    ]);
    // Internal credential/URL columns must never leak to the dashboard.
    expect(body.boards[0]).not.toHaveProperty("cred_env_prefix");
    expect(body.boards[0]).not.toHaveProperty("base_url");
  });

  it("fails closed: denies the read with no secret and no dev opt-in", async () => {
    delete process.env.ARCHER_API_DEV_OPEN;
    const res = await app.request("/boards");
    expect(res.status).toBe(401);
  });
});
