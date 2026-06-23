/**
 * The web binding for `@archer/agui-client` (ARC-125).
 *
 * The shared client is transport-agnostic: it folds a thread's AG-UI event log
 * and stays live from history-restore, the synchronous run response, and Supabase
 * Realtime — but it carries no app env wiring. This module binds it to the web
 * app: the authenticated Hono client (`apiGet`/`apiPost`) becomes its `http`
 * surface, and the project's Realtime transport (`supabase.ts`) becomes its live
 * push. The mobile client wires the same two seams in `apps/mobile/src/lib/agui`.
 */

import {
	type AguiHttp,
	createThreadSession,
	type ThreadSession,
	type ThreadView,
} from "@archer/agui-client";
import { apiGet, apiPost } from "#/lib/api.ts";
import type { Session } from "#/lib/auth.ts";
import { getRealtimeTransport } from "#/lib/supabase.ts";

/** The session's authenticated HTTP surface, bound to the Archer API. */
export function webAguiHttp(session: Session): AguiHttp {
	return {
		get: (path) => apiGet(path, session.accessToken),
		post: (path, body) => apiPost(path, session.accessToken, body),
	};
}

/**
 * Open a live thread session for the web app: the authenticated HTTP client plus
 * the Supabase Realtime transport, ready to `loadHistory` + `subscribe`. The
 * factory is injectable so screens stay unit-/Cypress-testable without a socket.
 */
export function createWebThreadSession(opts: {
	session: Session;
	threadId: string;
	onChange?(view: ThreadView): void;
	createSession?: typeof createThreadSession;
}): ThreadSession {
	const factory = opts.createSession ?? createThreadSession;
	return factory({
		threadId: opts.threadId,
		accessToken: opts.session.accessToken,
		http: webAguiHttp(opts.session),
		transport: getRealtimeTransport(),
		onChange: opts.onChange,
	});
}
