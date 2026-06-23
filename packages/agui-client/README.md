# @archer/agui-client

The shared **AG-UI client**: run threads, fold their event log into a renderable
view, and stream live updates over Supabase Realtime. Pure and
transport-agnostic — only the global `WebSocket`/`fetch` + JSON — so the same
projection drives both the Lynx mobile app and the TanStack web app.

It mirrors the backend reference (`services/api/src/agui.ts`) field-for-field, so a
restored view is byte-identical to what a live subscriber accumulated. See
`docs/CLIENT-INTEGRATION.md` for the wire contract.

## Surface

- **`foldEvents(events)` / `applyStatePatch(state, ops)`** (`events.ts`) — the pure
  projection from an ordered AG-UI event log to a `ThreadView` (state, messages,
  interrupts, lifecycle phase).
- **`EventLog` / `fromRows` / `fromRunResponse`** (`event-log.ts`) — the
  reconciling log: dedupe by `(runId, seq)`, order by run-first-seen then seq, fold.
- **`createSupabaseRealtime(WebSocket, config)` / `resolveRealtime(config)` /
  `noopRealtime`** (`realtime.ts`) — the live transport over the Phoenix websocket
  protocol Realtime uses. `config` is `{ url, apikey }` (the project URL +
  publishable key), passed in rather than imported so the package carries no
  app-specific env wiring.
- **`createThreadSession(opts)`** (`thread-session.ts`) — the orchestrator. Folds
  one thread's log and keeps it current from history restore, the synchronous run
  response, and Realtime. The HTTP client (`http`) and live `transport` are
  injected; the host app binds its authenticated API client and (for live push)
  passes a Supabase Realtime transport.

## Usage

```ts
import {
  createThreadSession,
  resolveRealtime,
} from "@archer/agui-client";

const session = createThreadSession({
  threadId,
  accessToken,
  http: { get, post }, // your authenticated Archer API client
  transport: resolveRealtime({ url: SUPABASE_URL, apikey: SUPABASE_PUBLISHABLE_KEY }),
  onChange: (view) => render(view),
});

await session.loadHistory();
session.subscribe();
```

> Mobile (`apps/mobile`) currently keeps its own inline copy under
> `src/lib/agui/` — it builds standalone (workspace-excluded) and can migrate to
> this package later.
