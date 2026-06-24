import { describe, expect, it } from "vitest";
import {
  buildSearchUrl,
  cardToPosting,
  deriveWorkMode,
  externalIdFromUrl,
  isChallengePage,
  NW_WINDOWS,
  parseRelativePostedDate,
  type RawCard,
  sinceToWindow,
  subtractDays,
  todayInZA,
} from "./careerjet.js";

describe("buildSearchUrl", () => {
  it("encodes spaces as '+', sorts by date, empty location, no nw/page by default", () => {
    expect(buildSearchUrl("Software Engineer")).toBe(
      "https://www.careerjet.co.za/jobs?s=Software+Engineer&l=&sort=date",
    );
  });

  it("adds the nw recency window when given", () => {
    expect(buildSearchUrl("Software Engineer", { window: 1 })).toBe(
      "https://www.careerjet.co.za/jobs?s=Software+Engineer&l=&sort=date&nw=1",
    );
  });

  it("adds &p=N for later pages but never for page 1", () => {
    expect(buildSearchUrl("AI Engineer", { window: 1, page: 1 })).toBe(
      "https://www.careerjet.co.za/jobs?s=AI+Engineer&l=&sort=date&nw=1",
    );
    expect(buildSearchUrl("AI Engineer", { window: 1, page: 3 })).toBe(
      "https://www.careerjet.co.za/jobs?s=AI+Engineer&l=&sort=date&nw=1&p=3",
    );
  });
});

describe("sinceToWindow (today-only via the nw facet)", () => {
  it("maps 'today' to a 1-day window", () => {
    expect(sinceToWindow("today", "2026-06-24")).toBe(1);
  });

  it("maps an explicit --since to the smallest covering nw window", () => {
    expect(sinceToWindow("2026-06-24", "2026-06-24")).toBe(1); // same day
    expect(sinceToWindow("2026-06-23", "2026-06-24")).toBe(1); // 1 day
    expect(sinceToWindow("2026-06-21", "2026-06-24")).toBe(3); // 3 days
    expect(sinceToWindow("2026-06-18", "2026-06-24")).toBe(7); // 6 days → 7
    expect(sinceToWindow("2026-06-13", "2026-06-24")).toBe(14); // 11 days → 14
  });

  it("omits nw (all dates) when the delta exceeds the widest window", () => {
    expect(sinceToWindow("2026-01-01", "2026-06-24")).toBeUndefined();
  });

  it("widest window is the last NW_WINDOWS value", () => {
    expect(NW_WINDOWS[NW_WINDOWS.length - 1]).toBe(31);
  });
});

describe("subtractDays", () => {
  it("subtracts whole days across month boundaries", () => {
    expect(subtractDays("2026-06-24", 0)).toBe("2026-06-24");
    expect(subtractDays("2026-06-24", 1)).toBe("2026-06-23");
    expect(subtractDays("2026-06-01", 1)).toBe("2026-05-31");
    expect(subtractDays("2026-06-24", 7)).toBe("2026-06-17");
  });
});

describe("parseRelativePostedDate", () => {
  const today = "2026-06-24";
  it("resolves sub-day ages to the run date", () => {
    expect(parseRelativePostedDate("just now", today)).toBe(today);
    expect(parseRelativePostedDate("14 hours ago", today)).toBe(today);
    expect(parseRelativePostedDate("30 minutes ago", today)).toBe(today);
    expect(parseRelativePostedDate("Today", today)).toBe(today);
  });

  it("resolves day/week/month ages by subtraction", () => {
    expect(parseRelativePostedDate("yesterday", today)).toBe("2026-06-23");
    expect(parseRelativePostedDate("1 day ago", today)).toBe("2026-06-23");
    expect(parseRelativePostedDate("3 days ago", today)).toBe("2026-06-21");
    expect(parseRelativePostedDate("2 weeks ago", today)).toBe("2026-06-10");
    expect(parseRelativePostedDate("30+ days ago", today)).toBe("2026-05-25");
  });

  it("returns undefined for missing/garbage text", () => {
    expect(parseRelativePostedDate(undefined, today)).toBeUndefined();
    expect(parseRelativePostedDate("Apply easily", today)).toBeUndefined();
  });
});

describe("deriveWorkMode", () => {
  it("maps remote / work-from-home signals to remote", () => {
    expect(deriveWorkMode("Software Engineer (Remote)")).toBe("remote");
    expect(deriveWorkMode("Dev — Work From Home")).toBe("remote");
  });

  it("maps hybrid and in-office/on-site", () => {
    expect(deriveWorkMode("SAP Developer - Gauteng/Hybrid")).toBe("hybrid");
    expect(deriveWorkMode("Analyst (On-site) Sandton")).toBe("office");
  });

  it("falls back to unknown with no signal", () => {
    expect(deriveWorkMode("Software Engineer Cape Town, Western Cape")).toBe("unknown");
    expect(deriveWorkMode("")).toBe("unknown");
  });
});

describe("externalIdFromUrl", () => {
  it("strips the /jobad/ prefix to the bare token", () => {
    expect(externalIdFromUrl("/jobad/zad4b005b8e9c5543113a994db3f3c0f0a")).toBe(
      "zad4b005b8e9c5543113a994db3f3c0f0a",
    );
    expect(externalIdFromUrl("https://www.careerjet.co.za/jobad/za123?x=1")).toBe("za123");
  });

  it("returns undefined when there is no jobad path", () => {
    expect(externalIdFromUrl(undefined)).toBeUndefined();
    expect(externalIdFromUrl("/company/Amazon/jobs")).toBeUndefined();
  });
});

describe("cardToPosting", () => {
  const today = "2026-06-24";
  const card: RawCard = {
    title: "Software Development Engineer",
    href: "/jobad/zad4b005b8e9c5543113a994db3f3c0f0a",
    dataUrl: "/jobad/zad4b005b8e9c5543113a994db3f3c0f0a",
    company: "Amazon",
    location: "Cape Town, Western Cape",
    description: "Join our team of innovative Software Engineers",
    posted: "14 hours ago",
  };

  it("maps a full card to an absolute-url ScrapedPosting", () => {
    expect(cardToPosting(card, today)).toEqual({
      url: "https://www.careerjet.co.za/jobad/zad4b005b8e9c5543113a994db3f3c0f0a",
      title: "Software Development Engineer",
      companyName: "Amazon",
      externalId: "zad4b005b8e9c5543113a994db3f3c0f0a",
      location: "Cape Town, Western Cape",
      workMode: "unknown",
      description: "Join our team of innovative Software Engineers",
      postedOn: "2026-06-24",
    });
  });

  it("derives work mode from the title and omits absent optional fields", () => {
    const posting = cardToPosting({ title: "Dev (Remote)", dataUrl: "/jobad/za1" }, today);
    expect(posting).toEqual({
      url: "https://www.careerjet.co.za/jobad/za1",
      title: "Dev (Remote)",
      externalId: "za1",
      workMode: "remote",
    });
    expect(posting).not.toHaveProperty("companyName");
    expect(posting).not.toHaveProperty("postedOn");
  });

  it("returns null without a title or url", () => {
    expect(cardToPosting({ dataUrl: "/jobad/za1" }, today)).toBeNull();
    expect(cardToPosting({ title: "X" }, today)).toBeNull();
  });
});

describe("isChallengePage", () => {
  it("detects the anti-bot verification interstitial", () => {
    expect(
      isChallengePage(
        "Verification required Our systems have detected unusual traffic from your computer network.",
      ),
    ).toBe(true);
    expect(isChallengePage("checks to see if it's really you and not a robot")).toBe(true);
  });

  it("treats a normal results page (even with zero jobs) as not challenged", () => {
    expect(isChallengePage("Software Engineer jobs in South Africa 0 jobs Filter")).toBe(false);
    expect(isChallengePage(undefined)).toBe(false);
  });
});

describe("todayInZA", () => {
  it("renders a Johannesburg YYYY-MM-DD", () => {
    // 23:30 UTC on 2026-06-24 is already 01:30 the next day in Africa/Johannesburg (UTC+2).
    expect(todayInZA(new Date("2026-06-24T23:30:00Z"))).toBe("2026-06-25");
    expect(/^\d{4}-\d{2}-\d{2}$/.test(todayInZA())).toBe(true);
  });
});
