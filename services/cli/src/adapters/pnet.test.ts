import { describe, expect, it } from "vitest";
import {
  AGE_WINDOWS,
  buildSearchUrl,
  cardToPosting,
  deriveWorkMode,
  externalIdFromUrl,
  isChallengePage,
  parseRelativePostedDate,
  type RawCard,
  sinceToAge,
  subtractDays,
  titleToSlug,
  todayInZA,
} from "./pnet.js";

describe("titleToSlug", () => {
  it("lowercases and collapses non-alphanumerics to single hyphens", () => {
    expect(titleToSlug("AI Engineer")).toBe("ai-engineer");
    expect(titleToSlug("Senior Full-Stack Engineer")).toBe("senior-full-stack-engineer");
    expect(titleToSlug("Agentic AI Engineer")).toBe("agentic-ai-engineer");
    expect(titleToSlug("C++  Developer")).toBe("c-developer");
  });

  it("trims leading/trailing hyphens and handles an all-symbol title", () => {
    expect(titleToSlug("  Data Scientist  ")).toBe("data-scientist");
    expect(titleToSlug("!!!")).toBe("");
  });
});

describe("buildSearchUrl", () => {
  it("builds the slug path with no query by default", () => {
    expect(buildSearchUrl("AI Engineer")).toBe("https://www.pnet.co.za/jobs/ai-engineer");
  });

  it("adds the ag recency facet when given", () => {
    expect(buildSearchUrl("AI Engineer", { age: 1 })).toBe(
      "https://www.pnet.co.za/jobs/ai-engineer?ag=age_1",
    );
  });

  it("adds &page=N for later pages but never for page 1", () => {
    expect(buildSearchUrl("AI Engineer", { age: 1, page: 1 })).toBe(
      "https://www.pnet.co.za/jobs/ai-engineer?ag=age_1",
    );
    expect(buildSearchUrl("AI Engineer", { age: 1, page: 3 })).toBe(
      "https://www.pnet.co.za/jobs/ai-engineer?ag=age_1&page=3",
    );
  });
});

describe("sinceToAge (today-only via the ag facet)", () => {
  it("maps 'today' to a 1-day window", () => {
    expect(sinceToAge("today", "2026-06-24")).toBe(1);
  });

  it("maps an explicit --since to the smallest covering age window", () => {
    expect(sinceToAge("2026-06-24", "2026-06-24")).toBe(1); // same day
    expect(sinceToAge("2026-06-23", "2026-06-24")).toBe(1); // 1 day
    expect(sinceToAge("2026-06-21", "2026-06-24")).toBe(3); // 3 days
    expect(sinceToAge("2026-06-18", "2026-06-24")).toBe(7); // 6 days → 7
    expect(sinceToAge("2026-06-13", "2026-06-24")).toBe(14); // 11 days → 14
    expect(sinceToAge("2026-06-01", "2026-06-24")).toBe(30); // 23 days → 30
  });

  it("omits ag (all dates) when the delta exceeds the widest window", () => {
    expect(sinceToAge("2026-01-01", "2026-06-24")).toBeUndefined();
  });

  it("widest window is the last AGE_WINDOWS value", () => {
    expect(AGE_WINDOWS[AGE_WINDOWS.length - 1]).toBe(30);
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
    expect(parseRelativePostedDate("10 hours ago", today)).toBe(today);
    expect(parseRelativePostedDate("30 minutes ago", today)).toBe(today);
    expect(parseRelativePostedDate("Today", today)).toBe(today);
  });

  it("resolves day/week/month ages by subtraction", () => {
    expect(parseRelativePostedDate("yesterday", today)).toBe("2026-06-23");
    expect(parseRelativePostedDate("1 day ago", today)).toBe("2026-06-23");
    expect(parseRelativePostedDate("3 days ago", today)).toBe("2026-06-21");
    expect(parseRelativePostedDate("1 week ago", today)).toBe("2026-06-17");
    expect(parseRelativePostedDate("30+ days ago", today)).toBe("2026-05-25");
  });

  it("returns undefined for missing/garbage text", () => {
    expect(parseRelativePostedDate(undefined, today)).toBeUndefined();
    expect(parseRelativePostedDate("Apply now", today)).toBeUndefined();
  });
});

describe("deriveWorkMode", () => {
  it("uses the explicit work-from-home badge first", () => {
    expect(deriveWorkMode("Fully remote", "AI Engineer Cape Town")).toBe("remote");
    expect(deriveWorkMode("Partially remote", "AI Engineer Pretoria")).toBe("hybrid");
  });

  it("falls back to title/location text when no badge", () => {
    expect(deriveWorkMode("", "Software Engineer (Remote)")).toBe("remote");
    expect(deriveWorkMode("", "SAP Developer - Gauteng/Hybrid")).toBe("hybrid");
    expect(deriveWorkMode("", "Analyst (On-site) Sandton")).toBe("office");
  });

  it("falls back to unknown with no signal", () => {
    expect(deriveWorkMode("", "Software Engineer Johannesburg")).toBe("unknown");
    expect(deriveWorkMode("", "")).toBe("unknown");
  });
});

describe("externalIdFromUrl", () => {
  it("extracts the numeric id before -inline.html", () => {
    expect(
      externalIdFromUrl("/jobs--AI-Engineer-Johannesburg-IQbusiness--4220249-inline.html"),
    ).toBe("4220249");
    expect(
      externalIdFromUrl(
        "https://www.pnet.co.za/jobs--Full-Stack-Menlyn-Imizizi--4220091-inline.html",
      ),
    ).toBe("4220091");
  });

  it("returns undefined when there is no inline-job id", () => {
    expect(externalIdFromUrl(undefined)).toBeUndefined();
    expect(externalIdFromUrl("/cmp/en/iqbusiness-13051/jobs")).toBeUndefined();
  });
});

describe("cardToPosting", () => {
  const today = "2026-06-24";
  const card: RawCard = {
    title: "AI Engineer",
    href: "/jobs--AI-Engineer-Johannesburg-IQbusiness--4220249-inline.html",
    company: "IQbusiness",
    location: "Johannesburg",
    workFromHome: "",
    salary: "R70 to R60 k pm",
    description: "We are recruiting a hands-on AI Engineer.",
    posted: "10 hours ago",
  };

  it("maps a full card to an absolute-url ScrapedPosting", () => {
    expect(cardToPosting(card, today)).toEqual({
      url: "https://www.pnet.co.za/jobs--AI-Engineer-Johannesburg-IQbusiness--4220249-inline.html",
      title: "AI Engineer",
      companyName: "IQbusiness",
      externalId: "4220249",
      location: "Johannesburg",
      workMode: "unknown",
      salaryRaw: "R70 to R60 k pm",
      description: "We are recruiting a hands-on AI Engineer.",
      postedOn: "2026-06-24",
    });
  });

  it("derives work mode from the badge and omits absent optional fields", () => {
    const posting = cardToPosting(
      {
        title: "AI Engineer (Expert)",
        href: "/jobs--AI-Engineer-Expert-Pretoria-Abalobi--4220375-inline.html",
        workFromHome: "Partially remote",
      },
      today,
    );
    expect(posting).toEqual({
      url: "https://www.pnet.co.za/jobs--AI-Engineer-Expert-Pretoria-Abalobi--4220375-inline.html",
      title: "AI Engineer (Expert)",
      externalId: "4220375",
      workMode: "hybrid",
    });
    expect(posting).not.toHaveProperty("companyName");
    expect(posting).not.toHaveProperty("salaryRaw");
  });

  it("returns null without a title or url", () => {
    expect(cardToPosting({ href: "/jobs--x--1-inline.html" }, today)).toBeNull();
    expect(cardToPosting({ title: "X" }, today)).toBeNull();
  });
});

describe("isChallengePage", () => {
  it("detects an anti-bot interstitial", () => {
    expect(isChallengePage("Our systems have detected unusual traffic from your network.")).toBe(
      true,
    );
    expect(isChallengePage("Please verify you are human to continue")).toBe(true);
    expect(isChallengePage("Checking your browser before accessing pnet.co.za")).toBe(true);
  });

  it("treats a normal results page (even with zero jobs) as not challenged", () => {
    expect(isChallengePage("0 results for AI Engineer jobs Filter by")).toBe(false);
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
