import { describe, expect, test } from "vitest";
import { resolveAuthRedirect } from "#/lib/auth-guard.ts";

describe("resolveAuthRedirect", () => {
	test("stays put until hydration settles (session still unknown)", () => {
		expect(
			resolveAuthRedirect({
				hydrated: false,
				hasSession: false,
				kind: "protected",
			}),
		).toBeNull();
		expect(
			resolveAuthRedirect({ hydrated: false, hasSession: true, kind: "guest" }),
		).toBeNull();
	});

	test("sends a signed-out visitor on a protected route to /auth", () => {
		expect(
			resolveAuthRedirect({
				hydrated: true,
				hasSession: false,
				kind: "protected",
			}),
		).toBe("/auth");
	});

	test("lets a signed-in visitor stay on a protected route", () => {
		expect(
			resolveAuthRedirect({
				hydrated: true,
				hasSession: true,
				kind: "protected",
			}),
		).toBeNull();
	});

	test("sends a signed-in visitor on the auth screen into the flow", () => {
		expect(
			resolveAuthRedirect({ hydrated: true, hasSession: true, kind: "guest" }),
		).toBe("/");
	});

	test("lets a signed-out visitor see the auth screen", () => {
		expect(
			resolveAuthRedirect({ hydrated: true, hasSession: false, kind: "guest" }),
		).toBeNull();
	});
});
