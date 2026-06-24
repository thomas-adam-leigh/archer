import type { Command } from "commander";
import { classifyProxyGeo, fetchProxyGeo, maskProxy, parseProxy } from "../adapters/harness.js";
import { CliError, type GlobalOpts } from "../context.js";

interface ProxyCheckOpts {
  proxy?: string;
}

/**
 * `archer proxy:check` — validate the Decodo proxy (ARC-153 DoD). Connects through
 * the proxy, geolocates its exit IP, and asserts it lands in ZA (the gate that
 * keeps prod's German datacenter IP from being geo-blocked by SA boards). Run it
 * both locally and on `n8n@computer` to prove the prod exit is ZA/Pretoria.
 *
 * No DB and no full browser — a lightweight proxied API request — so it runs on the
 * headless prod host. Exits non-zero (CliError) if the exit isn't in ZA.
 */
export function registerProxy(program: Command): void {
  program
    .command("proxy:check")
    .description("Verify the Decodo proxy connects and its exit IP geolocates to ZA/Pretoria")
    .option("--proxy <url>", "proxy to check (default: $DECODO_PROXY)")
    .action(async (opts: ProxyCheckOpts, cmd) => {
      const global = cmd.optsWithGlobals() as GlobalOpts;
      const raw = opts.proxy ?? process.env.DECODO_PROXY;
      if (!raw) throw new CliError("no proxy: pass --proxy <url> or set DECODO_PROXY");

      const proxy = parseProxy(raw);
      const geo = await fetchProxyGeo(proxy);
      const verdict = classifyProxyGeo(geo);
      const result = { proxy: maskProxy(proxy.server), geo, verdict };

      if (global.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`proxy ${result.proxy}`);
        console.log(`exit  ${geo.ip ?? "?"} — ${verdict.reason}`);
      }
      if (!verdict.ok) throw new CliError(verdict.reason);
    });
}
