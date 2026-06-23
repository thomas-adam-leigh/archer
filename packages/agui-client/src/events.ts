/**
 * The AG-UI event projection for the Lynx client.
 *
 * A run emits an ordered, append-only event log (`run_started → text/state/tool
 * events → run_finished`); the log — persisted in the `events` table — is the
 * replayable source of truth for a conversation (see `docs/CLIENT-INTEGRATION.md`
 * §3). A client renders by *folding* that stream and reconnects by replaying it.
 *
 * `foldEvents` is the client's projection. It mirrors the backend reference
 * (`services/api/src/agui.ts` `restoreThread` / `applyStatePatch`) field-for-field
 * so a restored view is byte-identical to what a live subscriber accumulated —
 * extended to surface the run's lifecycle phase and any open interrupts the UI
 * must act on. Pure and order-only: no IO, no DB, fully unit-testable.
 */

/** A JSON value — the shape of `data` payloads and shared state. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * The persisted AG-UI event vocabulary (the `events.type` enum). The stub emits
 * a subset today; the full vocabulary is listed so the fold is exhaustive.
 */
export type EventType =
  | "run_started"
  | "run_finished"
  | "run_error"
  | "step_started"
  | "step_finished"
  | "text_message_start"
  | "text_message_content"
  | "text_message_end"
  | "text_message_chunk"
  | "tool_call_start"
  | "tool_call_args"
  | "tool_call_end"
  | "tool_call_chunk"
  | "tool_call_result"
  | "state_snapshot"
  | "state_delta"
  | "messages_snapshot"
  | "activity_snapshot"
  | "activity_delta"
  | "reasoning_start"
  | "reasoning_message"
  | "reasoning_end"
  | "raw"
  | "custom";

/** One AG-UI event: the enum `type` plus its AG-UI-shaped payload. */
export interface AguiEvent {
  type: EventType;
  data: Json | null;
}

/** A restored message turn — the shape a MessagesSnapshot carries. */
export interface RestoredMessage {
  id: string;
  role: string;
  content: string;
}

/** An open interrupt awaiting the user's approve/reject decision. */
export interface Interrupt {
  id: string;
  reason?: string;
  action?: string;
  message?: string;
  toolCallId?: string;
  responseSchema?: Json;
}

/** The terminal/active lifecycle phase of the thread's most recent run. */
export type RunPhase = "running" | "completed" | "interrupted" | "error";

/** The folded view a client renders: shared state, messages, lifecycle, gates. */
export interface ThreadView {
  /** The StateSnapshot — the thread's shared state object (e.g. the draft). */
  state: Json;
  /** The MessagesSnapshot — the conversation, in turn order. */
  messages: RestoredMessage[];
  /** Open interrupts from the latest run's outcome (empty when none). */
  interrupts: Interrupt[];
  /** The most recent run's lifecycle phase, or null before any run. */
  phase: RunPhase | null;
  /** Set when the last run ended in `run_error` — a contract violation. */
  error?: string;
}

/** One RFC-6902 JSON Patch operation (the subset StateDelta events emit). */
export interface StatePatchOp {
  op: "add" | "replace" | "remove";
  path: string;
  value?: Json;
}

/** A JSON-only deep clone (state is pure JSON, so a roundtrip is faithful and
 *  avoids depending on `structuredClone`, which the Lynx engine may not expose). */
function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** Parse a JSON Pointer (RFC-6901) into its unescaped reference tokens. */
function pointerTokens(path: string): string[] {
  if (path === "") return [];
  return path
    .split("/")
    .slice(1)
    .map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/**
 * Apply a sequence of JSON-Patch ops to a state object, returning a NEW state
 * (the input is cloned, never mutated). Supports the add/replace/remove subset
 * AG-UI StateDelta events use, over object and array containers. Lenient by
 * design (a projection, not a validator): missing intermediate objects are
 * created so a delta never throws. Mirrors the backend `applyStatePatch`.
 */
export function applyStatePatch(state: Json, ops: StatePatchOp[]): Json {
  const root = clone(state ?? {}) as Json;
  for (const op of ops) {
    const tokens = pointerTokens(op.path);
    if (tokens.length === 0) {
      if (op.op !== "remove") return clone(op.value ?? {}) as Json;
      continue;
    }
    let node = root as Record<string, unknown> | unknown[];
    for (let i = 0; i < tokens.length - 1; i++) {
      const key = tokens[i];
      const next = (node as Record<string, unknown>)[key];
      if (next == null || typeof next !== "object") {
        (node as Record<string, unknown>)[key] = {};
      }
      node = (node as Record<string, unknown>)[key] as Record<string, unknown> | unknown[];
    }
    const last = tokens[tokens.length - 1];
    if (Array.isArray(node)) {
      const idx = last === "-" ? node.length : Number(last);
      if (op.op === "remove") node.splice(idx, 1);
      else node.splice(idx, op.op === "replace" ? 1 : 0, op.value);
    } else if (op.op === "remove") {
      delete (node as Record<string, unknown>)[last];
    } else {
      (node as Record<string, unknown>)[last] = op.value;
    }
  }
  return root;
}

interface Outcome {
  type?: "success" | "interrupt";
  interrupts?: Interrupt[];
}

/**
 * Fold an ordered AG-UI event log into a `ThreadView`. The log is the source of
 * truth; this is its projection, so a restored view equals the live one a
 * subscriber accumulated.
 *
 * - `state_snapshot` replaces the state object (last one wins).
 * - `state_delta` layers JSON-Patch ops onto the current state.
 * - `messages_snapshot` authoritatively replaces the message list.
 * - `text_message_start/content` materialize and grow a streamed message.
 * - `run_started` marks the phase running and clears stale interrupts;
 *   `run_finished` sets the phase + any interrupts from its outcome;
 *   `run_error` marks the phase error and captures the message.
 */
export function foldEvents(events: AguiEvent[]): ThreadView {
  let state: Json = {};
  const byId = new Map<string, RestoredMessage>();
  let order: string[] = [];
  let interrupts: Interrupt[] = [];
  let phase: RunPhase | null = null;
  let error: string | undefined;

  for (const e of events) {
    const data = (e.data ?? {}) as Record<string, unknown>;
    switch (e.type) {
      case "run_started":
        phase = "running";
        interrupts = [];
        error = undefined;
        break;
      case "run_finished": {
        const outcome = (data.outcome ?? {}) as Outcome;
        if (outcome.type === "interrupt") {
          phase = "interrupted";
          interrupts = outcome.interrupts ?? [];
        } else {
          phase = "completed";
          interrupts = [];
        }
        break;
      }
      case "run_error":
        phase = "error";
        error = (data.message as string) ?? "run failed";
        break;
      case "state_snapshot":
        state = (data.snapshot ?? {}) as Json;
        break;
      case "state_delta":
        state = applyStatePatch(state, (data.delta ?? []) as StatePatchOp[]);
        break;
      case "messages_snapshot": {
        const msgs = (data.messages ?? []) as RestoredMessage[];
        byId.clear();
        order = [];
        for (const m of msgs) {
          byId.set(m.id, { id: m.id, role: m.role, content: m.content ?? "" });
          order.push(m.id);
        }
        break;
      }
      case "text_message_start": {
        const id = data.messageId as string;
        if (!byId.has(id)) order.push(id);
        byId.set(id, {
          id,
          role: (data.role as string) ?? "assistant",
          content: "",
        });
        break;
      }
      case "text_message_content": {
        const m = byId.get(data.messageId as string);
        if (m) m.content += (data.delta as string) ?? "";
        break;
      }
      // text_message_end and the other lifecycle/tool events don't change
      // the projection (their effect rides in via state / run_finished).
    }
  }

  const view: ThreadView = {
    state,
    messages: order.map((id) => byId.get(id) as RestoredMessage),
    interrupts,
    phase,
  };
  if (error !== undefined) view.error = error;
  return view;
}
