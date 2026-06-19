/**
 * Komodo Action (Deno) — post-deploy smoke test for archer-api.
 *
 * Runs as the second stage of the `archer-deploy` procedure. Fails the procedure
 * (and fires the alerter) if the freshly deployed API isn't healthy, so a bad
 * release surfaces immediately instead of at 13:00 when the collect runs.
 *
 * Set the Komodo Variable ARCHER_API_HEALTH_URL (e.g. the loopback or internal
 * URL of the service, http://host.docker.internal:9125/health).
 */
const url = Deno.env.get("ARCHER_API_HEALTH_URL") ?? "http://host.docker.internal:9125/health";
const deadline = Date.now() + 60_000;

while (Date.now() < deadline) {
  try {
    const res = await fetch(url);
    if (res.ok) {
      console.log(`✓ archer-api healthy at ${url}`);
      Deno.exit(0);
    }
    console.log(`… ${url} -> ${res.status}, retrying`);
  } catch (err) {
    console.log(`… ${url} unreachable (${err}), retrying`);
  }
  await new Promise((r) => setTimeout(r, 3000));
}

console.error(`✖ archer-api did not become healthy within 60s — failing deploy.`);
Deno.exit(1);
