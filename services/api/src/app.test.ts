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

  it("rejects an invalid company id for enrich (argv-injection guard)", async () => {
    const res = await app.request("/commands/enrich/not-a-uuid", post({}));
    expect(res.status).toBe(400);
  });

  it("fails closed: denies /commands/enrich with no secret and no dev opt-in", async () => {
    delete process.env.ARCHER_API_DEV_OPEN;
    const res = await app.request(`/commands/enrich/${VALID_UUID}`, post({}));
    expect(res.status).toBe(401);
  });

  it("rejects /commands/match with an invalid user", async () => {
    const res = await app.request("/commands/match?user=not-a-uuid", post({}));
    expect(res.status).toBe(400);
  });

  it("fails closed: denies /commands/match with no secret and no dev opt-in", async () => {
    delete process.env.ARCHER_API_DEV_OPEN;
    const res = await app.request("/commands/match", post({}));
    expect(res.status).toBe(401);
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

  it("GET /jobs rejects a missing or invalid user", async () => {
    const missing = await app.request("/jobs");
    expect(missing.status).toBe(400);
    const bad = await app.request("/jobs?user=not-a-uuid");
    expect(bad.status).toBe(400);
  });

  it("GET /jobs rejects an invalid status filter", async () => {
    const res = await app.request(`/jobs?user=${VALID_UUID}&status=nope`);
    expect(res.status).toBe(400);
  });

  it("fails closed: denies GET /jobs with no secret and no dev opt-in", async () => {
    delete process.env.ARCHER_API_DEV_OPEN;
    const res = await app.request(`/jobs?user=${VALID_UUID}`);
    expect(res.status).toBe(401);
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

  it("rejects a cover-letter run with a missing/invalid threadId or candidacyId", async () => {
    expect((await app.request("/cover-letters/run", post({}))).status).toBe(400);
    expect(
      (await app.request("/cover-letters/run", post({ threadId: "nope", candidacyId: VALID_UUID })))
        .status,
    ).toBe(400);
    expect((await app.request("/cover-letters/run", post({ threadId: VALID_UUID }))).status).toBe(
      400,
    );
  });

  it("fails closed: denies /cover-letters/run with no secret and no dev opt-in", async () => {
    delete process.env.ARCHER_API_DEV_OPEN;
    const res = await app.request(
      "/cover-letters/run",
      post({ threadId: VALID_UUID, candidacyId: VALID_UUID }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a cover-letter submit with a missing/invalid threadId or candidacyId", async () => {
    expect((await app.request("/cover-letters/submit", post({}))).status).toBe(400);
    expect(
      (
        await app.request(
          "/cover-letters/submit",
          post({ threadId: "nope", candidacyId: VALID_UUID }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await app.request("/cover-letters/submit", post({ threadId: VALID_UUID }))).status,
    ).toBe(400);
  });

  it("fails closed: denies /cover-letters/submit with no secret and no dev opt-in", async () => {
    delete process.env.ARCHER_API_DEV_OPEN;
    const res = await app.request(
      "/cover-letters/submit",
      post({ threadId: VALID_UUID, candidacyId: VALID_UUID }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a cover-letter decide with an invalid proposal id or action", async () => {
    expect(
      (await app.request("/cover-letters/proposals/not-a-uuid/decide", post({ action: "approve" })))
        .status,
    ).toBe(400);
    expect(
      (await app.request(`/cover-letters/proposals/${VALID_UUID}/decide`, post({ action: "nope" })))
        .status,
    ).toBe(400);
  });

  it("fails closed: denies /cover-letters decide with no secret and no dev opt-in", async () => {
    delete process.env.ARCHER_API_DEV_OPEN;
    const res = await app.request(
      `/cover-letters/proposals/${VALID_UUID}/decide`,
      post({ action: "approve" }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects history restore for an invalid threadId", async () => {
    const res = await app.request("/agui/threads/not-a-uuid/history");
    expect(res.status).toBe(400);
  });

  it("fails closed: denies history restore with no secret and no dev opt-in", async () => {
    delete process.env.ARCHER_API_DEV_OPEN;
    const res = await app.request(`/agui/threads/${VALID_UUID}/history`);
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

  it("rejects resume ingest with an invalid user", async () => {
    const res = await app.request(
      "/onboarding/resume",
      post({ userId: "not-a-uuid", storageRef: "s3://uploads/cv.pdf" }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects resume ingest with a missing storageRef", async () => {
    const res = await app.request("/onboarding/resume", post({ userId: VALID_UUID }));
    expect(res.status).toBe(400);
  });

  it("fails closed: denies resume ingest with no secret and no dev opt-in", async () => {
    delete process.env.ARCHER_API_DEV_OPEN;
    const res = await app.request(
      "/onboarding/resume",
      post({ userId: VALID_UUID, storageRef: "s3://uploads/cv.pdf" }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects voicenote ingest with an invalid threadId", async () => {
    const res = await app.request(
      "/onboarding/voicenote",
      post({ threadId: "not-a-uuid", storageRef: "s3://uploads/note.m4a" }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects voicenote ingest with a missing storageRef", async () => {
    const res = await app.request("/onboarding/voicenote", post({ threadId: VALID_UUID }));
    expect(res.status).toBe(400);
  });

  it("fails closed: denies voicenote ingest with no secret and no dev opt-in", async () => {
    delete process.env.ARCHER_API_DEV_OPEN;
    const res = await app.request(
      "/onboarding/voicenote",
      post({ threadId: VALID_UUID, storageRef: "s3://uploads/note.m4a" }),
    );
    expect(res.status).toBe(401);
  });

  // ── Acceptance gate (ARC-31) ──────────────────────────────────────────────
  it("rejects account state read with an invalid user", async () => {
    const res = await app.request("/accounts/state?user=not-a-uuid");
    expect(res.status).toBe(400);
  });

  it("fails closed: denies account state read with no secret and no dev opt-in", async () => {
    delete process.env.ARCHER_API_DEV_OPEN;
    const res = await app.request(`/accounts/state?user=${VALID_UUID}`);
    expect(res.status).toBe(401);
  });

  it("rejects account submit with an invalid user", async () => {
    const res = await app.request("/accounts/submit", post({ userId: "not-a-uuid" }));
    expect(res.status).toBe(400);
  });

  it("rejects an account decision with an invalid user", async () => {
    const res = await app.request("/accounts/not-a-uuid/decide", post({ action: "accept" }));
    expect(res.status).toBe(400);
  });

  it("rejects an account decision with an invalid action", async () => {
    const res = await app.request(`/accounts/${VALID_UUID}/decide`, post({ action: "nope" }));
    expect(res.status).toBe(400);
  });

  it("fails closed: denies an account decision with no secret and no dev opt-in", async () => {
    delete process.env.ARCHER_API_DEV_OPEN;
    const res = await app.request(`/accounts/${VALID_UUID}/decide`, post({ action: "accept" }));
    expect(res.status).toBe(401);
  });
});
