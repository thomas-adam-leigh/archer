/**
 * `@archer/agui-client` — the shared AG-UI client: run threads, fold their event
 * log, stream live over Supabase Realtime.
 *
 * Pure and transport-agnostic (only the global `WebSocket`/`fetch` + JSON), so the
 * same projection drives the Lynx mobile app and the TanStack web app. See
 * `thread-session.ts` for the orchestrator and `docs/CLIENT-INTEGRATION.md` for
 * the contract.
 */

export type { EventRow, KeyedEvent } from "./event-log.js";
export { EventLog, fromRows, fromRunResponse } from "./event-log.js";
export type {
  AguiEvent,
  EventType,
  Interrupt,
  Json,
  RestoredMessage,
  RunPhase,
  StatePatchOp,
  ThreadView,
} from "./events.js";
export { applyStatePatch, foldEvents } from "./events.js";
export {
  createSupabaseRealtime,
  noopRealtime,
  type RealtimeStatus,
  type RealtimeSubscription,
  type RealtimeTransport,
  resolveRealtime,
  type SubscribeOptions,
  type SupabaseRealtimeConfig,
} from "./realtime.js";
export {
  type AguiHttp,
  createThreadSession,
  type ResumeDirective,
  type RunInput,
  type RunResult,
  type ThreadSession,
  type ThreadSessionOptions,
} from "./thread-session.js";
