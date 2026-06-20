import { describe, expect, it, vi } from "vitest";
import { pushHeartbeat } from "./heartbeat.js";

// ARC-12 — the daily-collect dead-man's-switch. A successful collect pings an
// Uptime Kuma Push monitor; its ABSENCE (not its failure) is what alerts. The
// helper is best-effort by contract: a missing URL is a silent skip, and a failed
// push never throws — observability must never break the collect it observes.
// Pure + fetch-injected, so it runs in the default no-DB CI vitest pass.
describe("pushHeartbeat — daily-collect dead-man's-switch", () => {
  it("is a silent skip when no push URL is configured (no fetch)", async () => {
    const fetchImpl = vi.fn();
    const r = await pushHeartbeat({ url: undefined, fetchImpl: fetchImpl as never });
    expect(r).toEqual({ pushed: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("GETs the push URL with status + url-encoded msg, reporting ok", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const r = await pushHeartbeat({
      url: "https://kuma.test/api/push/abc",
      msg: "collect-ok:careerjunction",
      fetchImpl: fetchImpl as never,
    });
    expect(r).toEqual({ pushed: true, ok: true });
    const target = (fetchImpl.mock.calls[0]?.[0] as string) ?? "";
    expect(target).toBe("https://kuma.test/api/push/abc?status=up&msg=collect-ok%3Acareerjunction");
  });

  it("reports a non-ok HTTP response without throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    const r = await pushHeartbeat({ url: "https://kuma.test/p", fetchImpl: fetchImpl as never });
    expect(r.pushed).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("503");
  });

  it("swallows a thrown fetch (network error) into a non-throwing result", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const r = await pushHeartbeat({ url: "https://kuma.test/p", fetchImpl: fetchImpl as never });
    expect(r).toEqual({ pushed: true, ok: false, error: "ECONNREFUSED" });
  });
});
