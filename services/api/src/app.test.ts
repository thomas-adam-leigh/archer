import { afterEach, describe, expect, it } from "vitest";
import app from "./app";

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...headers },
});

describe("archer-api", () => {
  afterEach(() => {
    process.env.ARCHER_API_SECRET = undefined;
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

  it("rejects an invalid candidacy transition before touching the DB", async () => {
    const res = await app.request("/commands/candidacies/x/transition", json({ to: "nope" }));
    expect(res.status).toBe(400);
  });

  it("rejects a transition with no target status", async () => {
    const res = await app.request("/commands/candidacies/x/transition", json({}));
    expect(res.status).toBe(400);
  });

  it("gates webhooks behind the shared secret when configured", async () => {
    process.env.ARCHER_API_SECRET = "s3cret";
    const noAuth = await app.request("/hooks/external-form", json({}));
    expect(noAuth.status).toBe(401);
    const withAuth = await app.request(
      "/hooks/external-form",
      json({}, { "x-archer-secret": "s3cret" }),
    );
    expect(withAuth.status).toBe(202);
  });

  it("allows webhooks in dev when no secret is set", async () => {
    const res = await app.request("/hooks/activity-failed", json({}));
    expect(res.status).toBe(202);
  });
});
