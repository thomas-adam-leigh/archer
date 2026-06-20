import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "./app";

const VALID_UUID = "00000000-0000-0000-0000-000000000000";
const post = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...headers },
});

describe("archer-api", () => {
  beforeEach(() => {
    // Dev opt-in so command/webhook routes are reachable without a shared secret.
    process.env.ARCHER_API_DEV_OPEN = "1";
    delete process.env.ARCHER_API_SECRET;
  });
  afterEach(() => {
    delete process.env.ARCHER_API_DEV_OPEN;
    delete process.env.ARCHER_API_SECRET;
  });

  it("GET /health returns ok", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("GET / returns the service identity", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "archer-api", status: "ok" });
  });

  it("rejects an invalid board (argv-injection guard)", async () => {
    const res = await app.request("/commands/collect/-evil", post({}));
    expect(res.status).toBe(400);
  });

  it("rejects an invalid candidacy id", async () => {
    const res = await app.request(
      "/commands/candidacies/not-a-uuid/transition",
      post({ to: "shortlisted" }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an invalid transition status", async () => {
    const res = await app.request(
      `/commands/candidacies/${VALID_UUID}/transition`,
      post({ to: "nope" }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an agui run with a missing or invalid threadId", async () => {
    const missing = await app.request("/agui/run", post({}));
    expect(missing.status).toBe(400);
    const bad = await app.request("/agui/run", post({ threadId: "not-a-uuid" }));
    expect(bad.status).toBe(400);
  });

  it("fails closed: denies /agui/run with no secret and no dev opt-in", async () => {
    delete process.env.ARCHER_API_DEV_OPEN;
    const res = await app.request("/agui/run", post({ threadId: VALID_UUID }));
    expect(res.status).toBe(401);
  });

  it("fails closed: denies commands with no secret and no dev opt-in", async () => {
    delete process.env.ARCHER_API_DEV_OPEN;
    const res = await app.request("/hooks/activity-failed", post({}));
    expect(res.status).toBe(401);
  });

  it("gates webhooks behind the shared secret when configured", async () => {
    delete process.env.ARCHER_API_DEV_OPEN;
    process.env.ARCHER_API_SECRET = "s3cret";
    const noAuth = await app.request("/hooks/external-form", post({}));
    expect(noAuth.status).toBe(401);
    const withAuth = await app.request(
      "/hooks/external-form",
      post({}, { "x-archer-secret": "s3cret" }),
    );
    expect(withAuth.status).toBe(202);
  });

  it("allows webhooks with the dev opt-in", async () => {
    const res = await app.request("/hooks/activity-failed", post({}));
    expect(res.status).toBe(202);
  });
});
