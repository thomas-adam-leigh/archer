# Board Integration — scraping harness (ARC-153)

The board-agnostic substrate every collect adapter sits on, so stealth, proxying,
and session handling are solved **once** rather than re-litigated per board. Lives in
`services/cli/src/adapters/harness.ts`; consumed by the per-board adapters (ARC-155
CareerJunction, then CareerJet / PNET).

## Why it exists — local ≠ prod

The dev Mac sits on a **South-African residential IP**, so it reaches SA boards
(CareerJunction, CareerJet, PNET) cleanly **direct**. Do not be fooled by this. Production
runs on `n8n@computer` — a **Hetzner box in Germany** — whose datacenter IP trips
geo/anti-bot walls on SA boards. So **every real run routes through `DECODO_PROXY`**, a
Decodo residential proxy that **exits in Pretoria / ZA** (the exact setup that ran
undetected in the legacy version of this project).

Proven from the German prod box (read-only `ip-api.com` probe):

| route | exit IP | geo |
|---|---|---|
| direct (Hetzner) | `178.104.225.80` | Germany, Nuremberg, Hetzner Online GmbH |
| through `DECODO_PROXY` | `102.141.160.106` | **South Africa, Pretoria** |

## Public API

```ts
import { parseProxy, withSession, fetchProxyGeo, classifyProxyGeo } from "./adapters/harness.js";

const proxy = parseProxy(process.env.DECODO_PROXY!); // → { server, username?, password? }

await withSession(
  { proxy, headful: true, sessionKey: "careerjunction", log: console.error },
  async ({ page, context }) => {
    await page.goto("https://www.careerjunction.co.za/jobs/results?keywords=...");
    // ...board-specific login + scrape (ARC-155+)
  },
);
```

- **`parseProxy(raw)`** — turns a `DECODO_PROXY` string (`http://user:pass@host:port`, or
  the colon-joined `host:port:user:pass`) into Patchright's `proxy` option. Throws on a
  blank/garbage value so a misconfig fails loudly rather than silently sending board
  traffic unproxied from a flagged IP. Userinfo is percent-decoded; `+` is preserved.
- **`withSession(opts, fn)`** — opens a persistent, stealth, optionally-proxied browser
  session for a board, runs `fn({ page, context })`, and always closes it. Cookies/storage
  persist in the board's profile dir (`$ARCHER_SESSION_DIR` or `~/.archer/sessions/<slug>`),
  so a logged-in session is **reused** next run instead of re-authenticating.
- **`fetchProxyGeo(proxy)` / `classifyProxyGeo(geo)`** — probe + judge a proxy's exit geo.
  Backs `archer proxy:check`.

## Stealth posture

[Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) is a stealth-patched
Playwright: it auto-handles the usual giveaways (`navigator.webdriver`, runtime leaks,
the CDP `Runtime.enable` tell, etc.). The harness only adds the posture that *isn't*
automatic, and deliberately **avoids** the things that get sessions flagged:

- **Do** launch the patched Chromium with **minimal flags** (Patchright defaults).
- **Do** set a **ZA locale + timezone** (`en-ZA`, `Africa/Johannesburg`) so the browser
  fingerprint matches the Pretoria proxy exit, plus a common desktop viewport.
- **Do** run **headful** (`headful: true`) — the legacy setup and Patchright both work best
  non-headless; prod runs it under a virtual display (VNC/Xvfb).
- **Don't** override the user-agent, pile on `--disable-*` args, or use `channel: "chrome"` —
  Patchright's patched browser is the stealthier choice.

## Browser binary install (runtime, not CI)

The npm dep is **`patchright-core`** (API + types only, **no** postinstall browser
download), so CI's `pnpm install --frozen-lockfile` stays clean. The patched Chromium is
fetched out-of-band on each **scraping host** (dev Mac + prod) once:

```bash
# from services/cli
node node_modules/patchright-core/cli.js install chromium
```

On the headless prod host also run `... install-deps chromium` (sudo) for the system libs.

## Validate the proxy

`archer proxy:check` connects through `DECODO_PROXY`, geolocates the exit IP, and asserts
it lands in **ZA** (exit non-zero otherwise). No DB and no full browser — a lightweight
proxied API request — so it runs on the headless prod host too.

```bash
DECODO_PROXY=... archer proxy:check
# proxy http://gate.decodo.com:10004
# exit  102.141.160.106 — exit verified in Pretoria, ZA (Pretoria, Gauteng, South Africa)
```

Run it **on `n8n@computer`** after a deploy to confirm the prod exit is ZA/Pretoria.

## Verified (ARC-153)

- `archer proxy:check` → Pretoria, ZA, locally **and** from the German prod box (table above).
- A non-headless, proxied Patchright session reaches CareerJunction (HTTP 200, title
  "Search Jobs | CareerJunction") and **reuses** a persisted session cookie across separate
  `withSession` calls.
- The board **login** flow (authenticate from `.env`) and a full proxied scrape **on prod**
  land with the first adapter to drive the harness, **ARC-155** (CareerJunction collect),
  which redeploys and verifies real rows on `n8n@computer`.
