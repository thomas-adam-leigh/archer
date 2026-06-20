// The AG-UI run lifecycle, driven by a deterministic scripted stub agent.
//
// "The run loop is real, the brain is stubbed." runStub() is a pure function:
// given a thread/run id and a RunAgentInput, it returns the ordered AG-UI event
// log the run should emit — RunStarted -> step/text/tool-call/state -> RunFinished
// (docs/docs/ag-ui/concepts/02-events.md). Keeping it pure (no DB, no IO) makes
// the ordering contract unit-testable; the route persists what this returns.
import type { Enums, Json } from "@archer/db";
import { type AutonomyPolicy, needsApproval } from "./autonomy.js";

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

/** A resolved interrupt the route hands a resume run: the original tool call plus
 *  the human's decision (and any edited args). Drives the resume continuation. */
export interface ResolvedInterrupt {
  interruptId: string;
  toolCallId: string;
  approved: boolean;
  editedArgs?: Json;
}

export interface StubArgs {
  threadId: string;
  runId: string;
  input: RunAgentInput;
  parentRunId?: string | null;
  /** The user's autonomy policy; gates whether a proposed action interrupts. */
  policy?: AutonomyPolicy;
  /** Set on a resume run: the decisions the continuation consumes. */
  resolved?: ResolvedInterrupt[];
}

const GREETING = "Hi — I'm Archer. Let's get your job hunt set up.";
const STEP = "respond";
const ACTION = "sendEmail";

/**
 * Produce the ordered event log for one stubbed run. Always bounded by
 * `run_started` … `run_finished`; emits a TextMessage start/content/end triplet
 * and at least one StateSnapshot. With `forwardedProps.outcome: "interrupt"` it
 * proposes a tool call and, per the interrupts contract, emits StateSnapshot +
 * MessagesSnapshot before a `run_finished` carrying an interrupt outcome.
 */
export function runStub(args: StubArgs): AgUiEvent[] {
  // A resume run is a different script: it consumes the human's decision and
  // continues the conversation, rather than greeting from scratch.
  if (args.input.resume && args.input.resume.length > 0) return resumeScript(args);

  const { threadId, runId, input, parentRunId = null, policy = {} } = args;
  const wantInterrupt = input.forwardedProps?.outcome === "interrupt";
  const messageId = `${runId}:m1`;
  const events: AgUiEvent[] = [
    { type: "run_started", data: { threadId, runId, parentRunId } },
    { type: "step_started", data: { stepName: STEP } },
    { type: "text_message_start", data: { messageId, role: "assistant" } },
    { type: "text_message_content", data: { messageId, delta: GREETING } },
    { type: "text_message_end", data: { messageId } },
  ];

  if (!wantInterrupt) {
    events.push({ type: "state_snapshot", data: { snapshot: { phase: "greeted" } } });
    events.push({ type: "step_finished", data: { stepName: STEP } });
    events.push({ type: "run_finished", data: { threadId, runId, outcome: { type: "success" } } });
    return events;
  }

  // The stub wants to call a tool. Propose it, then let the autonomy resolver
  // decide: an action that needs approval pauses the run (interrupt); an action
  // the policy auto-approves runs unattended in the same run.
  const toolCallId = `${runId}:tc1`;
  const proposedArgs = { to: "you@example.com", subject: "Welcome to Archer" };
  events.push({
    type: "tool_call_start",
    data: { toolCallId, toolCallName: ACTION, parentMessageId: messageId },
  });
  events.push({
    type: "tool_call_args",
    data: { toolCallId, delta: JSON.stringify(proposedArgs) },
  });
  events.push({ type: "tool_call_end", data: { toolCallId } });

  if (!needsApproval(ACTION, policy)) {
    // Autonomous: execute without a human and finish normally.
    events.push({
      type: "tool_call_result",
      data: { toolCallId, result: { status: "executed", auto: true, args: proposedArgs } },
    });
    events.push({ type: "state_snapshot", data: { snapshot: { phase: "completed" } } });
    events.push({ type: "step_finished", data: { stepName: STEP } });
    events.push({ type: "run_finished", data: { threadId, runId, outcome: { type: "success" } } });
    return events;
  }

  // Needs approval: snapshot state + messages so the resumed run can rebuild
  // context, then finish with an interrupt outcome carrying the responseSchema.
  const interruptId = `${runId}:int1`;
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
            action: ACTION,
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

const RESUME_STEP = "resume";

/**
 * The scripted continuation a resume run emits. It consumes each resolved
 * interrupt (the human's approve/reject + any edited args), records the outcome
 * as a ToolCallResult, then confirms in text and finishes the run successfully.
 * Pure, so the resume contract is unit-testable independent of the DB.
 */
function resumeScript({
  threadId,
  runId,
  parentRunId = null,
  resolved = [],
}: StubArgs): AgUiEvent[] {
  const messageId = `${runId}:m1`;
  const events: AgUiEvent[] = [
    { type: "run_started", data: { threadId, runId, parentRunId } },
    { type: "step_started", data: { stepName: RESUME_STEP } },
  ];
  for (const r of resolved) {
    events.push({
      type: "tool_call_result",
      data: {
        toolCallId: r.toolCallId,
        interruptId: r.interruptId,
        result: r.approved
          ? { status: "executed", args: r.editedArgs ?? null }
          : { status: "skipped" },
      },
    });
  }
  const approved = resolved.some((r) => r.approved);
  const text = approved ? "Done — I've sent it." : "Okay, I won't send it.";
  events.push({ type: "text_message_start", data: { messageId, role: "assistant" } });
  events.push({ type: "text_message_content", data: { messageId, delta: text } });
  events.push({ type: "text_message_end", data: { messageId } });
  events.push({
    type: "state_snapshot",
    data: { snapshot: { phase: approved ? "completed" : "declined" } },
  });
  events.push({ type: "step_finished", data: { stepName: RESUME_STEP } });
  events.push({ type: "run_finished", data: { threadId, runId, outcome: { type: "success" } } });
  return events;
}

/** The RunError event pair for a request that violates a contract rule. Bounded
 *  by run_started so a rejected request is still an auditable, persisted run. */
export function runError(
  threadId: string,
  runId: string,
  reason: string,
  parentRunId: string | null = null,
): AgUiEvent[] {
  return [
    { type: "run_started", data: { threadId, runId, parentRunId } },
    { type: "run_error", data: { threadId, runId, message: reason } },
  ];
}

/** The terminal run status implied by a run's final event. */
export function statusFromEvents(events: AgUiEvent[]): Enums<"run_status"> {
  const last = events.at(-1);
  if (last?.type === "run_error") return "error";
  const outcome = (last?.data as { outcome?: { type?: string } } | undefined)?.outcome;
  return outcome?.type === "interrupt" ? "interrupted" : "completed";
}

/** The outcome payload from the terminal `run_finished` event, if any. */
export function outcomeFromEvents(events: AgUiEvent[]): Json | undefined {
  const last = events.at(-1);
  return (last?.data as { outcome?: Json } | undefined)?.outcome;
}

/** One interrupt the run proposed (the shape the proposals substrate persists). */
export interface EmittedInterrupt {
  id: string;
  reason?: string;
  message?: string;
  toolCallId: string;
  action?: string;
}

/** The interrupts carried by a run's terminal interrupt outcome (empty otherwise). */
export function interruptsFromEvents(events: AgUiEvent[]): EmittedInterrupt[] {
  const outcome = outcomeFromEvents(events) as
    | { type?: string; interrupts?: EmittedInterrupt[] }
    | undefined;
  return outcome?.type === "interrupt" ? (outcome.interrupts ?? []) : [];
}

// ── The interrupt/resume contract ───────────────────────────────────────────
// One run request, four outcomes, decided purely from the thread's interrupt
// state (which interrupts are still open vs already decided) and the request.
// Keeping this a pure function makes the contract rules unit-testable without a
// DB; the route resolves the facts from the proposals substrate and applies it.

/** A resume directive: a decision on one open interrupt. */
export interface ResumeDirective {
  interruptId: string;
  status: "resolved" | "cancelled";
  payload?: Json;
}

/** The thread's interrupt state, projected from its proposals. */
export interface ThreadInterruptState {
  /** interruptIds still awaiting a decision (proposal status 'submitted'). */
  open: string[];
  /** interruptIds already decided on this thread (for idempotent replay). */
  decided: string[];
}

/** What the route should do with a run request. */
export type RunDecision =
  | { action: "start" }
  | { action: "resume"; resolves: ResumeDirective[] }
  | { action: "replay" }
  | { action: "error"; reason: string };

/**
 * Classify a run request against the thread's interrupt state. Enforces the four
 * contract rules:
 *  - pending-interrupts-block-new-input: a non-resume request while interrupts
 *    are open is a RunError.
 *  - same-thread: a resume may only target interrupts known to this thread; an
 *    unknown interruptId (e.g. another thread's) is a RunError.
 *  - cover-all-open-interrupts: a resume that resolves any open interrupt must
 *    resolve ALL of them, or it is a RunError.
 *  - idempotent replay: a resume that only references already-decided interrupts
 *    is a no-op replay, not a new run.
 */
export function classifyRun({
  resume,
  state,
}: {
  resume?: ResumeDirective[];
  state: ThreadInterruptState;
}): RunDecision {
  const open = new Set(state.open);
  const decided = new Set(state.decided);

  if (!resume || resume.length === 0) {
    if (open.size > 0) {
      return { action: "error", reason: "pending interrupts must be resolved before new input" };
    }
    return { action: "start" };
  }

  // same-thread: every referenced interrupt must be known to this thread.
  for (const r of resume) {
    if (!open.has(r.interruptId) && !decided.has(r.interruptId)) {
      return { action: "error", reason: `unknown interrupt: ${r.interruptId}` };
    }
  }

  const targetsOpen = resume.filter((r) => open.has(r.interruptId));
  // idempotent replay: nothing still open is being resolved.
  if (targetsOpen.length === 0) return { action: "replay" };

  // cover-all: resolving any open interrupt requires resolving every one.
  const provided = new Set(targetsOpen.map((r) => r.interruptId));
  for (const id of open) {
    if (!provided.has(id)) {
      return { action: "error", reason: "resume must cover all open interrupts" };
    }
  }

  return { action: "resume", resolves: targetsOpen };
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
