/**
 * Live event delivery over Supabase Realtime.
 *
 * The `events` table is in the `supabase_realtime` publication, so every inserted
 * row fans out to subscribers as a Postgres Changes INSERT. Realtime authorizes
 * each subscriber against the table's RLS using the user's JWT, so a client
 * receives only events on threads it owns — per-user isolation with no extra
 * server code (`docs/CLIENT-INTEGRATION.md` §4).
 *
 * The transport speaks the Phoenix websocket protocol Realtime uses directly over
 * the global `WebSocket` — no `@supabase/supabase-js` dependency, so the same code
 * runs in the Lynx dual-thread runtime and in the browser. Following the host
 * apps' pattern, the transport is an injectable interface with a real
 * implementation and a no-op fallback when no `WebSocket` is present (tests under
 * jsdom, or a host without one) so the app never crashes for the want of a socket
 * — it simply relies on history-restore + the synchronous run response until live
 * push is available.
 *
 * The project URL + publishable key are passed in (`SupabaseRealtimeConfig`)
 * rather than imported, so the package stays free of any single app's env wiring.
 */

import type { EventRow } from "./event-log.js";

/** The Supabase project connection details Realtime needs. */
export interface SupabaseRealtimeConfig {
  /** The Supabase project URL (e.g. `https://xyz.supabase.co`). */
  url: string;
  /** The publishable/anon API key used to open the Realtime socket. */
  apikey: string;
}

/** A live subscription; call `unsubscribe` to close the socket. */
export interface RealtimeSubscription {
  unsubscribe(): void;
}

/** The connection state surfaced to callers (for reconnect / status UI). */
export type RealtimeStatus = "subscribed" | "closed" | "error";

/** Options for subscribing to one thread's live `events` inserts. */
export interface SubscribeOptions {
  threadId: string;
  /** The user's Supabase access token — Realtime authorizes RLS against it. */
  accessToken: string;
  /** Called for each inserted `events` row, in arrival order. */
  onInsert(row: EventRow): void;
  /** Optional connection-status callback. */
  onStatus?(status: RealtimeStatus): void;
}

/** The seam the thread session depends on: subscribe to a thread's events. */
export interface RealtimeTransport {
  subscribe(opts: SubscribeOptions): RealtimeSubscription;
}

// ── The minimal WebSocket surface we use ─────────────────────────────────────
// Typed locally rather than via the DOM lib so the build doesn't depend on ambient
// globals a host runtime may not declare.

interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
}
type WebSocketCtor = new (url: string) => WebSocketLike;

interface PhoenixMessage {
  topic: string;
  event: string;
  payload: Record<string, unknown>;
  ref: string | null;
}

const HEARTBEAT_MS = 25_000;

/** A no-op transport: no live push (history-restore still rebuilds the thread). */
export const noopRealtime: RealtimeTransport = {
  subscribe() {
    return { unsubscribe() {} };
  },
};

/**
 * The Supabase Realtime transport over a Phoenix websocket. One socket per
 * subscription, joined to a per-thread channel with a `postgres_changes` binding
 * filtered to this thread's rows; the user's JWT rides in `access_token` so RLS
 * scopes the stream. A periodic heartbeat keeps the socket alive.
 */
export function createSupabaseRealtime(
  WebSocketImpl: WebSocketCtor,
  config: SupabaseRealtimeConfig,
): RealtimeTransport {
  return {
    subscribe(opts: SubscribeOptions): RealtimeSubscription {
      const base = config.url.replace(/^http/, "ws");
      const url = `${base}/realtime/v1/websocket?apikey=${config.apikey}&vsn=1.0.0`;
      const topic = `realtime:thread:${opts.threadId}`;
      const ws = new WebSocketImpl(url);
      let refCounter = 0;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let closed = false;

      const nextRef = () => String(++refCounter);
      const send = (event: string, payload: Record<string, unknown>, channel = topic) => {
        const msg: PhoenixMessage = {
          topic: channel,
          event,
          payload,
          ref: nextRef(),
        };
        ws.send(JSON.stringify(msg));
      };

      ws.onopen = () => {
        // Join the channel with the postgres_changes binding + the user's JWT.
        send("phx_join", {
          config: {
            broadcast: { ack: false, self: false },
            presence: { key: "" },
            postgres_changes: [
              {
                event: "INSERT",
                schema: "public",
                table: "events",
                filter: `thread_id=eq.${opts.threadId}`,
              },
            ],
            private: false,
          },
          access_token: opts.accessToken,
        });
        heartbeat = setInterval(() => send("heartbeat", {}, "phoenix"), HEARTBEAT_MS);
        opts.onStatus?.("subscribed");
      };

      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        let msg: PhoenixMessage;
        try {
          msg = JSON.parse(ev.data) as PhoenixMessage;
        } catch {
          return;
        }
        if (msg.event !== "postgres_changes") return;
        // Realtime nests the changed row under payload.data.record.
        const data = msg.payload.data as { record?: EventRow } | undefined;
        const record = data?.record;
        if (record) opts.onInsert(record);
      };

      ws.onerror = () => opts.onStatus?.("error");
      ws.onclose = () => {
        if (!closed) opts.onStatus?.("closed");
      };

      return {
        unsubscribe() {
          closed = true;
          if (heartbeat !== undefined) clearInterval(heartbeat);
          try {
            ws.close();
          } catch {
            // best-effort close
          }
        },
      };
    },
  };
}

/** Resolve the host's WebSocket constructor, or null when absent. */
function findWebSocket(): WebSocketCtor | null {
  const ctor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  return typeof ctor === "function" ? ctor : null;
}

/** The app-wide transport: Supabase Realtime when a WebSocket exists, else no-op. */
export function resolveRealtime(config: SupabaseRealtimeConfig): RealtimeTransport {
  const WebSocketImpl = findWebSocket();
  return WebSocketImpl ? createSupabaseRealtime(WebSocketImpl, config) : noopRealtime;
}
