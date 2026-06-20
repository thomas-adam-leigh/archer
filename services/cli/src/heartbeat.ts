/**
 * Daily-collect dead-man's-switch (ARC-12).
 *
 * Archer's promise is "it runs every weekday at 13:00." A silent collect failure
 * is worse than a loud one, so rather than alerting when something breaks we alert
 * when an expected check-in is MISSING: an Uptime Kuma Push monitor with a >24h
 * heartbeat interval. A successful collect pings its push URL; if 13:00 passes and
 * no ping lands within the window, Kuma fires — you learn the collect broke that
 * day, not when a user notices empty results. See infra/observability/README.md.
 *
 * Best-effort by contract: a missing URL is a silent skip, and a failed push never
 * throws — the switch that watches the collect must never break the collect.
 */

export interface HeartbeatResult {
  /** Whether a push was attempted (i.e. a push URL was configured). */
  pushed: boolean;
  /** Whether the monitor accepted the push (only meaningful when `pushed`). */
  ok?: boolean;
  /** A non-throwing failure reason: a URL was configured but the push didn't land. */
  error?: string;
}

export interface HeartbeatOpts {
  /** The Uptime Kuma push URL; defaults to `UPTIME_KUMA_PUSH_URL`. */
  url?: string;
  /** Monitor status to report (default "up"). */
  status?: "up" | "down";
  /** Short message shown in Kuma (default "collect-ok"). */
  msg?: string;
  /** Abort the push after this many ms so a hung monitor never stalls collect. */
  timeoutMs?: number;
  /** Injectable fetch for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Ping the Uptime Kuma push monitor that a collect ran. Mirrors the documented
 * `curl -fsS "$UPTIME_KUMA_PUSH_URL?status=up&msg=collect-ok"`. Never throws.
 */
export async function pushHeartbeat(opts: HeartbeatOpts = {}): Promise<HeartbeatResult> {
  const url = opts.url ?? process.env.UPTIME_KUMA_PUSH_URL;
  if (!url) return { pushed: false };

  const status = opts.status ?? "up";
  const msg = opts.msg ?? "collect-ok";
  const target = `${url}?status=${status}&msg=${encodeURIComponent(msg)}`;
  const doFetch = opts.fetchImpl ?? fetch;

  try {
    const res = await doFetch(target, { signal: AbortSignal.timeout(opts.timeoutMs ?? 5000) });
    return res.ok
      ? { pushed: true, ok: true }
      : { pushed: true, ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    return { pushed: true, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
