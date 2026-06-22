/**
 * The signed-in session: a TanStack Store mirrored into `localStorage` so it
 * survives reloads, plus the `useSession` hook the app reads it through.
 *
 * SSR safety: the store always starts `null` (the server has no `localStorage`),
 * so the server render and the first client render agree. After mount, a client
 * effect (`useHydrateSession`, wired once at the app root) restores any persisted
 * session — avoiding a hydration mismatch while still resuming the user.
 */

import { Store, useStore } from "@tanstack/react-store";
import { useEffect } from "react";
import type { Session } from "#/lib/auth.ts";

const SESSION_KEY = "archer.session";

/** A value is a usable session only if it carries both tokens and a user id. */
function isSession(value: unknown): value is Session {
	const s = value as Session | null;
	return Boolean(
		s &&
			typeof s.accessToken === "string" &&
			typeof s.refreshToken === "string" &&
			typeof s.user?.id === "string",
	);
}

/** Read the persisted session from `localStorage`, or `null` if none / corrupt. */
export function loadSession(): Session | null {
	if (typeof localStorage === "undefined") return null;
	const raw = localStorage.getItem(SESSION_KEY);
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return isSession(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** Persist the session so it survives a reload. */
export function persistSession(session: Session): void {
	if (typeof localStorage === "undefined") return;
	localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

/** Drop the persisted session (called on sign-out). */
export function clearPersistedSession(): void {
	if (typeof localStorage === "undefined") return;
	localStorage.removeItem(SESSION_KEY);
}

/** The app-wide session store. Starts `null`; hydrated client-side after mount. */
export const sessionStore = new Store<Session | null>(null);

/** Set the active session (after sign in / sign up) and persist it. */
export function setSession(session: Session): void {
	persistSession(session);
	sessionStore.setState(() => session);
}

/** Clear the active session (sign out), dropping the persisted copy too. */
export function clearSession(): void {
	clearPersistedSession();
	sessionStore.setState(() => null);
}

/** The current session, or `null` when signed out. Re-renders on change. */
export function useSession(): Session | null {
	return useStore(sessionStore);
}

/**
 * Restore any persisted session into the store, once, after mount. Wire this at
 * the app root so a returning user is signed in without a hydration mismatch.
 */
export function useHydrateSession(): void {
	useEffect(() => {
		const persisted = loadSession();
		if (persisted) sessionStore.setState(() => persisted);
	}, []);
}
