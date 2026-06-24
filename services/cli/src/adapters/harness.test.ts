import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyProxyGeo, maskProxy, parseProxy, sessionDir } from "./harness.js";

// The harness's pure surface (ARC-153): proxy parsing, exit-geo judging, and
// session-dir resolution. The live bits (withSession / fetchProxyGeo) need a real
// browser + network and are smoke-tested out-of-band, not here.

describe("parseProxy", () => {
  it("parses the Decodo URL form (http://user:pass@host:port)", () => {
    expect(parseProxy("http://user-sessid-123:secret@gate.decodo.com:7000")).toEqual({
      server: "http://gate.decodo.com:7000",
      username: "user-sessid-123",
      password: "secret",
    });
  });

  it("parses a URL with no credentials", () => {
    expect(parseProxy("http://gate.decodo.com:7000")).toEqual({
      server: "http://gate.decodo.com:7000",
    });
  });

  it("percent-decodes userinfo but leaves '+' intact (Decodo passwords use both)", () => {
    expect(parseProxy("http://u:p%40s+w@host:8080")).toEqual({
      server: "http://host:8080",
      username: "u",
      password: "p@s+w",
    });
  });

  it("wraps a bare user:pass@host:port (no scheme) as http", () => {
    expect(parseProxy("u:p@host:9000")).toEqual({
      server: "http://host:9000",
      username: "u",
      password: "p",
    });
  });

  it("parses the colon-joined host:port form", () => {
    expect(parseProxy("host.example:7000")).toEqual({ server: "http://host.example:7000" });
  });

  it("parses the colon-joined host:port:user:pass form (pass may contain colons)", () => {
    expect(parseProxy("host:7000:user:pa:ss")).toEqual({
      server: "http://host:7000",
      username: "user",
      password: "pa:ss",
    });
  });

  it("throws on an empty value (never silently runs unproxied)", () => {
    expect(() => parseProxy("   ")).toThrow(/empty/);
  });

  it("throws on a URL missing a port", () => {
    expect(() => parseProxy("http://gate.decodo.com")).toThrow(/host or port/);
  });

  it("throws on garbage", () => {
    expect(() => parseProxy("not-a-proxy")).toThrow(/unrecognised/);
  });
});

describe("maskProxy", () => {
  it("redacts credentials in the URL form", () => {
    expect(maskProxy("http://user:secret@host:7000")).toBe("http://***@host:7000");
  });

  it("redacts credentials in the colon-joined form", () => {
    expect(maskProxy("host:7000:user:secret")).toBe("host:7000:***");
  });
});

describe("classifyProxyGeo", () => {
  it("passes and flags Pretoria when the exit is in Pretoria, ZA", () => {
    const v = classifyProxyGeo({ countryCode: "ZA", city: "Pretoria", region: "Gauteng" });
    expect(v).toMatchObject({ za: true, pretoria: true, ok: true });
  });

  it("passes (ZA) but notes a non-Pretoria city", () => {
    const v = classifyProxyGeo({ countryCode: "ZA", city: "Cape Town" });
    expect(v.za).toBe(true);
    expect(v.pretoria).toBe(false);
    expect(v.ok).toBe(true);
    expect(v.reason).toMatch(/not Pretoria/i);
  });

  it("fails when the exit is not in ZA (prod would be geo-blocked)", () => {
    const v = classifyProxyGeo({ countryCode: "DE", country: "Germany", city: "Frankfurt" });
    expect(v).toMatchObject({ za: false, ok: false });
  });

  it("recognises ZA by country name when the code is absent", () => {
    expect(classifyProxyGeo({ country: "South Africa" }).za).toBe(true);
  });

  it("recognises Pretoria from the region when city is absent", () => {
    expect(classifyProxyGeo({ countryCode: "ZA", region: "Pretoria" }).pretoria).toBe(true);
  });
});

describe("sessionDir", () => {
  const prev = process.env.ARCHER_SESSION_DIR;
  afterEach(() => {
    if (prev === undefined) delete process.env.ARCHER_SESSION_DIR;
    else process.env.ARCHER_SESSION_DIR = prev;
  });

  it("defaults under ~/.archer/sessions/<slug>", () => {
    delete process.env.ARCHER_SESSION_DIR;
    expect(sessionDir("careerjunction")).toBe(
      join(homedir(), ".archer", "sessions", "careerjunction"),
    );
  });

  it("honours ARCHER_SESSION_DIR", () => {
    process.env.ARCHER_SESSION_DIR = "/tmp/archer-sessions";
    expect(sessionDir("careerjunction")).toBe("/tmp/archer-sessions/careerjunction");
  });

  it("sanitises the slug to a safe path segment", () => {
    expect(sessionDir("Career Junction!", "/base")).toBe("/base/career-junction");
  });

  it("throws on a slug with no usable characters", () => {
    expect(() => sessionDir("***", "/base")).toThrow(/invalid board slug/);
  });
});
