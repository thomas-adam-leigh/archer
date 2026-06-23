import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app, { assertSecureStartup } from "./app";

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

  it("rejects an invalid candidacy id for apply (argv-injection guard)", async () => {
    const res = await app.request("/commands/apply/not-a-uuid", post({}));
    expect(res.status).toBe(400);
  });

  it("fails closed: denies /commands/apply with no secret and no dev opt-in", async () => {
    delete process.env.ARCHER_API_DEV_OPEN;
    const res = await app.request(`/commands/apply/${VALID_UUID}`, post({}));
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

  it("GET /activities rejects a missing or invalid user", async () => {
    const missing = await app.request("/activities");
    expect(missing.status).toBe(400);
    const bad = await app.request("/activities?user=not-a-uuid");
    expect(bad.status).toBe(400);
  });

  it("GET /activities rejects an invalid type filter", async () => {
    const res = await app.request(`/activities?user=${VALID_UUID}&type=nope`);
    expect(res.status).toBe(400);
  });

  it("GET /activities rejects an invalid status filter", async () => {
    const res = await app.request(`/activities?user=${VALID_UUID}&status=nope`);
    expect(res.status).toBe(400);
  });

  it("fails closed: denies GET /activities with no secret and no dev opt-in", async () => {
    delete process.env.ARCHER_API_DEV_OPEN;
    const res = await app.request(`/activities?user=${VALID_UUID}`);
    expect(res.status).toBe(401);
  });

  it("GET /admin/activities rejects an invalid type filter", async () => {
    const res = await app.request("/admin/activities?type=nope");
    expect(res.status).toBe(400);
  });

  it("GET /admin/activities rejects an invalid status filter", async () => {
    const res = await app.request("/admin/activities?status=nope");
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

  it("rejects a spoken-note request with a missing/invalid threadId or versionId", async () => {
    expect((await app.request("/cover-letters/spoken-note", post({}))).status).toBe(400);
    expect(
      (
        await app.request(
          "/cover-letters/spoken-note",
          post({ threadId: "nope", versionId: VALID_UUID }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await app.request("/cover-letters/spoken-note", post({ threadId: VALID_UUID }))).status,
    ).toBe(400);
  });

  it("fails closed: denies /cover-letters/spoken-note with no secret and no dev opt-in", async () => {
    delete process.env.ARCHER_API_DEV_OPEN;
    const res = await app.request(
      "/cover-letters/spoken-note",
      post({ threadId: VALID_UUID, versionId: VALID_UUID }),
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

  it("rejects resume ingest with an invalid threadId", async () => {
    const res = await app.request(
      "/onboarding/resume",
      post({ threadId: "not-a-uuid", storageRef: "s3://uploads/cv.pdf" }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects resume ingest with a missing storageRef", async () => {
    const res = await app.request("/onboarding/resume", post({ threadId: VALID_UUID }));
    expect(res.status).toBe(400);
  });

  it("fails closed: denies resume ingest with no secret and no dev opt-in", async () => {
    delete process.env.ARCHER_API_DEV_OPEN;
    const res = await app.request(
      "/onboarding/resume",
      post({ threadId: VALID_UUID, storageRef: "s3://uploads/cv.pdf" }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects guided onboarding with an invalid threadId", async () => {
    const res = await app.request("/onboarding/guided", post({ threadId: "not-a-uuid" }));
    expect(res.status).toBe(400);
  });

  it("fails closed: denies guided onboarding with no secret and no dev opt-in", async () => {
    delete process.env.ARCHER_API_DEV_OPEN;
    const res = await app.request("/onboarding/guided", post({ threadId: VALID_UUID }));
    expect(res.status).toBe(401);
  });

  it("rejects draft revision with an invalid threadId", async () => {
    const res = await app.request(
      "/onboarding/revise",
      post({ threadId: "not-a-uuid", feedback: "add Go to my skills" }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects draft revision with empty feedback", async () => {
    const res = await app.request(
      "/onboarding/revise",
      post({ threadId: VALID_UUID, feedback: "" }),
    );
    expect(res.status).toBe(400);
  });

  it("fails closed: denies draft revision with no secret and no dev opt-in", async () => {
    delete process.env.ARCHER_API_DEV_OPEN;
    const res = await app.request(
      "/onboarding/revise",
      post({ threadId: VALID_UUID, feedback: "add Go to my skills" }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects voicenote ingest with an invalid threadId", async () => {
    const res = await app.request(
      "/onboarding/voicenote",
      post({ threadId: "not-a-uuid", transcript: "a spoken note" }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects voicenote ingest with a missing transcript", async () => {
    const res = await app.request("/onboarding/voicenote", post({ threadId: VALID_UUID }));
    expect(res.status).toBe(400);
  });

  it("fails closed: denies voicenote ingest with no secret and no dev opt-in", async () => {
    delete process.env.ARCHER_API_DEV_OPEN;
    const res = await app.request(
      "/onboarding/voicenote",
      post({ threadId: VALID_UUID, transcript: "a spoken note" }),
    );
    expect(res.status).toBe(401);
  });

  // ── Title suggestion + approval (ARC-68) ──────────────────────────────────
  it("rejects title suggestion with no resolvable user", async () => {
    delete process.env.ARCHER_USER_ID;
    const res = await app.request("/onboarding/titles/suggest", post({}));
    expect(res.status).toBe(400);
  });

  it("fails closed: denies title suggestion with no secret and no dev opt-in", async () => {
    delete process.env.ARCHER_API_DEV_OPEN;
    const res = await app.request("/onboarding/titles/suggest", post({ userId: VALID_UUID }));
    expect(res.status).toBe(401);
  });

  it("rejects title approval with an empty title set", async () => {
    const res = await app.request(
      "/onboarding/titles/approve",
      post({ userId: VALID_UUID, titles: ["  "] }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects title approval with more than 5 titles", async () => {
    const res = await app.request(
      "/onboarding/titles/approve",
      post({ userId: VALID_UUID, titles: ["a", "b", "c", "d", "e", "f"] }),
    );
    expect(res.status).toBe(400);
  });

  it("fails closed: denies title approval with no secret and no dev opt-in", async () => {
    delete process.env.ARCHER_API_DEV_OPEN;
    const res = await app.request(
      "/onboarding/titles/approve",
      post({ userId: VALID_UUID, titles: ["Engineer"] }),
    );
    expect(res.status).toBe(401);
  });

  // ── Onboarding progress (ARC-66) ──────────────────────────────────────────
  it("rejects onboarding progress read with an invalid user", async () => {
    const res = await app.request("/onboarding/progress?user=not-a-uuid");
    expect(res.status).toBe(400);
  });

  it("fails closed: denies onboarding progress read with no secret and no dev opt-in", async () => {
    delete process.env.ARCHER_API_DEV_OPEN;
    const res = await app.request(`/onboarding/progress?user=${VALID_UUID}`);
    expect(res.status).toBe(401);
  });

  // ── Onboarding completion → Acceptance Gate (ARC-69) ──────────────────────
  it("rejects onboarding completion with no resolvable user", async () => {
    delete process.env.ARCHER_USER_ID;
    const res = await app.request("/onboarding/complete", post({}));
    expect(res.status).toBe(400);
  });

  it("fails closed: denies onboarding completion with no secret and no dev opt-in", async () => {
    delete process.env.ARCHER_API_DEV_OPEN;
    const res = await app.request("/onboarding/complete", post({ userId: VALID_UUID }));
    expect(res.status).toBe(401);
  });

  // ── Candidate self-approval (ARC-67) ──────────────────────────────────────
  // The self-serve decide route is reachable with the SERVICE secret (no owner
  // admin secret), unlike the owner-gated /onboarding/proposals/:id/decide.
  it("rejects a self-decision with an invalid user", async () => {
    const res = await app.request(
      `/onboarding/proposals/${VALID_UUID}/decide/self`,
      post({ userId: "not-a-uuid", action: "approve" }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a self-decision with an invalid action", async () => {
    const res = await app.request(
      `/onboarding/proposals/${VALID_UUID}/decide/self`,
      post({ userId: VALID_UUID, action: "nope" }),
    );
    expect(res.status).toBe(400);
  });

  it("fails closed: denies a self-decision with no secret and no dev opt-in", async () => {
    delete process.env.ARCHER_API_DEV_OPEN;
    const res = await app.request(
      `/onboarding/proposals/${VALID_UUID}/decide/self`,
      post({ userId: VALID_UUID, action: "approve" }),
    );
    expect(res.status).toBe(401);
  });

  it("self-decision clears the gate with the service secret alone (not owner-gated)", async () => {
    delete process.env.ARCHER_API_DEV_OPEN;
    process.env.ARCHER_API_SECRET = "s3cret";
    // Past the service gate an invalid action is a 400 — proving no admin secret
    // is required (the owner decide route 401s the same service-only caller).
    const res = await app.request(
      `/onboarding/proposals/${VALID_UUID}/decide/self`,
      post({ userId: VALID_UUID, action: "nope" }, { "x-archer-secret": "s3cret" }),
    );
    expect(res.status).toBe(400);
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

  // ── Owner/admin gate (ARC-51) ──────────────────────────────────────────────
  // The human-decision routes (account acceptance + the profile/cover-letter
  // version approvals) require a SEPARATE owner credential, not the general
  // service secret: a caller holding only the service secret is rejected.
  describe("owner/admin gate", () => {
    const OWNER_ROUTES = [
      `/accounts/${VALID_UUID}/decide`,
      `/onboarding/proposals/${VALID_UUID}/decide`,
      `/cover-letters/proposals/${VALID_UUID}/decide`,
    ];
    beforeEach(() => {
      delete process.env.ARCHER_API_DEV_OPEN;
      process.env.ARCHER_API_SECRET = "s3cret";
      process.env.ARCHER_API_ADMIN_SECRET = "0wner";
    });
    afterEach(() => {
      delete process.env.ARCHER_API_ADMIN_SECRET;
    });

    for (const route of OWNER_ROUTES) {
      it(`rejects a non-owner holding only the service secret: ${route}`, async () => {
        const res = await app.request(
          route,
          post({ action: "review" }, { "x-archer-secret": "s3cret" }),
        );
        expect(res.status).toBe(401);
      });

      it(`admits the owner holding the admin secret: ${route}`, async () => {
        // Past auth an invalid action is a 400 — proving the owner cleared the
        // gate (a non-owner is rejected at 401 before any validation).
        const res = await app.request(
          route,
          post({ action: "nope" }, { "x-archer-admin-secret": "0wner" }),
        );
        expect(res.status).toBe(400);
      });
    }
  });

  // ── Operator/admin activity view gate (ARC-44) ─────────────────────────────
  // The system-level activity feed is owner-gated like the decide routes: a caller
  // holding only the general service secret is rejected before any DB read.
  describe("operator/admin activities gate", () => {
    beforeEach(() => {
      delete process.env.ARCHER_API_DEV_OPEN;
      process.env.ARCHER_API_SECRET = "s3cret";
      process.env.ARCHER_API_ADMIN_SECRET = "0wner";
    });
    afterEach(() => {
      delete process.env.ARCHER_API_ADMIN_SECRET;
    });

    it("rejects a non-owner holding only the service secret", async () => {
      const res = await app.request("/admin/activities", {
        headers: { "x-archer-secret": "s3cret" },
      });
      expect(res.status).toBe(401);
    });

    it("rejects a caller with no credentials", async () => {
      const res = await app.request("/admin/activities");
      expect(res.status).toBe(401);
    });
  });

  // ── OpenAPI document + Scalar reference (ARC-52) ───────────────────────────
  describe("OpenAPI surface", () => {
    it("serves a valid OpenAPI document at /openapi.json", async () => {
      const res = await app.request("/openapi.json");
      expect(res.status).toBe(200);
      const doc = (await res.json()) as {
        openapi: string;
        info: { title: string };
        paths: Record<string, unknown>;
        components?: { securitySchemes?: Record<string, unknown> };
      };
      expect(doc.openapi).toMatch(/^3\./);
      expect(doc.info.title).toBe("Archer API");
      // The document covers the real surface and both auth schemes are declared.
      expect(Object.keys(doc.paths).length).toBeGreaterThan(20);
      expect(doc.paths["/agui/run"]).toBeDefined();
      expect(Object.keys(doc.components?.securitySchemes ?? {})).toEqual(
        expect.arrayContaining(["serviceSecret", "ownerSecret"]),
      );
      // The operator activity view (ARC-44) is documented and owner-secured.
      const adminGet = (doc.paths["/admin/activities"] as { get?: { security?: unknown[] } })?.get;
      expect(adminGet).toBeDefined();
      expect(adminGet?.security).toEqual([{ ownerSecret: [] }]);
    });

    it("renders the Scalar reference at /reference", async () => {
      const res = await app.request("/reference");
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html.toLowerCase()).toContain("scalar");
    });

    it("validates request bodies via zod (zod-openapi → 400)", async () => {
      // A bad enum on a validated body is rejected by the schema, not the handler.
      const res = await app.request(
        `/commands/candidacies/${VALID_UUID}/transition`,
        post({ to: "definitely-not-a-status" }),
      );
      expect(res.status).toBe(400);
    });
  });
});

describe("CORS for the browser web client (ARC-120)", () => {
  const preflight = (origin: string) =>
    app.request("/onboarding/progress", {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "Authorization",
      },
    });

  it("reflects an allowed origin on the OPTIONS preflight", async () => {
    const res = await preflight("http://localhost:3000");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3000");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });

  it("does not allow a disallowed origin", async () => {
    const res = await preflight("https://evil.example.com");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("honours additional origins from ARCHER_WEB_ORIGINS", async () => {
    process.env.ARCHER_WEB_ORIGINS = "https://app.archer.careers, https://staging.archer.careers";
    try {
      const res = await preflight("https://app.archer.careers");
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.archer.careers");
    } finally {
      delete process.env.ARCHER_WEB_ORIGINS;
    }
  });

  it("leaves server-to-server requests (no Origin) unaffected", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("assertSecureStartup (fail-closed in prod, ARC-55)", () => {
  it("throws in production when ARCHER_API_SECRET is unset", () => {
    expect(() => assertSecureStartup({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(
      /ARCHER_API_SECRET/,
    );
  });

  it("does not throw in production when ARCHER_API_SECRET is set", () => {
    expect(() =>
      assertSecureStartup({ NODE_ENV: "production", ARCHER_API_SECRET: "s" } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it("does not throw outside production (preserves dev startup)", () => {
    expect(() =>
      assertSecureStartup({ NODE_ENV: "development" } as NodeJS.ProcessEnv),
    ).not.toThrow();
    expect(() => assertSecureStartup({} as NodeJS.ProcessEnv)).not.toThrow();
  });
});
