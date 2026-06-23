import { describe, expect, it, vi } from "vitest";
import { RESUME_URL_TTL_SECONDS, ResumeSignError, signResumeUrl } from "./sign.js";

// Unit tests for durable résumé-URL minting (ARC-131). The Storage sign call is
// MOCKED — the suite never reaches Supabase — so they assert the request shape
// (service-role POST to the sign endpoint with an expiry) and that the relative
// `signedURL` is returned as an absolute URL, plus every failure mode.

const SUPABASE_URL = "https://proj.supabase.co";
const KEY = "service-role-key";

describe("signResumeUrl", () => {
  it("POSTs to the bucket-scoped sign endpoint and returns an absolute URL", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ signedURL: "/object/sign/resumes/uid/cv.pdf?token=abc" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const url = await signResumeUrl("resumes/uid/cv.pdf", {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: KEY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(url).toBe(`${SUPABASE_URL}/storage/v1/object/sign/resumes/uid/cv.pdf?token=abc`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(`${SUPABASE_URL}/storage/v1/object/sign/resumes/uid/cv.pdf`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(headers.apikey).toBe(KEY);
    expect(JSON.parse(init.body as string)).toEqual({ expiresIn: RESUME_URL_TTL_SECONDS });
  });

  it("strips a leading bucket prefix so the object path is not doubled", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ signedURL: "/object/sign/resumes/uid/cv.pdf?token=x" }), {
          status: 200,
        }),
    );
    // Pass the bare object path (no `resumes/` prefix) — endpoint must still be bucket-scoped once.
    await signResumeUrl("uid/cv.pdf", {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: KEY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const [calledUrl] = fetchImpl.mock.calls[0] as [string];
    expect(calledUrl).toBe(`${SUPABASE_URL}/storage/v1/object/sign/resumes/uid/cv.pdf`);
  });

  it("honours a custom expiry", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ signedURL: "/object/sign/resumes/uid/cv.pdf?token=x" }), {
          status: 200,
        }),
    );
    await signResumeUrl("resumes/uid/cv.pdf", {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: KEY,
      expiresIn: 3600,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ expiresIn: 3600 });
  });

  it("uses an injected signer when provided (no network)", async () => {
    const url = await signResumeUrl("resumes/uid/cv.pdf", {
      sign: async (ref) => `https://signed.example/${ref}`,
    });
    expect(url).toBe("https://signed.example/resumes/uid/cv.pdf");
  });

  it("throws a typed error on a non-2xx sign response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 403 }));
    await expect(
      signResumeUrl("resumes/uid/cv.pdf", {
        supabaseUrl: SUPABASE_URL,
        serviceRoleKey: KEY,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ name: "ResumeSignError", status: 403 });
  });

  it("throws when the response carries no signedURL", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    await expect(
      signResumeUrl("resumes/uid/cv.pdf", {
        supabaseUrl: SUPABASE_URL,
        serviceRoleKey: KEY,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(ResumeSignError);
  });

  it("throws when Supabase config is missing", async () => {
    await expect(
      signResumeUrl("resumes/uid/cv.pdf", { supabaseUrl: "", serviceRoleKey: "" }),
    ).rejects.toBeInstanceOf(ResumeSignError);
  });
});
