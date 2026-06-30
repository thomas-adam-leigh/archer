import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "patchright-core";
import type { Applier, ApplyContext, ApplyOutcome } from "../commands/apply.js";
import { parseProxy, withSession } from "./harness.js";

/**
 * PNET (StepStone "ApplyExpress") apply adapter.
 *
 * The live flow was mapped via the chrome-devtools MCP (2026-06-30):
 *   posting page → "I'm interested" → /job/{uuid}/application/dynamic-apply?workflow=ApplyExpress
 *   → "Application summary" (profile + default CV pre-filled; a "Supporting documents"
 *   file-upload slot — there is NO cover-letter text field) → "Send application".
 * Some postings instead bounce off-site ("Application managed off pnet") — those are
 * returned as a `redirect` for the external-fill path rather than submitted on-board.
 *
 * The approved cover letter .docx is resolved via `ctx.resolveDocx()` (rendered and
 * persisted to the cover-letters bucket by the apply boundary) and uploaded as a
 * supporting document alongside the résumé already on the PNET profile.
 *
 * Creds/proxy come from the environment (like the collect runner): PNET_EMAIL/PASSWORD,
 * and DECODO_PROXY in production (the German box needs the Pretoria exit; a local SA
 * run goes direct).
 */

const BASE = "https://www.pnet.co.za";

/** Accept the GDPR cookie-consent overlay (StepStone's `#GDPRConsentManagerContainer`)
 *  — it intercepts pointer events until dismissed. "Accept All" sets the consent cookie
 *  in the persistent profile, so it only appears on the first navigation. */
async function acceptCookieConsent(page: Page): Promise<void> {
  // The modal renders a beat after load and its CTA may be a link, not a button —
  // wait for the "Accept All" text inside the consent container, then click it.
  const accept = page
    .locator("#GDPRConsentManagerContainer")
    .getByText(/^accept all$/i)
    .first();
  await accept
    .waitFor({ state: "visible", timeout: 6_000 })
    .then(() => accept.click({ timeout: 3_000 }))
    .catch(() => {});
}

/** Clear the overlays that block interaction: the cookie consent, the email-alert /
 *  job-match interstitials, and the post-login "registration" promo dialog (which
 *  StepStone shows on a fresh login and which intercepts pointer events). */
async function clearOverlays(page: Page): Promise<void> {
  await acceptCookieConsent(page);
  for (const name of [/dismiss dialog/i, /dismiss popup/i, /close dialog/i]) {
    const btn = page.getByRole("button", { name });
    if (await btn.count())
      await btn
        .first()
        .click({ timeout: 2_000 })
        .catch(() => {});
  }
  // Generic genesis dialog (e.g. the post-login registration promo): a close button
  // if present, else Escape.
  const dialog = page.getByRole("dialog");
  if (await dialog.count().catch(() => 0)) {
    const close = dialog.getByRole("button", { name: /close|not now|maybe later|skip|no thanks/i });
    if (await close.count().catch(() => 0)) {
      await close
        .first()
        .click({ timeout: 3_000 })
        .catch(() => {});
    } else {
      await page.keyboard.press("Escape").catch(() => {});
    }
  }
}

/** True when the homepage shows an account (no "Sign in" menuitem). Consent is
 *  accepted first so the check (and any subsequent login) isn't blocked. */
async function isLoggedIn(page: Page): Promise<boolean> {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await clearOverlays(page);
  return (await page.getByRole("menuitem", { name: /^sign in$/i }).count()) === 0;
}

/** Authenticate via the two-step (email → password) login modal, reusing a persisted session. */
async function ensureLoggedIn(
  page: Page,
  email: string,
  password: string,
  log: (m: string) => void,
): Promise<void> {
  if (await isLoggedIn(page)) {
    log("pnet: reusing logged-in session");
    return;
  }
  log("pnet: logging in");
  await page.getByRole("menuitem", { name: /^sign in$/i }).click(); // open the account menu
  await page
    .getByRole("menu")
    .getByRole("menuitem", { name: /^sign in$/i })
    .click();
  await page.getByRole("textbox", { name: /email address/i }).fill(email);
  await page.getByRole("button", { name: /^continue$/i }).click();
  await page.getByRole("textbox", { name: /^password$/i }).fill(password);
  await page.getByRole("button", { name: /sign in to your account/i }).click();
  // Login resolves when the "Sign in" entry point is gone.
  await page
    .getByRole("menuitem", { name: /^sign in$/i })
    .waitFor({ state: "detached", timeout: 30_000 })
    .catch(() => {});
  if (!(await isLoggedIn(page))) {
    if (process.env.ARCHER_APPLY_DEBUG) {
      const shot = `/tmp/pnet-login-failure-${Date.now()}.png`;
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      const text = (await page.evaluate(() => document.body.innerText).catch(() => "")).slice(
        0,
        600,
      );
      log(`pnet: login-failure url=${page.url()} shot=${shot}\n--- visible text ---\n${text}`);
    }
    throw new Error("pnet: login failed (still logged out) — check credentials or a challenge");
  }
  log("pnet: logged in");
}

/** Resolve the approved cover-letter .docx (from the bucket), attach it as a
 *  supporting document, and tick it for inclusion. */
async function attachCoverLetter(page: Page, ctx: ApplyContext): Promise<string> {
  const docx = await ctx.resolveDocx();
  const path = join(mkdtempSync(join(tmpdir(), "archer-cl-")), docx.fileName);
  writeFileSync(path, docx.bytes);
  // Upload via the "Choose files" button + filechooser, not the (body-level, hidden,
  // duplicated) <input> — clicking the real control routes to the right input.
  const uploadBtn = page.locator('[data-testid="cvUpload"]').first();
  await uploadBtn.waitFor({ timeout: 30_000 });
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), uploadBtn.click()]);
  await chooser.setFiles(path);
  // Uploaded docs must be ticked to be included. The checkbox input is visually
  // hidden (styled label), so wait for it attached and check with force.
  const checkbox = page.getByRole("checkbox").last();
  await checkbox.waitFor({ state: "attached", timeout: 30_000 });
  await checkbox.check({ force: true }).catch(() => checkbox.click({ force: true }));
  await page
    .getByText(/1\s*\/\s*5 documents/i)
    .waitFor({ timeout: 20_000 })
    .catch(() => {});
  return docx.fileName;
}

export const pnetApplier: Applier = async (ctx: ApplyContext): Promise<ApplyOutcome> => {
  const email = process.env.PNET_EMAIL;
  const password = process.env.PNET_PASSWORD;
  if (!email || !password) return { kind: "failed", reason: "missing PNET_EMAIL/PASSWORD" };
  const proxy = process.env.DECODO_PROXY ? parseProxy(process.env.DECODO_PROXY) : undefined;
  const headful = process.env.ARCHER_HEADFUL !== "0";
  const { log } = ctx;

  return withSession({ proxy, headful, sessionKey: "pnet", log }, async ({ page }) => {
    await ensureLoggedIn(page, email, password, log);

    await page.goto(ctx.candidacy.url, { waitUntil: "domcontentloaded" });
    await clearOverlays(page);
    log(`pnet: opening apply for '${ctx.candidacy.role}'`);
    // "I'm interested" on a fresh job, or "Continue application" if a draft exists.
    // Programmatic click — robust against any residual overlay intercepting pointer
    // events (the apply page is a fresh load, so the promo modal won't follow).
    const applyBtn = page
      .getByRole("button", { name: /i'?m interested|continue application/i })
      .first();
    await applyBtn.waitFor({ timeout: 30_000 });
    await applyBtn.evaluate((el) => (el as HTMLElement).click());
    await page.waitForLoadState("domcontentloaded").catch(() => {});

    // Off-board bounce: the apply left pnet.co.za → hand to the external-fill path.
    const url = page.url();
    if (!/(^https?:\/\/)([^/]*\.)?pnet\.co\.za/i.test(url)) {
      log(`pnet: apply redirected off-site → ${url}`);
      return { kind: "redirect", url };
    }

    // On-board ApplyExpress: the summary is ready once "Send application" is present.
    await page.getByRole("button", { name: /send application/i }).waitFor({ timeout: 30_000 });
    const attached = await attachCoverLetter(page, ctx);
    log(`pnet: attached cover letter '${attached}'`);

    await page.getByRole("button", { name: /send application/i }).click();
    // Submission is confirmed by the redirect to the confirmation/success page.
    await page.waitForURL(/\/application\/confirmation\//i, { timeout: 30_000 }).catch(() => {});
    if (!/\/application\/confirmation\/success/i.test(page.url())) {
      return { kind: "failed", reason: `apply did not reach confirmation (at ${page.url()})` };
    }
    log("pnet: application submitted");
    return { kind: "submitted", detail: { board: "pnet", attached } };
  });
};
