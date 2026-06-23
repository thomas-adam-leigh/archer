/**
 * A live thread session: run AG-UI threads and render them.
 *
 * This is the reusable client module the onboarding screens build on (processing,
 * review, preferences, the conversational path). It folds one thread's event log
 * into a `ThreadView` and keeps it current from three sources, reconciled by
 * `(runId, seq)` so they converge regardless of arrival order:
 *
 *  1. **History restore** (`GET /agui/threads/:id/history`) — seed on open/reconnect.
 *  2. **The synchronous run response** (`POST /agui/run` and the onboarding run
 *     routes) — apply a run's events the instant they come back.
 *  3. **Supabase Realtime** on `events` — live push for runs that stream
 *     server-side (résumé ingest, redrafts), RLS-scoped to the user's own thread.
 *
 * `onChange` fires with the new `ThreadView` whenever any source advances it.
 *
 * Both the HTTP client and the live transport are injected: the package is
 * transport-agnostic and carries no app-specific env wiring. The host app binds
 * its authenticated API client to `http` and (when it wants live push) passes a
 * `transport` built with `createSupabaseRealtime` / `resolveRealtime`; absent one,
 * the session is driven by history restore + the synchronous run response alone.
 */

import { EventLog, type EventRow, fromRows, fromRunResponse } from "./event-log.js";
import type { AguiEvent, Json, ThreadView } from "./events.js";
import { noopRealtime, type RealtimeTransport } from "./realtime.js";

/** The slice of AG-UI `RunAgentInput` a caller supplies (threadId is injected). */
export interface RunInput {
  messages?: Array<{ role: string; content?: string }>;
  state?: Json;
  forwardedProps?: Record<string, Json>;
}

/** A resume directive resolving one open interrupt. */
export interface ResumeDirective {
  interruptId: string;
  status: "resolved" | "cancelled";
  payload?: Json;
}

/** The `POST /agui/run` response shape (success, replay, or persisted error). */
export interface RunResult {
  threadId: string;
  runId?: string;
  status?: string;
  events?: AguiEvent[];
  replay?: boolean;
  error?: string;
}

/** The history-restore response shape. */
interface HistoryResult {
  threadId: string;
  state: Json;
  events: EventRow[];
}

/** The HTTP surface the session needs — injected so it can be tested without a
 *  live API. The host app binds its authenticated client to these. */
export interface AguiHttp {
  get(path: string): Promise<unknown>;
  post(path: string, body?: unknown): Promise<unknown>;
}

export interface ThreadSessionOptions {
  threadId: string;
  /** The user's Supabase access token (for Realtime RLS). */
  accessToken: string;
  /** The authenticated HTTP client bound to the Archer API. */
  http: AguiHttp;
  /** Called with the fresh view whenever any source advances the thread. */
  onChange?(view: ThreadView): void;
  /** Live transport; defaults to a no-op (history + run-response only). Pass a
   *  Supabase Realtime transport (`resolveRealtime`) for live push. */
  transport?: RealtimeTransport;
}

/** A running thread session — render `view()`, drive runs, reconcile live push. */
export interface ThreadSession {
  /** The current folded view. */
  view(): ThreadView;
  /** Seed (or re-seed) from the persisted history; returns the new view. */
  loadHistory(): Promise<ThreadView>;
  /** Start live Realtime delivery for this thread. Idempotent. */
  subscribe(): void;
  /** Start a fresh run via `POST /agui/run`; folds its events into the view. */
  run(input?: RunInput): Promise<RunResult>;
  /** Resolve open interrupt(s) via `POST /agui/run` `resume`. */
  resume(resume: ResumeDirective[]): Promise<RunResult>;
  /** Fold a run response from any run-producing endpoint (e.g. `/onboarding/run`).
   *  A streamed run that returns no events is a no-op here — Realtime carries it. */
  apply(resp: { runId?: string; events?: AguiEvent[] }): ThreadView;
  /** Stop live delivery and release the socket. */
  close(): void;
}

/** Create a thread session bound to one thread + the user's session. */
export function createThreadSession(opts: ThreadSessionOptions): ThreadSession {
  const { threadId, accessToken, http } = opts;
  const transport = opts.transport ?? noopRealtime;

  const log = new EventLog();
  let subscription: { unsubscribe(): void } | null = null;

  const emit = (changed: boolean): ThreadView => {
    const view = log.view();
    if (changed) opts.onChange?.(view);
    return view;
  };

  const postRun = async (body: Record<string, unknown>): Promise<RunResult> => {
    const resp = (await http.post("/agui/run", {
      threadId,
      ...body,
    })) as RunResult;
    if (resp.replay) return resp; // idempotent no-op; nothing to fold
    if (resp.runId && resp.events) {
      emit(log.add(fromRunResponse(resp.runId, resp.events)));
    }
    return resp;
  };

  return {
    view: () => log.view(),

    async loadHistory() {
      const resp = (await http.get(`/agui/threads/${threadId}/history`)) as HistoryResult;
      return emit(log.add(fromRows(resp.events ?? [])));
    },

    subscribe() {
      if (subscription) return;
      subscription = transport.subscribe({
        threadId,
        accessToken,
        onInsert: (row) => emit(log.add(fromRows([row]))),
      });
    },

    run(input?: RunInput) {
      return postRun({ ...input });
    },

    resume(resume: ResumeDirective[]) {
      return postRun({ resume });
    },

    apply(resp) {
      const changed =
        resp.runId && resp.events ? log.add(fromRunResponse(resp.runId, resp.events)) : false;
      return emit(changed);
    },

    close() {
      subscription?.unsubscribe();
      subscription = null;
    },
  };
}
