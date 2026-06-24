import { describe, expect, it, vi } from "vitest";
import type { ScrapedPosting } from "./adapters/types.js";
import { collectAcrossTitles, titleAttempts } from "./commands/collect.js";

// ARC-139 — a daily collect fans out one scrape attempt per (board × active title)
// instead of one call carrying every title, spacing attempts apart to spread load
// and reduce detection. These exercise the pure fan-out so the behaviour is proven
// without a live browser or a database (the DB-backed collect.test.ts is skipped
// unless TEST_DATABASE_URL is set; this runs in the default CI vitest pass).

const posting = (url: string): ScrapedPosting => ({ url, title: url });

describe("titleAttempts — one attempt per active title (ARC-139)", () => {
  it("maps each title to its own single-title attempt", () => {
    expect(titleAttempts(["a", "b", "c"])).toEqual([["a"], ["b"], ["c"]]);
  });

  it("makes a single empty attempt when there are no active titles", () => {
    // Still probes the board once, so a not-integrated stub surfaces its state
    // (and an integrated board reports "nothing") rather than being skipped.
    expect(titleAttempts([])).toEqual([[]]);
  });
});

describe("collectAcrossTitles — fan out + spacing (ARC-139)", () => {
  it("issues one collect per title and concatenates the postings in order", async () => {
    const seen: string[][] = [];
    const collect = vi.fn(async (titles: string[]) => {
      seen.push(titles);
      return [posting(`${titles[0]}/1`)];
    });

    const out = await collectAcrossTitles({
      titles: ["alpha", "beta"],
      collect,
      sleep: async () => {},
    });

    expect(collect).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([["alpha"], ["beta"]]);
    expect(out.map((p) => p.url)).toEqual(["alpha/1", "beta/1"]);
  });

  it("spaces attempts apart — sleeps between, never before the first or after the last", async () => {
    const sleep = vi.fn(async () => {});
    const collect = vi.fn(async () => [] as ScrapedPosting[]);

    await collectAcrossTitles({
      titles: ["a", "b", "c"],
      collect,
      spacingMs: 4000,
      sleep,
    });

    expect(sleep).toHaveBeenCalledTimes(2); // attempts - 1
    expect(sleep).toHaveBeenCalledWith(4000);
  });

  it("does not sleep when spacing is zero", async () => {
    const sleep = vi.fn(async () => {});
    const collect = vi.fn(async () => [] as ScrapedPosting[]);

    await collectAcrossTitles({ titles: ["a", "b"], collect, spacingMs: 0, sleep });

    expect(sleep).not.toHaveBeenCalled();
  });

  it("still probes once with no active titles, so the board state surfaces", async () => {
    const collect = vi.fn(async () => [] as ScrapedPosting[]);
    await collectAcrossTitles({ titles: [], collect });
    expect(collect).toHaveBeenCalledTimes(1);
    expect(collect).toHaveBeenCalledWith([]);
  });
});
