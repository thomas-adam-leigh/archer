import {
  type BoardAdapter,
  type CollectContext,
  NotIntegratedError,
  type ScrapedPosting,
} from "./types.js";

/**
 * CareerJunction collect adapter.
 *
 * The live site was explored + mapped via the browser MCP (ARC-154); the notes
 * below are the contract the collect implementation (ARC-155) drives via
 * Patchright + the Decodo Pretoria proxy. Until that lands, collect throws so
 * `archer collect careerjunction` reports the board's real `not_integrated`
 * state; exercise the write path meanwhile with `--fixture <postings.json>`.
 *
 * Base: https://www.careerjunction.co.za  (country ZA, cred prefix CAREERJUNCTION)
 *
 * ── Login (POST /account/signin, form#loginForm) ────────────────────────────
 * Fields: `Email`, `Password`, `KeepLoggedIn` (checkbox, default checked), plus a
 * hidden `__RequestVerificationToken` (anti-CSRF) that must be read from the page
 * and posted back. `#loginButton` is disabled until both fields are populated.
 * No captcha/recaptcha observed (2026-06-24). Verify success by requesting
 * /myprofile/saved-jobs — a logged-OUT session 302s to /account/signin, a
 * logged-in one renders "Saved Jobs". Search results render logged-out too, but
 * the daily run authenticates (DoD; needed for apply later + a saner rate posture).
 *
 * ── Search route (one title at a time — matches the collect fan-out) ─────────
 * GET /jobs/results?keywords={title}  (spaces → '+', i.e. URL-encoded).
 * Refinement facets (optional, posted via the `location`/`category` selects +
 * hidden `SSARefinementModel.Json*` arrays): Locations (includes a "Work From
 * Home" pseudo-location), Category, Job Type (employment type), Job Level,
 * Salary, Company Type, Employment Equity. There is NO "Date Posted" facet and
 * NO discrete in-office/hybrid/remote toggle (see today-only + work-mode below).
 * Page size 25; `#TotalCount` (hidden) holds the full count; `#JobListingIds`
 * (hidden) lists the page's job ids. Pagination param to confirm in ARC-155.
 *
 * ── Result card (25 per page) ───────────────────────────────────────────────
 *   container          div.module.job-result
 *   title / url / id   .job-result-title h2 a[jobid]
 *                        → text       = title
 *                        → href       = /{slug}-job-{externalId}.aspx (make absolute)
 *                        → @jobid     = externalId (also in li.cjun-job-ref)
 *   company            .job-result-title h3 a  (text)
 *                      logo/link: .job-result-logo a[href="/companies/{cid}/{slug}"]
 *   overview (ul.job-overview):
 *     li.salary        → salaryRaw   ("Undisclosed" or a range)
 *     li.position      → "Permanent Junior position" (employment type + seniority)
 *     li.location      → first <a> = location; an <a href="/jobs/work-from-home">
 *                        ("Work From Home") and/or inline "(Hybrid)"/"(In Office)"
 *                        text encodes the work mode (see mapping below)
 *     li.updated-time  → "Posted DD Mon YYYY"  → postedOn (parse to ISO YYYY-MM-DD)
 *     li.expires       → "Expires in N days"
 *     li.cjun-job-ref  → "Job {externalId} - Ref {ref}"
 *
 * ── today-only (CollectContext.since='today') ───────────────────────────────
 * No date facet exists, so sort by most-recent (the "Sort By" control, JS-
 * populated) and read li.updated-time per card: keep cards whose date == the run
 * date, and stop paginating once an older date appears.
 *
 * ── work mode → Enums<'work_mode'> ('office' | 'hybrid' | 'remote' | 'unknown')
 * Derive from the card (no filter on the board): "/jobs/work-from-home" /
 * "Work From Home" → 'remote'; "(Hybrid)" → 'hybrid'; "(In Office)" → 'office';
 * otherwise 'unknown'.
 */
export const careerjunction: BoardAdapter = {
  slug: "careerjunction",
  async collect(_ctx: CollectContext): Promise<ScrapedPosting[]> {
    throw new NotIntegratedError(
      "careerjunction collect is not integrated yet — selectors are mapped (ARC-154); " +
        "wire the Patchright scrape and flip collect_status to 'integrated' in ARC-155.",
    );
  },
};
