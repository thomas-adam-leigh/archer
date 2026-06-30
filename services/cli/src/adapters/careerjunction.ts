import type { Enums } from "@archer/db";
import type { Page } from "patchright-core";
import { careerjunctionApplier } from "./careerjunction-apply.js";
import { parseProxy, withSession } from "./harness.js";
import type { BoardAdapter, CollectContext, ScrapedPosting } from "./types.js";

/**
 * CareerJunction collect adapter (ARC-155).
 *
 * The live site was explored + mapped via the browser MCP (ARC-154) and the
 * selectors re-verified here; this adapter drives the mapped contract through the
 * shared harness (Patchright + the Decodo Pretoria proxy). Exercise the write path
 * without a browser via `archer collect careerjunction --fixture <postings.json>`.
 *
 * Base: https://www.careerjunction.co.za  (country ZA, cred prefix CAREERJUNCTION)
 *
 * ── Login (POST /account/signin, form#loginForm) ────────────────────────────
 * Fields: `#Email`, `#Password`, `#KeepLoggedIn` (checkbox, default checked), plus a
 * hidden `__RequestVerificationToken` (anti-CSRF) carried by the form and submitted
 * automatically. `#loginButton` is disabled until both fields are populated (the
 * fill events enable it). No captcha observed (2026-06-24). Login state is probed
 * by requesting /myprofile/saved-jobs — a logged-OUT session 302s to
 * /account/signin, a logged-in one stays. Cookies persist via the harness session
 * dir, so only the first run authenticates.
 *
 * ── Search route (one title at a time — matches the collect fan-out) ─────────
 * GET /jobs/results?keywords={title}&SortedBy=MostRecent&PerPage=100[&page=N].
 * `keywords` URL-encodes spaces as '+'. 100 results/page; `&page=N` paginates.
 * `#TotalCount` (hidden) holds the full count.
 *
 * ── Result card (div.module.job-result) ─────────────────────────────────────
 *   title / url / id   .job-result-title h2 a[jobid]
 *                        text = title; @href = /{slug}-job-{externalId}.aspx;
 *                        @jobid = externalId
 *   company            .job-result-title h3 a  (text)
 *   overview (ul.job-overview):
 *     li.salary        → salaryRaw   ("Undisclosed" or a range)
 *     li.position      → "Permanent Senior position" (employment type + seniority)
 *     li.location      → first <a> = location; an <a href*="work-from-home">
 *                        ("Work From Home") and/or inline "(Hybrid)"/"(In Office)"
 *                        text encodes the work mode (see {@link deriveWorkMode})
 *     li.updated-time  → "Posted DD Mon YYYY" → postedOn ({@link parsePostedDate})
 *     li.cjun-job-ref  → "Job {externalId} - Ref {ref}"
 * The card has no description; ScrapedPosting.description is left unset (enrichment
 * fills the company side later) rather than opening every job page.
 *
 * ── today-only (CollectContext.since) ────────────────────────────────────────
 * There is no Date Posted facet, and `SortedBy=MostRecent` is NOT strictly
 * chronological (verified: dates come back interleaved), so the doc's "stop once an
 * older date appears" early-exit is unsafe. Instead each result page is scanned and
 * cards are kept by parsing li.updated-time and filtering to the run date (or, for
 * an explicit `--since` ISO date, on-or-after it). Pagination is bounded by
 * {@link MAX_PAGES} to stay gentle; with PerPage=100 most titles fit in one page.
 *
 * ── work mode → Enums<'work_mode'> ('office' | 'hybrid' | 'remote' | 'unknown')
 * Derived from the card (the board has no work-mode filter); see {@link deriveWorkMode}.
 */

const BASE = "https://www.careerjunction.co.za";
const PER_PAGE = 100;
/** Gentle cap on result pages scanned per title — today-only rarely needs >1 at PerPage=100. */
export const MAX_PAGES = 5;

const MONTHS: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

/** Build the results URL for one title + page (spaces → '+', most-recent first). */
export function buildSearchUrl(title: string, page = 1, perPage = PER_PAGE): string {
  const params = new URLSearchParams({
    keywords: title,
    SortedBy: "MostRecent",
    PerPage: String(perPage),
  });
  if (page > 1) params.set("page", String(page));
  return `${BASE}/jobs/results?${params.toString()}`;
}

/** Parse a "Posted DD Mon YYYY" card date to an ISO `YYYY-MM-DD`, or undefined. */
export function parsePostedDate(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = text.match(/(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/);
  if (!m) return undefined;
  const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (!mon) return undefined;
  return `${m[3]}-${mon}-${m[1].padStart(2, "0")}`;
}

/**
 * Map a card's location signals to a work mode (the board has no work-mode filter,
 * so this is derived). A "Work From Home" link/text → remote; an inline "(Hybrid)"
 * → hybrid; "(In Office)" → office; otherwise unknown. Order matches the ARC-154
 * mapping (WFH first).
 */
export function deriveWorkMode(locationText: string, hasWfhLink: boolean): Enums<"work_mode"> {
  const t = locationText.toLowerCase();
  if (hasWfhLink || t.includes("work from home")) return "remote";
  if (t.includes("hybrid")) return "hybrid";
  if (t.includes("in office")) return "office";
  return "unknown";
}

/** The raw card fields extracted in the browser, before Node-side mapping. */
export interface RawCard {
  title?: string;
  href?: string;
  jobid?: string;
  company?: string;
  salary?: string;
  locationFirst?: string;
  locationText?: string;
  hasWfhLink?: boolean;
  updatedTime?: string;
}

/** Map an extracted card to a ScrapedPosting, or null when it lacks a title/url. */
export function cardToPosting(raw: RawCard): ScrapedPosting | null {
  const title = raw.title?.trim();
  const href = raw.href?.trim();
  if (!title || !href) return null;
  const posting: ScrapedPosting = {
    url: new URL(href, BASE).toString(),
    title,
    workMode: deriveWorkMode(raw.locationText ?? "", Boolean(raw.hasWfhLink)),
  };
  const company = raw.company?.trim();
  if (company) posting.companyName = company;
  const externalId = raw.jobid?.trim();
  if (externalId) posting.externalId = externalId;
  const location = raw.locationFirst?.trim();
  if (location) posting.location = location;
  const salary = raw.salary?.trim();
  if (salary) posting.salaryRaw = salary;
  const postedOn = parsePostedDate(raw.updatedTime);
  if (postedOn) posting.postedOn = postedOn;
  return posting;
}

/** Today's date as `YYYY-MM-DD` in the board's timezone (matches the harness locale). */
export function todayInZA(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" }).format(now);
}

/** The earliest posted-date a run keeps: the run date for 'today', else the ISO `--since`. */
export function resolveSinceFloor(since: string, todayZA: string): string {
  return since === "today" ? todayZA : since;
}

/** Keep a posting only if it carries a date on-or-after the floor (ISO strings sort lexically). */
export function keepByDate(postedOn: string | undefined, floor: string): boolean {
  return postedOn !== undefined && postedOn >= floor;
}

/** Extract every result card on the current page as a flat {@link RawCard}[]. */
function extractCards(page: Page): Promise<RawCard[]> {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll("div.module.job-result")).map((c) => {
      const titleA = c.querySelector(".job-result-title h2 a");
      const companyA = c.querySelector(".job-result-title h3 a");
      const li = (sel: string) => c.querySelector(`ul.job-overview li.${sel}`);
      const locLi = li("location");
      return {
        title: titleA?.textContent?.trim(),
        href: titleA?.getAttribute("href") ?? undefined,
        jobid: titleA?.getAttribute("jobid") ?? undefined,
        company: companyA?.textContent?.trim(),
        salary: li("salary")?.textContent?.trim(),
        locationFirst: locLi?.querySelector("a")?.textContent?.trim(),
        locationText: locLi?.textContent?.trim(),
        hasWfhLink: !!locLi?.querySelector('a[href*="work-from-home"]'),
        updatedTime: li("updated-time")?.textContent?.trim(),
      } as RawCard;
    });
  });
}

/** Authenticate if needed; reuses a persisted session and only logs in when logged out. */
export async function ensureLoggedIn(
  page: Page,
  creds: CollectContext["creds"],
  log: (m: string) => void,
) {
  await page.goto(`${BASE}/myprofile/saved-jobs`, { waitUntil: "domcontentloaded" });
  if (!page.url().includes("/account/signin")) {
    log("careerjunction: reusing logged-in session");
    return;
  }
  log("careerjunction: logging in");
  if (!page.url().includes("/account/signin")) {
    await page.goto(`${BASE}/account/signin`, { waitUntil: "domcontentloaded" });
  }
  await page.fill("#Email", creds.email ?? "");
  await page.fill("#Password", creds.password ?? "");
  await Promise.all([
    page
      .waitForURL((u) => !u.toString().includes("/account/signin"), { timeout: 30_000 })
      .catch(() => {}),
    page.click("#loginButton", { timeout: 5_000 }).catch(() =>
      page.evaluate(() => {
        (document.querySelector("form#loginForm") as HTMLFormElement | null)?.submit();
      }),
    ),
  ]);
  await page.goto(`${BASE}/myprofile/saved-jobs`, { waitUntil: "domcontentloaded" });
  if (page.url().includes("/account/signin")) {
    throw new Error(
      "careerjunction: login failed (still redirected to signin) — check credentials or a possible challenge",
    );
  }
  log("careerjunction: logged in");
}

/** Scrape one title: page through results (bounded), keeping cards within the date floor. */
async function searchTitle(
  page: Page,
  title: string,
  floor: string,
  log: (m: string) => void,
): Promise<ScrapedPosting[]> {
  const collected: ScrapedPosting[] = [];
  let pageNo = 1;
  for (; pageNo <= MAX_PAGES; pageNo++) {
    await page.goto(buildSearchUrl(title, pageNo), { waitUntil: "domcontentloaded" });
    const cards = await extractCards(page);
    if (cards.length === 0) break;
    for (const raw of cards) {
      const posting = cardToPosting(raw);
      if (posting && keepByDate(posting.postedOn, floor)) collected.push(posting);
    }
    if (cards.length < PER_PAGE) break; // last page
  }
  if (pageNo > MAX_PAGES) {
    log(`careerjunction: '${title}' hit the ${MAX_PAGES}-page cap — later pages not scanned`);
  }
  log(`careerjunction: '${title}' → ${collected.length} posting(s) on/after ${floor}`);
  return collected;
}

export const careerjunction: BoardAdapter = {
  slug: "careerjunction",
  async collect(ctx: CollectContext): Promise<ScrapedPosting[]> {
    const titles = ctx.titles.filter((t) => t.trim());
    if (titles.length === 0) return []; // no-title probe: nothing to search
    if (!ctx.creds.email || !ctx.creds.password) {
      throw new Error("careerjunction: missing CAREERJUNCTION_EMAIL/PASSWORD");
    }
    const log = ctx.log;
    const proxy = ctx.proxy ? parseProxy(ctx.proxy) : undefined;
    const floor = resolveSinceFloor(ctx.since, todayInZA());
    return withSession(
      { proxy, headful: ctx.headful, sessionKey: careerjunction.slug, log },
      async ({ page }) => {
        await ensureLoggedIn(page, ctx.creds, log);
        const out: ScrapedPosting[] = [];
        for (const title of titles) {
          out.push(...(await searchTitle(page, title, floor, log)));
        }
        return out;
      },
    );
  },
  apply: careerjunctionApplier,
};
