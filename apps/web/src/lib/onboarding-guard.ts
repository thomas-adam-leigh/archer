/**
 * The resume-at-step boundary for the onboarding stage routes.
 *
 * Each `/onboarding/*` route runs {@link useOnboardingResume} with its own stage
 * identity. It reads `/onboarding/progress` (via {@link useOnboardingProgress})
 * and, once the real step is known, redirects when the user is somewhere they
 * shouldn't be — the `/onboarding` resolver always forwards to the live step, and
 * a stage that was deep-linked ahead of (or behind) the real step is bounced to
 * the correct one. The pure decision is {@link resolveOnboardingTarget}, kept in
 * `onboarding-flow.ts` so it's unit-tested without a router.
 *
 * Like the auth boundary, this runs client-side: the session is restored after
 * mount, so progress can't be read in a route loader.
 */

import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useOnboardingProgress } from "#/lib/hooks.ts";
import type { OnboardingProgress } from "#/lib/onboarding.ts";
import {
	type OnboardingRoute,
	resolveOnboardingTarget,
	routePath,
} from "#/lib/onboarding-flow.ts";

/** What an onboarding route should do right now. */
export interface ResumeState {
	/** `pending` until progress loads, then `ready` to render or `redirecting`. */
	status: "pending" | "ready" | "redirecting";
	/** The resolved progress once loaded, else `undefined`. */
	progress: OnboardingProgress | undefined;
}

/**
 * Resolve (and perform) the resume redirect for an onboarding route.
 *
 * Pass the route's own stage as `current`, or `null` for the `/onboarding`
 * resolver (which always forwards to the live step). Returns `ready` only when
 * progress has loaded and the user belongs on `current`, so the route can show a
 * neutral pending state until then instead of flashing the wrong stage.
 */
export function useOnboardingResume(
	current: OnboardingRoute | null,
): ResumeState {
	const navigate = useNavigate();
	const { data: progress } = useOnboardingProgress();

	const target = progress
		? resolveOnboardingTarget(current, progress.step)
		: null;

	useEffect(() => {
		if (target) navigate({ to: routePath(target), replace: true });
	}, [target, navigate]);

	if (!progress) return { status: "pending", progress: undefined };
	if (target) return { status: "redirecting", progress };
	return { status: "ready", progress };
}
