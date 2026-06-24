import { describe, expect, it } from "vitest";
import {
  buildSearchUrl,
  cardToPosting,
  deriveWorkMode,
  keepByDate,
  parsePostedDate,
  type RawCard,
  resolveSinceFloor,
  todayInZA,
} from "./careerjunction.js";

describe("buildSearchUrl", () => {
  it("encodes spaces as '+' and sorts most-recent, 100/page, no page param on page 1", () => {
    expect(buildSearchUrl("AI Engineer")).toBe(
      "https://www.careerjunction.co.za/jobs/results?keywords=AI+Engineer&SortedBy=MostRecent&PerPage=100",
    );
  });

  it("adds &page=N for later pages", () => {
    expect(buildSearchUrl("AI Engineer", 3)).toBe(
      "https://www.careerjunction.co.za/jobs/results?keywords=AI+Engineer&SortedBy=MostRecent&PerPage=100&page=3",
    );
  });
});

describe("parsePostedDate", () => {
  it("parses 'Posted DD Mon YYYY' to ISO", () => {
    expect(parsePostedDate("Posted 24 Jun 2026")).toBe("2026-06-24");
    expect(parsePostedDate("Posted 04 Jun 2026")).toBe("2026-06-04");
    expect(parsePostedDate("Posted 1 Dec 2025")).toBe("2025-12-01");
  });

  it("returns undefined for missing/garbage/unknown-month text", () => {
    expect(parsePostedDate(undefined)).toBeUndefined();
    expect(parsePostedDate("Expires in 7 days")).toBeUndefined();
    expect(parsePostedDate("Posted 24 Foo 2026")).toBeUndefined();
  });
});

describe("deriveWorkMode", () => {
  it("maps a Work From Home link/text to remote", () => {
    expect(deriveWorkMode("Randburg / Work From Home", true)).toBe("remote");
    expect(deriveWorkMode("Work From Home", false)).toBe("remote");
  });

  it("maps inline (Hybrid)/(In Office) text", () => {
    expect(deriveWorkMode("Cape Town (Hybrid)", false)).toBe("hybrid");
    expect(deriveWorkMode("Sandton (In Office)", false)).toBe("office");
  });

  it("falls back to unknown", () => {
    expect(deriveWorkMode("Johannesburg North", false)).toBe("unknown");
    expect(deriveWorkMode("", false)).toBe("unknown");
  });
});

describe("cardToPosting", () => {
  const card: RawCard = {
    title: "AI Engineer",
    href: "/ai-engineer-job-2640738.aspx",
    jobid: "2640738",
    company: "Network Contracting Solutions",
    salary: "R Undisclosed",
    locationFirst: "Johannesburg North",
    locationText: "Johannesburg North (Johannesburg North)",
    hasWfhLink: false,
    updatedTime: "Posted 21 Jun 2026",
  };

  it("maps a full card to an absolute-url ScrapedPosting", () => {
    expect(cardToPosting(card)).toEqual({
      url: "https://www.careerjunction.co.za/ai-engineer-job-2640738.aspx",
      title: "AI Engineer",
      companyName: "Network Contracting Solutions",
      externalId: "2640738",
      location: "Johannesburg North",
      workMode: "unknown",
      salaryRaw: "R Undisclosed",
      postedOn: "2026-06-21",
    });
  });

  it("omits absent optional fields rather than emitting empty strings", () => {
    const posting = cardToPosting({ title: "Dev", href: "/dev-job-1.aspx" });
    expect(posting).toEqual({
      url: "https://www.careerjunction.co.za/dev-job-1.aspx",
      title: "Dev",
      workMode: "unknown",
    });
    expect(posting).not.toHaveProperty("companyName");
    expect(posting).not.toHaveProperty("postedOn");
  });

  it("returns null without a title or url", () => {
    expect(cardToPosting({ href: "/x-job-1.aspx" })).toBeNull();
    expect(cardToPosting({ title: "X" })).toBeNull();
  });
});

describe("date floor (today-only)", () => {
  it("resolves 'today' to the run date and an ISO --since to itself", () => {
    expect(resolveSinceFloor("today", "2026-06-24")).toBe("2026-06-24");
    expect(resolveSinceFloor("2026-06-20", "2026-06-24")).toBe("2026-06-20");
  });

  it("keeps only postings on-or-after the floor; drops dateless cards", () => {
    expect(keepByDate("2026-06-24", "2026-06-24")).toBe(true);
    expect(keepByDate("2026-06-25", "2026-06-24")).toBe(true);
    expect(keepByDate("2026-06-21", "2026-06-24")).toBe(false);
    expect(keepByDate(undefined, "2026-06-24")).toBe(false);
  });

  it("todayInZA renders a Johannesburg YYYY-MM-DD", () => {
    // 23:30 UTC on 2026-06-24 is already 01:30 the next day in Africa/Johannesburg (UTC+2).
    expect(todayInZA(new Date("2026-06-24T23:30:00Z"))).toBe("2026-06-25");
    expect(/^\d{4}-\d{2}-\d{2}$/.test(todayInZA())).toBe(true);
  });
});
