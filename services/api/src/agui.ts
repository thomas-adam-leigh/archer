// The AG-UI run lifecycle, driven by a deterministic scripted stub agent.
//
// "The run loop is real, the brain is stubbed." runStub() is a pure function:
// given a thread/run id and a RunAgentInput, it returns the ordered AG-UI event
// log the run should emit — RunStarted -> step/text/tool-call/state -> RunFinished
// (docs/docs/ag-ui/concepts/02-events.md). Keeping it pure (no DB, no IO) makes
// the ordering contract unit-testable; the route persists what this returns.
import type { Enums, Json } from "@archer/db";

/** The persisted enum vocabulary — the event log's `type` column. */
export type EventType = Enums<"event_type">;

/** One AG-UI event: the persisted enum `type` plus its AG-UI-shaped payload. */
export interface AgUiEvent {
  type: EventType;
  data: Json;
}

/** Whether the scripted stub completes normally or pauses for human input. */
export type StubOutcome = "success" | "interrupt";

/**
 * The slice of AG-UI's RunAgentInput the stub consumes. The full contract carries
 * messages/tools/context too; the stub only needs the thread and a scripted
 * outcome hint (forwardedProps.outcome) to exercise both terminal shapes.
 */
export interface RunAgentInput {
  threadId: string;
  runId?: string;
  messages?: Array<{ role: string; content?: string }>;
  state?: Json;
  resume?: Array<{ interruptId: string; status: "resolved" | "cancelled"; payload?: Json }>;
  forwardedProps?: { outcome?: StubOutcome } & Record<string, Json>;
}

export interface StubArgs {
  threadId: string;
  runId: string;
  input: RunAgentInput;
  parentRunId?: string | null;
}

const GREETING = "Hi — I'm Archer. Let's get your job hunt set up.";
const STEP = "respond";

/**
 * Produce the ordered event log for one stubbed run. Always bounded by
 * `run_started` … `run_finished`; emits a TextMessage start/content/end triplet
 * and at least one StateSnapshot. With `forwardedProps.outcome: "interrupt"` it
 * proposes a tool call and, per the interrupts contract, emits StateSnapshot +
 * MessagesSnapshot before a `run_finished` carrying an interrupt outcome.
 */
export function runStub({ threadId, runId, input, parentRunId = null }: StubArgs): AgUiEvent[] {
  const outcome: StubOutcome =
    input.forwardedProps?.outcome === "interrupt" ? "interrupt" : "success";
  const messageId = `${runId}:m1`;
  const events: AgUiEvent[] = [
    { type: "run_started", data: { threadId, runId, parentRunId } },
    { type: "step_started", data: { stepName: STEP } },
    { type: "text_message_start", data: { messageId, role: "assistant" } },
    { type: "text_message_content", data: { messageId, delta: GREETING } },
    { type: "text_message_end", data: { messageId } },
  ];

  if (outcome === "success") {
    events.push({ type: "state_snapshot", data: { snapshot: { phase: "greeted" } } });
    events.push({ type: "step_finished", data: { stepName: STEP } });
    events.push({ type: "run_finished", data: { threadId, runId, outcome: { type: "success" } } });
    return events;
  }

  // Interrupt path: propose a tool call, then snapshot state + messages so the
  // resumed run can rebuild context, then finish with an interrupt outcome.
  const toolCallId = `${runId}:tc1`;
  const interruptId = `${runId}:int1`;
  const proposedArgs = { to: "you@example.com", subject: "Welcome to Archer" };
  events.push({
    type: "tool_call_start",
    data: { toolCallId, toolCallName: "sendEmail", parentMessageId: messageId },
  });
  events.push({
    type: "tool_call_args",
    data: { toolCallId, delta: JSON.stringify(proposedArgs) },
  });
  events.push({ type: "tool_call_end", data: { toolCallId } });
  events.push({ type: "state_snapshot", data: { snapshot: { phase: "awaiting_approval" } } });
  events.push({
    type: "messages_snapshot",
    data: { messages: [{ id: messageId, role: "assistant", content: GREETING }] },
  });
  events.push({ type: "step_finished", data: { stepName: STEP } });
  events.push({
    type: "run_finished",
    data: {
      threadId,
      runId,
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: interruptId,
            reason: "tool_call",
            message: "Send the welcome email so we can confirm your address?",
            toolCallId,
            responseSchema: {
              type: "object",
              properties: {
                approved: { type: "boolean" },
                editedArgs: {
                  type: "object",
                  description: "Full replacement of the tool args. Not merged.",
                },
              },
              required: ["approved"],
            },
          },
        ],
      },
    },
  });
  return events;
}

/** The terminal run status implied by a run's final event outcome. */
export function statusFromEvents(events: AgUiEvent[]): Enums<"run_status"> {
  const last = events.at(-1);
  const outcome = (last?.data as { outcome?: { type?: string } } | undefined)?.outcome;
  return outcome?.type === "interrupt" ? "interrupted" : "completed";
}

/** The outcome payload from the terminal `run_finished` event, if any. */
export function outcomeFromEvents(events: AgUiEvent[]): Json | undefined {
  const last = events.at(-1);
  return (last?.data as { outcome?: Json } | undefined)?.outcome;
}

/** A restored message turn — the shape a MessagesSnapshot carries. */
export interface RestoredMessage {
  id: string;
  role: string;
  content: string;
}

/** The history-restore projection: a thread's current shared state + message log. */
export interface ThreadSnapshot {
  /** The StateSnapshot — the thread's shared state object. */
  state: Json;
  /** The MessagesSnapshot — the conversation, in turn order. */
  messages: RestoredMessage[];
}

/** One persisted event as the projection consumes it (data may be null in the DB). */
export type RestoreEvent = { type: EventType; data: Json | null };

/**
 * Fold an ordered AG-UI event log into a StateSnapshot + MessagesSnapshot — the
 * history a reconnecting or brand-new client uses to rebuild the conversation.
 * The event log is the source of truth (docs/docs/ag-ui/concepts/02-events.md);
 * this is its projection, so a restored view is identical to the live one a
 * subscriber accumulated. Pure (no DB/IO) and order-only, so it is unit-testable
 * and independent of how the rows were fetched.
 *
 * - state_snapshot replaces the state object (last one wins).
 * - messages_snapshot authoritatively replaces the message list.
 * - text_message_start/content materialize and grow a streamed message.
 * (state_delta layering arrives with the run loop that emits deltas.)
 */
export function restoreThread(events: RestoreEvent[]): ThreadSnapshot {
  let state: Json = {};
  const byId = new Map<string, RestoredMessage>();
  let order: string[] = [];

  for (const e of events) {
    const data = (e.data ?? {}) as Record<string, unknown>;
    switch (e.type) {
      case "state_snapshot":
        state = (data.snapshot ?? {}) as Json;
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
        byId.set(id, { id, role: (data.role as string) ?? "assistant", content: "" });
        break;
      }
      case "text_message_content": {
        const m = byId.get(data.messageId as string);
        if (m) m.content += (data.delta as string) ?? "";
        break;
      }
      // text_message_end and lifecycle/tool events don't change the projection.
    }
  }

  return { state, messages: order.map((id) => byId.get(id) as RestoredMessage) };
}
