import type { Enums } from "@archer/db";
import type { Page } from "patchright-core";
import { parseProxy, withSession } from "./harness.js";
import type { BoardAdapter, CollectContext, ScrapedPosting } from "./types.js";

/**
 * PNET collect adapter (ARC-159).
 *
 * The live site was explored + mapped via the chrome-devtools MCP (see the ARC-159
 * issue comment) and the selectors re-verified here; this adapter drives the mapped
 * contract through the shared harness (Patchright + the Decodo Pretoria proxy).
 * Exercise the write path without a browser via
 * `archer collect pnet --fixture <postings.json>`.
 *
 * Base: https://www.pnet.co.za  (country ZA, cred prefix PNET; StepStone "startech" UI)
 *
 * ── No login ─────────────────────────────────────────────────────────────────
 * PNET serves search results fully public (a logged-OUT session returns the full
 * result set), so collect needs no authentication — like the CareerJet adapter and
 * unlike CareerJunction. PNET_EMAIL/PASSWORD are unused for collect, which is also
 * gentler on the account (no repeated logins).
 *
 * ── Search route (one title at a time — matches the collect fan-out) ─────────
 * GET /jobs/{slug}?ag=age_{window}[&page=N]. The title becomes a path slug:
 * lowercased, with each run of non-alphanumerics collapsed to a single '-' (see
 * {@link titleToSlug}) — e.g. "Senior Full-Stack Engineer" → `senior-full-stack-engineer`.
 * Keyword search (broad), 25 cards/page; `&page=N` paginates (omit on page 1).
 *
 * ── today-only (CollectContext.since) ────────────────────────────────────────
 * PNET exposes only *relative* card dates ("10 hours ago", "1 day ago"), not an
 * absolute date, but it DOES expose a server-side recency facet `ag` ("age"). So
 * recency is enforced server-side by `ag`, not by re-filtering calendar dates (the
 * same shape as the CareerJet `nw` facet). `since='today'` → `ag=age_1` (verified:
 * every card on that page then reads "5-22 hours ago"); an explicit `--since` ISO
 * date → the smallest of {@link AGE_WINDOWS} covering the day-delta, or no `ag` (all
 * dates) when the delta exceeds the widest window. The relative date is still parsed
 * into an approximate `postedOn` as best-effort metadata.
 *
 * ── Result card (article[data-testid="job-item"], id job-item-{externalId}) ──
 * Classes are hashed (`res-*`), so the adapter keys off the stable `data-at`/
 * `data-testid` attributes:
 *   title / url     a[data-at="job-item-title"]   text = title;
 *                     @href = /jobs--{slug}--{externalId}-inline.html
 *   externalId      digits before `-inline.html` in the href ({@link externalIdFromUrl})
 *   company         span[data-at="job-item-company-name"]   (text)
 *   location        span[data-at="job-item-location"]       (text)
 *   work-from-home  span[data-at="job-item-work-from-home"] "Fully remote" / "Partially remote"
 *   salary          span[data-at="job-item-salary-info"]    (raw, e.g. "R70 to R60 k pm")
 *   description     div[data-at="jobcard-content"]          (a teaser)
 *   posted          span[data-at="job-item-timeago"]        relative time → {@link parseRelativePostedDate}
 *
 * ── work mode → Enums<'work_mode'> ('office' | 'hybrid' | 'remote' | 'unknown')
 * Primarily the explicit work-from-home badge ("Fully remote" → remote, "Partially
 * remote" → hybrid); when absent, derived from the title+location text, defaulting
 * to unknown (see {@link deriveWorkMode}).
 */

const BASE = "https://www.pnet.co.za";
const PER_PAGE = 25;
/** Gentle cap on result pages scanned per title — today-only (age_1) rarely needs many. */
export const MAX_PAGES = 10;
/** PNET's supported `ag` ("age_N", new within N days) windows, ascending. */
export const AGE_WINDOWS = [1, 3, 7, 14, 30] as const;

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
 * Slugify a job title for PNET's `/jobs/{slug}` route: lowercase, collapse each run
 * of non-alphanumerics to a single '-', trim leading/trailing '-'. Pure, so the
 * route encoding is testable. Returns "" for a title with no alphanumerics (the
 * caller skips empty titles).
 */
export function titleToSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Map a collect `since` to PNET's `ag` recency window count, or `undefined` to omit
 * it (all dates). `'today'` → 1 day. An explicit ISO `--since` → the smallest
 * {@link AGE_WINDOWS} value covering the day-delta to today; a delta beyond the
 * widest window omits `ag`. Pure, so the today-only policy is testable.
 */
export function sinceToAge(since: string, todayZA: string): number | undefined {
  if (since === "today") return 1;
  const delta = dayDelta(since, todayZA);
  return AGE_WINDOWS.find((w) => w >= delta);
}

/** Build the results URL for one title + page (slug path, `ag` recency facet). */
export function buildSearchUrl(title: string, opts: { age?: number; page?: number } = {}): string {
  const params = new URLSearchParams();
  if (opts.age !== undefined) params.set("ag", `age_${opts.age}`);
  if (opts.page !== undefined && opts.page > 1) params.set("page", String(opts.page));
  const qs = params.toString();
  return `${BASE}/jobs/${titleToSlug(title)}${qs ? `?${qs}` : ""}`;
}

/**
 * Parse PNET's relative card date ("10 hours ago", "1 day ago", "3 weeks ago",
 * "just now", "30+ days ago") into an approximate ISO `postedOn` (today minus the
 * stated age), or `undefined` when it can't be read. Sub-day ages ("just now"/
 * minutes/hours/today) resolve to the run date. Best-effort metadata — `ag` is the
 * authority for recency.
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
 * Derive a work mode from PNET's explicit work-from-home badge, falling back to the
 * card's title + location text. "Fully remote" → remote, "Partially remote" →
 * hybrid; otherwise the text is scanned (remote/wfh → remote, hybrid → hybrid,
 * in-office/on-site → office) and, with no signal, `unknown`.
 */
export function deriveWorkMode(wfh: string, text: string): Enums<"work_mode"> {
  const w = wfh.toLowerCase();
  if (/fully remote/.test(w)) return "remote";
  if (/partially remote|partial/.test(w)) return "hybrid";
  const t = text.toLowerCase();
  if (/work from home|\bremote\b|telework|wfh/.test(t)) return "remote";
  if (/hybrid/.test(t)) return "hybrid";
  if (/in office|in-office|on[\s-]?site/.test(t)) return "office";
  return "unknown";
}

/** Strip PNET's `--{externalId}-inline.html` job-url suffix to the bare id, or undefined. */
export function externalIdFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m = url.match(/--(\d+)-inline\.html/);
  return m ? m[1] : undefined;
}

/** The raw card fields extracted in the browser, before Node-side mapping. */
export interface RawCard {
  title?: string;
  href?: string;
  company?: string;
  location?: string;
  workFromHome?: string;
  salary?: string;
  description?: string;
  posted?: string;
}

/** Map an extracted card to a ScrapedPosting, or null when it lacks a title/url. */
export function cardToPosting(raw: RawCard, todayZA: string = todayInZA()): ScrapedPosting | null {
  const title = raw.title?.trim();
  const href = raw.href?.trim();
  if (!title || !href) return null;
  const location = raw.location?.trim();
  const posting: ScrapedPosting = {
    url: new URL(href, BASE).toString(),
    title,
    workMode: deriveWorkMode(raw.workFromHome ?? "", `${title} ${location ?? ""}`),
  };
  const company = raw.company?.trim();
  if (company) posting.companyName = company;
  const externalId = externalIdFromUrl(href);
  if (externalId) posting.externalId = externalId;
  if (location) posting.location = location;
  const salary = raw.salary?.trim();
  if (salary) posting.salaryRaw = salary;
  const description = raw.description?.trim();
  if (description) posting.description = description;
  const postedOn = parseRelativePostedDate(raw.posted, todayZA);
  if (postedOn) posting.postedOn = postedOn;
  return posting;
}

/**
 * Detect an anti-bot interstitial (StepStone/Cloudflare: "unusual traffic", "verify
 * you are human", "are you a robot", "checking your browser", "access denied") from
 * a page's body text. The challenge page renders no `article[data-testid="job-item"]`
 * cards, so without this an anti-bot wall would masquerade as a clean "nothing today"
 * run — and a live collect would then FALSELY reconcile the board to `integrated`
 * despite collecting nothing. Surfacing it as an error instead makes the run a
 * genuine `failed` (board left untouched, Mechanic-visible). Pure, tested.
 */
export function isChallengePage(bodyText: string | undefined): boolean {
  return /unusual traffic|verify you are human|are you a (?:human|robot)|not a robot|checking your browser|access denied/i.test(
    bodyText ?? "",
  );
}

/** The current page's result cards, plus whether it is the anti-bot challenge wall. */
interface PageScan {
  challenged: boolean;
  cards: RawCard[];
}

/** Extract every result card on the current page, and flag the anti-bot challenge. */
function scanPage(page: Page): Promise<PageScan> {
  return page.evaluate(() => {
    const challenged =
      /unusual traffic|verify you are human|are you a (?:human|robot)|not a robot|checking your browser|access denied/i.test(
        document.body?.innerText ?? "",
      );
    const at = (c: Element, key: string) =>
      c.querySelector(`[data-at="${key}"]`)?.textContent?.replace(/\s+/g, " ").trim();
    const cards = Array.from(document.querySelectorAll('article[data-testid="job-item"]')).map(
      (c) => {
        const titleA = c.querySelector('[data-at="job-item-title"]');
        return {
          title: titleA?.textContent?.replace(/\s+/g, " ").trim(),
          href: titleA?.getAttribute("href") ?? undefined,
          company: at(c, "job-item-company-name"),
          location: at(c, "job-item-location"),
          workFromHome: at(c, "job-item-work-from-home"),
          salary: at(c, "job-item-salary-info"),
          description: at(c, "jobcard-content"),
          posted: at(c, "job-item-timeago"),
        };
      },
    );
    return { challenged, cards };
  });
}

/** Scrape one title: page through the age-faceted results (bounded), deduped by url within the run. */
async function searchTitle(
  page: Page,
  title: string,
  age: number | undefined,
  todayZA: string,
  log: (m: string) => void,
): Promise<ScrapedPosting[]> {
  const byUrl = new Map<string, ScrapedPosting>();
  let pageNo = 1;
  for (; pageNo <= MAX_PAGES; pageNo++) {
    await page.goto(buildSearchUrl(title, { age, page: pageNo }), {
      waitUntil: "domcontentloaded",
    });
    const { challenged, cards } = await scanPage(page);
    if (challenged) {
      // Never let an anti-bot wall pass as an empty (clean) run — fail loudly so the
      // board is NOT falsely marked integrated (see {@link isChallengePage}).
      throw new Error(
        "pnet: anti-bot verification wall — the exit IP is being challenged " +
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
    log(`pnet: '${title}' hit the ${MAX_PAGES}-page cap — later pages not scanned`);
  }
  const collected = [...byUrl.values()];
  log(`pnet: '${title}' → ${collected.length} posting(s) (ag=${age ? `age_${age}` : "all"})`);
  return collected;
}

export const pnet: BoardAdapter = {
  slug: "pnet",
  async collect(ctx: CollectContext): Promise<ScrapedPosting[]> {
    const titles = ctx.titles.filter((t) => t.trim());
    if (titles.length === 0) return []; // no-title probe: nothing to search
    const log = ctx.log;
    const proxy = ctx.proxy ? parseProxy(ctx.proxy) : undefined;
    const todayZA = todayInZA();
    const age = sinceToAge(ctx.since, todayZA);
    return withSession(
      { proxy, headful: ctx.headful, sessionKey: pnet.slug, log },
      async ({ page }) => {
        const out: ScrapedPosting[] = [];
        for (const title of titles) {
          out.push(...(await searchTitle(page, title, age, todayZA, log)));
        }
        return out;
      },
    );
  },
};
