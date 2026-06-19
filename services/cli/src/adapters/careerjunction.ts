import {
  type BoardAdapter,
  type CollectContext,
  NotIntegratedError,
  type ScrapedPosting,
} from "./types.js";

/**
 * CareerJunction collect adapter.
 *
 * Integration plan (a sprint with live access, per the design notes): drive a
 * non-headless Chromium via Patchright through a Decodo residential proxy with
 * VNC, log in using CAREERJUNCTION_EMAIL/PASSWORD, search each target title for
 * postings dated today, and map each result card to a ScrapedPosting. Selectors
 * are mapped live with the Chrome DevTools MCP; once a run produces clean rows,
 * flip boards.collect_status to 'integrated'.
 *
 * Until that sprint runs, collect throws so `archer collect careerjunction`
 * reports the board's real state. Exercise the write path meanwhile with
 * `archer collect careerjunction --fixture <postings.json>`.
 */
export const careerjunction: BoardAdapter = {
  slug: "careerjunction",
  async collect(_ctx: CollectContext): Promise<ScrapedPosting[]> {
    throw new NotIntegratedError(
      "careerjunction collect is not integrated yet — map its selectors in a collect sprint " +
        "(Patchright + VNC + Decodo), then set collect_status to 'integrated'.",
    );
  },
};
