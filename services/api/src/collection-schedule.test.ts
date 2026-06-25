import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// GET /collection/schedule serves the ONE declared collection schedule (ARC-171) so
// the dashboard can render the real next/last run. Stub the pool + the last-run read so
// the test stays hermetic — the point under test is the route's shape (schedule cron +
// a computed next fire + the user's last run) and that it requires auth.
vi.mock("./db.js", () => ({ getDb: () => ({}) }));
vi.mock("@archer/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archer/db")>();
  return {
    ...actual,
    getLastCollectRunAt: vi.fn(async () => "2026-06-24T06:01:00.000Z"),
  };
});

const app = (await import("./app")).default;
const USER = "5cd494a2-32f1-4dea-9397-bd430123b015";

describe("GET /collection/schedule (ARC-171)", () => {
  beforeEach(() => {
    // Dev opt-in so the read is reachable without a shared secret; the service
    // principal resolves to ARCHER_USER_ID for the user-scoped last-run read.
    process.env.ARCHER_API_DEV_OPEN = "1";
    process.env.ARCHER_USER_ID = USER;
    delete process.env.ARCHER_API_SECRET;
  });
  afterEach(() => {
    delete process.env.ARCHER_API_DEV_OPEN;
    delete process.env.ARCHER_USER_ID;
  });

  it("serves the declared cron, a computed next run, and the user's last run", async () => {
    const res = await app.request("/collection/schedule");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: string;
      schedule: string;
      nextRunAt: string;
      lastRunAt: string | null;
    };
    expect(body.user).toBe(USER);
    expect(body.schedule).toBe("0 6 * * 1-5");
    expect(body.lastRunAt).toBe("2026-06-24T06:01:00.000Z");
    // Next run is a real future instant at the declared 06:00 UTC fire time.
    expect(body.nextRunAt).toMatch(/T06:00:00\.000Z$/);
    expect(new Date(body.nextRunAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("fails closed: denies the read with no secret and no dev opt-in", async () => {
    delete process.env.ARCHER_API_DEV_OPEN;
    const res = await app.request("/collection/schedule");
    expect(res.status).toBe(401);
  });
});
