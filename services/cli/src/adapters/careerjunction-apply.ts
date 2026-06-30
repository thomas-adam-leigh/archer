import type { Page } from "patchright-core";
import type { Applier, ApplyContext, ApplyOutcome } from "../commands/apply.js";
import { ensureLoggedIn } from "./careerjunction.js";
import { signCoverLetter } from "./cover-letter-docx.js";
import { parseProxy, withSession } from "./harness.js";

/**
 * CareerJunction apply adapter.
 *
 * The live flow was mapped via the chrome-devtools MCP (2026-06-30):
 *   job page → "Apply Now" (a.btn-apply, href=/apply/{externalId}) → an on-board
 *   apply form at /apply/{externalId}: the profile CV is pre-attached, and the cover
 *   letter is PASTED into a text area (#coverNote, name JobApplication.CoverNote) —
 *   there is no file upload — then "Send Application" (input#ApplyNow) submits.
 *
 * So, unlike PNET's ApplyExpress (a supporting-document upload), CareerJunction takes
 * the cover-letter *text* directly — no .docx / bucket needed. The stored letters stop
 * at "Kind regards,", so the signatory is appended ({@link signCoverLetter}).
 *
 * Creds/proxy come from the environment (like the collect runner): CAREERJUNCTION_EMAIL
 * /PASSWORD, and DECODO_PROXY in production (the German box needs the Pretoria exit; a
 * local SA run goes direct).
 */

const BASE = "https://www.careerjunction.co.za";
const SIGNATORY = "Thomas Adam Leigh";

/** The on-board apply form lives at /apply/{externalId}; the id is the trailing
 *  `job-{id}.aspx` segment of the posting URL. */
function applyUrlFor(jobUrl: string): string | null {
  const m = jobUrl.match(/job-(\d+)\.aspx/i);
  return m ? `${BASE}/apply/${m[1]}` : null;
}

/** Accept the cookie-consent modal ("Your privacy" → "I accept", or "Accept All") —
 *  it GATES the apply submit until dismissed. The role-based locator doesn't reliably
 *  match this widget, so find + click the button by text in-page (what works). Polls a
 *  few times since it renders a beat after load. Returns true once accepted. */
async function acceptCookieConsent(page: Page): Promise<boolean> {
  for (let i = 0; i < 8; i++) {
    const clicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) =>
        /^(i accept|accept all)$/i.test((b.textContent || "").trim()),
      );
      if (btn) {
        (btn as HTMLElement).click();
        return true;
      }
      return false;
    });
    if (clicked) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

export const careerjunctionApplier: Applier = async (ctx: ApplyContext): Promise<ApplyOutcome> => {
  const email = process.env.CAREERJUNCTION_EMAIL;
  const password = process.env.CAREERJUNCTION_PASSWORD;
  if (!email || !password) {
    return { kind: "failed", reason: "missing CAREERJUNCTION_EMAIL/PASSWORD" };
  }
  const applyUrl = applyUrlFor(ctx.candidacy.url);
  if (!applyUrl) {
    return { kind: "failed", reason: `cannot derive apply id from ${ctx.candidacy.url}` };
  }
  const proxy = process.env.DECODO_PROXY ? parseProxy(process.env.DECODO_PROXY) : undefined;
  const headful = process.env.ARCHER_HEADFUL !== "0";
  const { log } = ctx;

  return withSession({ proxy, headful, sessionKey: "careerjunction", log }, async ({ page }) => {
    await ensureLoggedIn(page, { email, password }, log);

    log(`careerjunction: opening apply for '${ctx.candidacy.role}'`);
    await page.goto(applyUrl, { waitUntil: "domcontentloaded" });
    await acceptCookieConsent(page);

    // Off-board bounce: the apply left CareerJunction → hand to the external-fill path.
    if (!/careerjunction\.co\.za/i.test(page.url())) {
      log(`careerjunction: apply redirected off-site → ${page.url()}`);
      return { kind: "redirect", url: page.url() };
    }

    // On-board form: paste the cover-letter text (signed) and submit.
    const coverNote = page.locator("#coverNote");
    await coverNote.waitFor({ timeout: 30_000 });
    await coverNote.fill(signCoverLetter(ctx.coverLetter.content, SIGNATORY));
    log("careerjunction: cover letter filled");
    // The consent modal MUST be dismissed first — it silently gates the submit.
    await acceptCookieConsent(page);
    // Submit via the page's own click handler (submitApply → validate → form POST).
    await page.evaluate(() => (document.querySelector("#ApplyNow") as HTMLElement | null)?.click());

    // Success: CareerJunction navigates to /application-sent?appId=… on a real submit.
    await page.waitForURL(/\/application-sent/i, { timeout: 30_000 }).catch(() => {});
    if (/\/application-sent/i.test(page.url())) {
      log("careerjunction: application submitted");
      return { kind: "submitted", detail: { board: "careerjunction", confirmation: page.url() } };
    }
    if (process.env.ARCHER_APPLY_DEBUG) {
      const shot = `/tmp/cj-apply-failure-${Date.now()}.png`;
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      log(`careerjunction: apply-failure url=${page.url()} shot=${shot}`);
    }
    return { kind: "failed", reason: `apply did not reach confirmation (at ${page.url()})` };
  });
};
