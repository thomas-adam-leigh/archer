import type { Enums } from "@archer/db";
import type { Page } from "patchright-core";
import { parseProxy, withSession } from "./harness.js";
import type { BoardAdapter, CollectContext, ScrapedPosting } from "./types.js";

/**
 * CareerJet collect adapter (ARC-158).
 *
 * The live site was explored + mapped via the chrome-devtools MCP (see the ARC-158
 * issue comment) and the selectors re-verified here; this adapter drives the mapped
 * contract through the shared harness (Patchright + the Decodo Pretoria proxy).
 * Exercise the write path without a browser via
 * `archer collect careerjet --fixture <postings.json>`.
 *
 * Base: https://www.careerjet.co.za  (country ZA, cred prefix CAREERJET)
 *
 * ── No login ─────────────────────────────────────────────────────────────────
 * CareerJet ZA is an open aggregator: search results are public, so collect needs
 * no authentication (the "Sign in" link is only for saved-jobs/CV). Unlike the
 * CareerJunction adapter there is no `ensureLoggedIn` step, and CAREERJET_EMAIL/
 * PASSWORD are unused for collect.
 *
 * ── Search route (one title at a time — matches the collect fan-out) ─────────
 * GET /jobs?s={keywords}&l={location}&sort=date&nw={window}[&p=N].
 * `keywords` URL-encodes spaces as '+'. `l` empty = all South Africa.
 * `sort=date` orders most-recent first. `p=N` paginates (20 results/page; omit on
 * page 1). `nw` is CareerJet's recency facet and the today-only mechanism — see below.
 *
 * ── today-only (CollectContext.since) ────────────────────────────────────────
 * CareerJet exposes only *relative* card dates ("14 hours ago", "1 day ago"), not
 * an absolute date, but it DOES expose a server-side recency facet `nw` ("new
 * within N days"). So recency is enforced server-side by `nw`, not by re-filtering
 * calendar dates (the opposite of the CareerJunction adapter, which had no facet
 * and filtered client-side). `since='today'` → `nw=1` (verified: every card on the
 * sorted page then reads "14-23 hours ago"); an explicit `--since` ISO date → the
 * smallest of {@link NW_WINDOWS} covering the day-delta, or no `nw` (all dates)
 * when the delta exceeds the widest window. The relative date is still parsed into
 * an approximate `postedOn` as best-effort metadata.
 *
 * ── Result card (article.job) ────────────────────────────────────────────────
 *   title / url     header h2 a   text = title; @href = /jobad/{externalId}
 *   externalId      article@data-url = /jobad/{token} (strip the /jobad/ prefix)
 *   company         p.company a   (text)
 *   location        ul.location li (text, e.g. "Cape Town, Western Cape")
 *   description     div.desc      (a real teaser — populated, unlike the CJ card)
 *   posted          footer .badge (clock) → relative time → {@link parseRelativePostedDate}
 *
 * ── work mode → Enums<'work_mode'> ('office' | 'hybrid' | 'remote' | 'unknown')
 * The card has no work-mode field, so it is derived from the title+location text;
 * see {@link deriveWorkMode}.
 */

const BASE = "https://www.careerjet.co.za";
const PER_PAGE = 20;
/** Gentle cap on result pages scanned per title — today-only (nw=1) rarely needs many. */
export const MAX_PAGES = 10;
/** CareerJet's supported `nw` ("new within N days") windows, ascending. */
export const NW_WINDOWS = [1, 3, 7, 14, 31] as const;

/** Today's date as `YYYY-MM-DD` in the board's timezone (matches the harness locale). */
export function todayInZA(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" }).format(now);
}

/** Subtract `days` whole days from an ISO `YYYY-MM-DD`, returning an ISO date (UTC math). */
export function subtractDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Whole days between two ISO dates (`from` → `to`), floored at 0. */
function dayDelta(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

/**
 * Map a collect `since` to CareerJet's `nw` recency window, or `undefined` to omit
 * it (all dates). `'today'` → 1 day. An explicit ISO `--since` → the smallest
 * {@link NW_WINDOWS} value covering the day-delta to today; a delta beyond the
 * widest window omits `nw`. Pure, so the today-only policy is testable.
 */
export function sinceToWindow(since: string, todayZA: string): number | undefined {
  if (since === "today") return 1;
  const delta = dayDelta(since, todayZA);
  return NW_WINDOWS.find((w) => w >= delta);
}

/** Build the results URL for one title + page (spaces → '+', most-recent first). */
export function buildSearchUrl(
  title: string,
  opts: { window?: number; page?: number; location?: string } = {},
): string {
  const params = new URLSearchParams({
    s: title,
    l: opts.location ?? "",
    sort: "date",
  });
  if (opts.window !== undefined) params.set("nw", String(opts.window));
  if (opts.page !== undefined && opts.page > 1) params.set("p", String(opts.page));
  return `${BASE}/jobs?${params.toString()}`;
}

/**
 * Parse CareerJet's relative card date ("14 hours ago", "1 day ago", "3 weeks
 * ago", "just now", "30+ days ago") into an approximate ISO `postedOn` (today
 * minus the stated age), or `undefined` when it can't be read. Sub-day ages
 * ("just now"/minutes/hours/today) resolve to the run date. Best-effort metadata —
 * `nw` is the authority for recency.
 */
export function parseRelativePostedDate(
  text: string | undefined,
  todayZA: string = todayInZA(),
): string | undefined {
  if (!text) return undefined;
  const t = text.toLowerCase();
  if (/just now|minute|hour|^today|\btoday\b/.test(t)) return todayZA;
  if (/yesterday/.test(t)) return subtractDays(todayZA, 1);
  const m = t.match(/(\d+)\+?\s*(day|week|month)s?\s+ago/);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2];
  const days = unit === "week" ? n * 7 : unit === "month" ? n * 30 : n;
  return subtractDays(todayZA, days);
}

/**
 * Derive a work mode from a card's title + location text (CareerJet has no
 * work-mode field). Mirrors the CareerJunction derivation: remote/work-from-home →
 * remote, hybrid → hybrid, in-office/on-site → office, otherwise unknown.
 */
export function deriveWorkMode(text: string): Enums<"work_mode"> {
  const t = text.toLowerCase();
  if (/work from home|\bremote\b|telework|wfh/.test(t)) return "remote";
  if (/hybrid/.test(t)) return "hybrid";
  if (/in office|in-office|on[\s-]?site/.test(t)) return "office";
  return "unknown";
}

/** Strip CareerJet's `/jobad/{token}` path to the bare external id token, or undefined. */
export function externalIdFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m = url.match(/\/jobad\/([^/?#]+)/);
  return m ? m[1] : undefined;
}

/** The raw card fields extracted in the browser, before Node-side mapping. */
export interface RawCard {
  title?: string;
  href?: string;
  dataUrl?: string;
  company?: string;
  location?: string;
  description?: string;
  posted?: string;
}

/** Map an extracted card to a ScrapedPosting, or null when it lacks a title/url. */
export function cardToPosting(raw: RawCard, todayZA: string = todayInZA()): ScrapedPosting | null {
  const title = raw.title?.trim();
  const href = (raw.href ?? raw.dataUrl)?.trim();
  if (!title || !href) return null;
  const location = raw.location?.trim();
  const posting: ScrapedPosting = {
    url: new URL(href, BASE).toString(),
    title,
    workMode: deriveWorkMode(`${title} ${location ?? ""}`),
  };
  const company = raw.company?.trim();
  if (company) posting.companyName = company;
  const externalId = externalIdFromUrl(raw.dataUrl ?? raw.href);
  if (externalId) posting.externalId = externalId;
  if (location) posting.location = location;
  const description = raw.description?.trim();
  if (description) posting.description = description;
  const postedOn = parseRelativePostedDate(raw.posted, todayZA);
  if (postedOn) posting.postedOn = postedOn;
  return posting;
}

/**
 * Detect CareerJet's anti-bot interstitial ("Verification required … unusual
 * traffic … not a robot") from a page's body text. The challenge page renders no
 * `article.job` cards, so without this an anti-bot wall would masquerade as a clean
 * "nothing today" run — and a live collect would then FALSELY reconcile the board to
 * `integrated` despite collecting nothing. Surfacing it as an error instead makes
 * the run a genuine `failed` (board left untouched, Mechanic-visible). Pure, tested.
 */
export function isChallengePage(bodyText: string | undefined): boolean {
  return /verification required|unusual traffic|not a robot/i.test(bodyText ?? "");
}

/** The current page's result cards, plus whether it is the anti-bot challenge wall. */
interface PageScan {
  challenged: boolean;
  cards: RawCard[];
}

/** Extract every result card on the current page, and flag the anti-bot challenge. */
function scanPage(page: Page): Promise<PageScan> {
  return page.evaluate(() => {
    const challenged = /verification required|unusual traffic|not a robot/i.test(
      document.body?.innerText ?? "",
    );
    const cards = Array.from(document.querySelectorAll("article.job")).map((c) => {
      const titleA = c.querySelector("header h2 a");
      return {
        title: titleA?.textContent?.trim(),
        href: titleA?.getAttribute("href") ?? undefined,
        dataUrl: c.getAttribute("data-url") ?? undefined,
        company: c.querySelector("p.company a")?.textContent?.trim(),
        location: c.querySelector("ul.location li")?.textContent?.replace(/\s+/g, " ").trim(),
        description: c.querySelector("div.desc")?.textContent?.replace(/\s+/g, " ").trim(),
        posted: c.querySelector("footer .badge")?.textContent?.replace(/\s+/g, " ").trim(),
      };
    });
    return { challenged, cards };
  });
}

/** Scrape one title: page through date-sorted results (bounded), deduped by url within the run. */
async function searchTitle(
  page: Page,
  title: string,
  window: number | undefined,
  todayZA: string,
  log: (m: string) => void,
): Promise<ScrapedPosting[]> {
  const byUrl = new Map<string, ScrapedPosting>();
  let pageNo = 1;
  for (; pageNo <= MAX_PAGES; pageNo++) {
    await page.goto(buildSearchUrl(title, { window, page: pageNo }), {
      waitUntil: "domcontentloaded",
    });
    const { challenged, cards } = await scanPage(page);
    if (challenged) {
      // Never let an anti-bot wall pass as an empty (clean) run — fail loudly so the
      // board is NOT falsely marked integrated (see {@link isChallengePage}).
      throw new Error(
        "careerjet: anti-bot verification wall — the exit IP is being challenged " +
          "(needs a clean residential proxy exit); no postings collected",
      );
    }
    if (cards.length === 0) break;
    for (const raw of cards) {
      const posting = cardToPosting(raw, todayZA);
      if (posting && !byUrl.has(posting.url)) byUrl.set(posting.url, posting);
    }
    if (cards.length < PER_PAGE) break; // last page
  }
  if (pageNo > MAX_PAGES) {
    log(`careerjet: '${title}' hit the ${MAX_PAGES}-page cap — later pages not scanned`);
  }
  const collected = [...byUrl.values()];
  log(`careerjet: '${title}' → ${collected.length} posting(s) (nw=${window ?? "all"})`);
  return collected;
}

export const careerjet: BoardAdapter = {
  slug: "careerjet",
  async collect(ctx: CollectContext): Promise<ScrapedPosting[]> {
    const titles = ctx.titles.filter((t) => t.trim());
    if (titles.length === 0) return []; // no-title probe: nothing to search
    const log = ctx.log;
    const proxy = ctx.proxy ? parseProxy(ctx.proxy) : undefined;
    const todayZA = todayInZA();
    const window = sinceToWindow(ctx.since, todayZA);
    return withSession(
      { proxy, headful: ctx.headful, sessionKey: careerjet.slug, log },
      async ({ page }) => {
        const out: ScrapedPosting[] = [];
        for (const title of titles) {
          out.push(...(await searchTitle(page, title, window, todayZA, log)));
        }
        return out;
      },
    );
  },
};
