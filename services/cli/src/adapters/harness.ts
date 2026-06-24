import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type APIRequestContext,
  type BrowserContext,
  chromium,
  type Page,
  request,
} from "patchright-core";

/**
 * Shared scraping harness (ARC-153) — the board-agnostic substrate every collect
 * adapter sits on, so stealth/proxy/session handling is solved once rather than
 * per board.
 *
 * It is deliberately thin: a per-board persistent browser session through the
 * Decodo residential proxy, plus a proxy-geo probe. Patchright (a stealth-patched
 * Playwright) does the heavy anti-detection lifting (patched `navigator.webdriver`,
 * runtime-leak fixes, etc.) — so the harness adds only the posture that *isn't*
 * automatic: the proxy wiring, a ZA locale/timezone, and a persistent profile dir
 * for cookie/session reuse across runs.
 *
 * ## Local ≠ prod — the Decodo Pretoria proxy is mandatory in prod
 * The dev Mac sits on a South-African residential IP and reaches SA boards cleanly
 * *direct*; the production host (`n8n@computer`, a Hetzner box in Germany) does
 * NOT — its datacenter IP trips geo/anti-bot walls. So every real run routes
 * through `DECODO_PROXY` (a residential proxy exiting in Pretoria/ZA). See
 * `docs/board-integration-harness.md` for the how-to + stealth notes.
 */

/** Playwright/Patchright proxy option, parsed from a `DECODO_PROXY`-style string. */
export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

/**
 * Parse a proxy string into Patchright's `proxy` option. Accepts the shapes Decodo
 * hands out:
 *   - a URL:        `http://user:pass@host:port`  (or `http://host:port`, any scheme)
 *   - colon-joined: `host:port:user:pass`         (or `host:port`)
 * Returns `{ server: "<scheme>//host:port", username?, password? }`. Userinfo is
 * percent-decoded (Decodo passwords can carry `+`/encoded bytes). Throws on a
 * blank/garbage value so a misconfigured proxy fails loudly rather than silently
 * sending board traffic unproxied from a flagged datacenter IP.
 */
export function parseProxy(raw: string): ProxyConfig {
  const value = raw.trim();
  if (!value) throw new Error("proxy string is empty");

  // URL form (has a scheme, or userinfo we can wrap in one).
  if (value.includes("://") || value.includes("@")) {
    const withScheme = value.includes("://") ? value : `http://${value}`;
    let url: URL;
    try {
      url = new URL(withScheme);
    } catch {
      throw new Error(`proxy is not a valid URL: ${maskProxy(value)}`);
    }
    if (!url.hostname || !url.port) {
      throw new Error(`proxy is missing host or port: ${maskProxy(value)}`);
    }
    const cfg: ProxyConfig = { server: `${url.protocol}//${url.hostname}:${url.port}` };
    if (url.username) cfg.username = decodeURIComponent(url.username);
    if (url.password) cfg.password = decodeURIComponent(url.password);
    return cfg;
  }

  // Colon-joined form: host:port[:user:pass].
  const parts = value.split(":");
  if (parts.length === 2) {
    const [host, port] = parts;
    if (!host || !port) throw new Error(`proxy is missing host or port: ${maskProxy(value)}`);
    return { server: `http://${host}:${port}` };
  }
  if (parts.length >= 4) {
    const [host, port, username, ...rest] = parts;
    if (!host || !port) throw new Error(`proxy is missing host or port: ${maskProxy(value)}`);
    return { server: `http://${host}:${port}`, username, password: rest.join(":") };
  }
  throw new Error(`unrecognised proxy format: ${maskProxy(value)}`);
}

/** Redact credentials from a proxy string for safe logging/errors. */
export function maskProxy(raw: string): string {
  return raw.replace(/\/\/[^@/]+@/, "//***@").replace(/^([^:]+:\d+):.+$/, "$1:***");
}

/** Geolocation of a proxy's exit IP, as probed by {@link fetchProxyGeo}. */
export interface ProxyGeo {
  ip?: string;
  country?: string;
  countryCode?: string;
  region?: string;
  city?: string;
}

/** Verdict on whether a proxy exit lands where prod needs it (Pretoria / ZA). */
export interface ProxyGeoVerdict {
  /** Hard requirement: the exit IP is in South Africa. */
  za: boolean;
  /** Preferred: the exit city is Pretoria (the legacy, known-good exit). */
  pretoria: boolean;
  /** `za` — the gate that makes a run safe against SA geo walls. */
  ok: boolean;
  reason: string;
}

/**
 * Judge a proxy's exit geo (pure, so it's unit-tested without the network). ZA is
 * the hard gate — a non-ZA exit means SA boards will geo-block prod, so the run is
 * unsafe. Pretoria is preferred (the legacy known-good exit) but a different ZA
 * city still passes, surfaced as a note rather than a failure.
 */
export function classifyProxyGeo(geo: ProxyGeo): ProxyGeoVerdict {
  const za =
    (geo.countryCode ?? "").toUpperCase() === "ZA" || /south africa/i.test(geo.country ?? "");
  const pretoria = /pretoria/i.test(geo.city ?? "") || /pretoria/i.test(geo.region ?? "");
  const where = [geo.city, geo.region, geo.country].filter(Boolean).join(", ") || "unknown";
  if (!za) return { za, pretoria, ok: false, reason: `exit is not in ZA (geolocated to ${where})` };
  if (!pretoria)
    return { za, pretoria, ok: true, reason: `exit is in ZA but not Pretoria (${where})` };
  return { za, pretoria, ok: true, reason: `exit verified in Pretoria, ZA (${where})` };
}

/**
 * Probe a proxy's exit IP geolocation over the proxy itself (via a lightweight API
 * request, no browser/display needed — so it runs on the headless prod host). Uses
 * ip-api.com's free, token-less endpoint.
 */
export async function fetchProxyGeo(proxy: ProxyConfig): Promise<ProxyGeo> {
  const ctx: APIRequestContext = await request.newContext({ proxy });
  try {
    const res = await ctx.get(
      "http://ip-api.com/json/?fields=status,message,country,countryCode,regionName,city,query",
    );
    if (!res.ok()) throw new Error(`ip-geo probe failed: HTTP ${res.status()}`);
    const body = (await res.json()) as {
      status?: string;
      message?: string;
      query?: string;
      country?: string;
      countryCode?: string;
      regionName?: string;
      city?: string;
    };
    if (body.status && body.status !== "success") {
      throw new Error(`ip-geo probe error: ${body.message ?? body.status}`);
    }
    return {
      ip: body.query,
      country: body.country,
      countryCode: body.countryCode,
      region: body.regionName,
      city: body.city,
    };
  } finally {
    await ctx.dispose();
  }
}

/** Base directory for persistent per-board browser profiles (cookie/session reuse). */
export function sessionBaseDir(): string {
  return process.env.ARCHER_SESSION_DIR ?? join(homedir(), ".archer", "sessions");
}

/**
 * Resolve the persistent-profile directory for a board (pure; no fs side-effects so
 * it's unit-testable). The slug is sanitised to a safe path segment.
 */
export function sessionDir(boardSlug: string, baseDir: string = sessionBaseDir()): string {
  const safe = boardSlug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!safe) throw new Error(`invalid board slug for session dir: '${boardSlug}'`);
  return join(baseDir, safe);
}

/** A live, board-scoped browser session handed to an adapter's scrape body. */
export interface Session {
  context: BrowserContext;
  page: Page;
}

/** What {@link withSession} needs to open a session. */
export interface SessionOptions {
  /** Parsed proxy (omit only for a direct local run; prod must always proxy). */
  proxy?: ProxyConfig;
  /** Headful by default — Patchright's stealth + the legacy setup both run non-headless. */
  headful: boolean;
  /** Board slug; selects the persistent profile dir so cookies/sessions survive runs. */
  sessionKey: string;
  baseDir?: string;
  log?: (msg: string) => void;
}

/**
 * Open a persistent, stealth, optionally-proxied browser session for a board, run
 * `fn` against it, and always close it. Cookies/storage persist in the board's
 * profile dir, so a logged-in session is reused on the next run rather than
 * re-authenticating every time.
 *
 * Posture (the bits Patchright doesn't already auto-patch): a ZA locale + timezone
 * so the browser fingerprint matches a Pretoria exit, and a common desktop viewport.
 * Patchright is launched with its own patched Chromium and minimal flags on purpose
 * — overriding the UA or piling on `--disable-*` args is what gets sessions flagged.
 */
export async function withSession<T>(
  opts: SessionOptions,
  fn: (session: Session) => Promise<T>,
): Promise<T> {
  const dir = sessionDir(opts.sessionKey, opts.baseDir);
  mkdirSync(dir, { recursive: true });
  opts.log?.(
    `harness: launching ${opts.headful ? "headful" : "headless"} session for '${opts.sessionKey}'` +
      `${opts.proxy ? ` via proxy ${opts.proxy.server}` : " (direct, no proxy)"}`,
  );
  const context = await chromium.launchPersistentContext(dir, {
    headless: !opts.headful,
    proxy: opts.proxy,
    locale: "en-ZA",
    timezoneId: "Africa/Johannesburg",
    viewport: { width: 1366, height: 768 },
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    return await fn({ context, page });
  } finally {
    await context.close();
  }
}
