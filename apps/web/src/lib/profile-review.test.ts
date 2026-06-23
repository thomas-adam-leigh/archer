import { describe, expect, test } from "vitest";
import type { ProfileDraft } from "#/lib/profile.ts";
import {
	formatDate,
	formatPeriod,
	initialsOf,
	toProfileReviewView,
} from "#/lib/profile-review.ts";

describe("initialsOf", () => {
	test("takes the first + last initial", () => {
		expect(initialsOf("Ada Lovelace")).toBe("AL");
		expect(initialsOf("Grace Brewster Hopper")).toBe("GH");
	});
	test("one word → one letter; empty → ?", () => {
		expect(initialsOf("Prince")).toBe("P");
		expect(initialsOf("")).toBe("?");
		expect(initialsOf(null)).toBe("?");
	});
});

describe("formatDate", () => {
	test("formats YYYY-MM(-DD) to Mon YYYY", () => {
		expect(formatDate("2021-03")).toBe("Mar 2021");
		expect(formatDate("2021-03-15")).toBe("Mar 2021");
	});
	test("passes through a bare year and unknown formats", () => {
		expect(formatDate("2021")).toBe("2021");
		expect(formatDate("Summer 2021")).toBe("Summer 2021");
	});
	test("blank → null", () => {
		expect(formatDate("")).toBeNull();
		expect(formatDate(null)).toBeNull();
	});
});

describe("formatPeriod", () => {
	test("renders a full range", () => {
		expect(formatPeriod("2019-01", "2021-06", false)).toBe(
			"Jan 2019 – Jun 2021",
		);
	});
	test("a current role ends in Present", () => {
		expect(formatPeriod("2019-01", null, true)).toBe("Jan 2019 – Present");
	});
	test("a lone endpoint stands alone; nothing → null", () => {
		expect(formatPeriod("2019", null, false)).toBe("2019");
		expect(formatPeriod(null, null, false)).toBeNull();
	});
});

/** A richly-populated draft exercising every section + derivation. */
function fullDraft(): ProfileDraft {
	return {
		version: {
			id: "v2",
			status: "proposed",
			version_no: 3,
			attributes: {
				full_name: "Ada Lovelace",
				email: "ada@analytical.engine",
				phone: "+44 20 7946 0000",
				location: "London, UK",
				summary: "Mathematician and the first programmer.",
				links: {
					linkedin: "https://linkedin.com/in/ada",
					github: null,
					website: "https://ada.dev/",
				},
			},
		},
		spine: {
			workExperiences: [
				{
					title: "Principal Engineer",
					organization: "Analytical Engine Co.",
					startDate: "2020-02",
					endDate: null,
					isCurrent: true,
					description: "Led the notes.\nDesigned the first algorithm.",
				},
				{
					title: "Collaborator",
					organization: "Babbage Lab",
					startDate: "2015",
					endDate: "2019",
					isCurrent: false,
					description: "Translated Menabrea's memoir.",
				},
			],
			education: [
				{
					institution: "Home tutoring",
					degree: "Mathematics",
					fieldOfStudy: "Analysis",
					startDate: "1828",
					endDate: "1835",
				},
			],
			skills: [{ name: "Algorithms" }, { name: "Mathematics" }],
			certifications: [{ name: "Fellow", issuer: "Royal Society" }],
			courses: [{ name: "Calculus", provider: "De Morgan" }],
		},
	};
}

describe("toProfileReviewView", () => {
	test("maps every section of a populated draft", () => {
		const v = toProfileReviewView(fullDraft());

		expect(v.versionNo).toBe(3);
		expect(v.name).toBe("Ada Lovelace");
		expect(v.initials).toBe("AL");
		// Headline is the current role.
		expect(v.title).toBe("Principal Engineer");
		expect(v.location).toBe("London, UK");
		expect(v.email).toBe("ada@analytical.engine");

		// Links normalise to kind + stripped label + full href, in order.
		expect(v.links).toEqual([
			{
				kind: "linkedin",
				label: "linkedin.com/in/ada",
				href: "https://linkedin.com/in/ada",
			},
			{ kind: "website", label: "ada.dev", href: "https://ada.dev/" },
		]);

		// Experience: period + multi-line description → bullets.
		expect(v.experience[0]).toEqual({
			role: "Principal Engineer",
			company: "Analytical Engine Co.",
			period: "Feb 2020 – Present",
			bullets: ["Led the notes.", "Designed the first algorithm."],
		});
		expect(v.experience[1]?.period).toBe("2015 – 2019");

		// Education degree joins degree + field of study.
		expect(v.education[0]).toEqual({
			degree: "Mathematics, Analysis",
			school: "Home tutoring",
			period: "1828 – 1835",
		});

		// Certs + courses merge into one list.
		expect(v.certifications).toEqual([
			"Fellow · Royal Society",
			"Calculus · De Morgan",
		]);
		expect(v.skills).toEqual(["Algorithms", "Mathematics"]);
	});

	test("falls back gracefully for a sparse draft", () => {
		const v = toProfileReviewView({
			version: { id: "v1", status: "proposed", attributes: {} },
			spine: {},
		});
		expect(v.name).toBe("Your profile");
		expect(v.initials).toBe("?");
		expect(v.title).toBeNull();
		expect(v.versionNo).toBeNull();
		expect(v.links).toEqual([]);
		expect(v.experience).toEqual([]);
		expect(v.education).toEqual([]);
		expect(v.certifications).toEqual([]);
		expect(v.skills).toEqual([]);
	});

	test("headline falls back to the first experience when none is current", () => {
		const v = toProfileReviewView({
			version: { id: "v1", status: "proposed", attributes: {} },
			spine: {
				workExperiences: [
					{ title: "Earlier role", isCurrent: false },
					{ title: "Even earlier", isCurrent: false },
				],
			},
		});
		expect(v.title).toBe("Earlier role");
	});
});
