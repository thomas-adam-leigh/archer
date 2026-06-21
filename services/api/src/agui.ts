// The AG-UI run lifecycle: a pure, deterministic event-log builder whose
// conversational text is injected by the caller.
//
// "The run loop is real." runStub() is a pure function: given a thread/run id and
// a RunAgentInput, it returns the ordered AG-UI event log the run should emit —
// RunStarted -> step/text/tool-call/state -> RunFinished
// (docs/docs/ag-ui/concepts/02-events.md). The assistant's reply text rides in on
// `StubArgs.reply` — the route fills it with real LLM output (./brain.ts, ARC-60),
// and it falls back to a canned greeting when absent so the ordering contract stays
// unit-testable with no DB, no IO, and no live model.
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
  /** The assistant's reply text for this turn. The route injects real LLM output
   *  here (see ./brain.ts); falls back to the canned GREETING when absent, so the
   *  run loop stays a pure, deterministic stub for tests. */
  reply?: string;
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
  const greeting = args.reply?.trim() || GREETING;
  const wantInterrupt = input.forwardedProps?.outcome === "interrupt";
  const messageId = `${runId}:m1`;
  const events: AgUiEvent[] = [
    { type: "run_started", data: { threadId, runId, parentRunId } },
    { type: "step_started", data: { stepName: STEP } },
    { type: "text_message_start", data: { messageId, role: "assistant" } },
    { type: "text_message_content", data: { messageId, delta: greeting } },
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
    data: { messages: [{ id: messageId, role: "assistant", content: greeting }] },
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

// ── The onboarding run: shared-state draft assembly via JSON-Patch deltas ────
// The Guide's onboarding conversation accretes the candidate profile (ARC-28).
// It opens an empty draft in shared state (StateSnapshot), then accretes it field
// by field with StateDelta JSON-Patch (RFC-6902) deltas — the bandwidth-efficient
// snapshot→delta model AG-UI prescribes (docs/docs/ag-ui/concepts/02-events.md).
// The run finishes with the assembled draft in shared state; the route folds it
// (restoreThread) and submits it as a proposed profile VERSION through the apply
// executor. Deterministic + pure, like runStub: the run loop is real, brain stubbed.

const ONBOARD_STEP = "onboard";
const ONBOARD_GREETING = "Let's build your profile. Tell me about your work and what you're after.";
const ONBOARD_CLOSING = "Here's your draft profile — review and approve it to go live.";

/** The profile-wide attributes the scripted Guide assembles, when the caller
 *  doesn't supply any (e.g. a bare onboarding run with no answers yet). */
const DEFAULT_DRAFT: Record<string, Json> = {
  ideal_job: "A role where I ship product end to end.",
  why: "I do my best work close to users, owning outcomes.",
  ai_fluency: "Comfortable building with LLMs and agentic tools day to day.",
};

export interface OnboardingArgs {
  threadId: string;
  runId: string;
  parentRunId?: string | null;
  /** Profile-wide attributes to assemble into the draft (defaults to a canned set
   *  so a no-answer onboarding run still produces a reviewable draft). */
  draft?: Record<string, Json>;
}

/** Escape a JSON Pointer reference token (RFC-6901 §3): `~`→`~0`, `/`→`~1`. */
function escapePointer(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Produce the ordered event log for one onboarding run. Greets, opens an empty
 * draft in shared state, then emits one StateDelta per profile field (so the
 * draft is assembled incrementally, not snapshotted whole), flips the phase to
 * `draft_ready`, confirms in text, and finishes successfully. The final folded
 * shared state is `{ phase: "draft_ready", draft: { attributes: {…} } }`.
 */
export function onboardingRun({
  threadId,
  runId,
  parentRunId = null,
  draft,
}: OnboardingArgs): AgUiEvent[] {
  const attributes = draft && Object.keys(draft).length > 0 ? draft : DEFAULT_DRAFT;
  const open = `${runId}:m1`;
  const close = `${runId}:m2`;
  const events: AgUiEvent[] = [
    { type: "run_started", data: { threadId, runId, parentRunId } },
    { type: "step_started", data: { stepName: ONBOARD_STEP } },
    { type: "text_message_start", data: { messageId: open, role: "assistant" } },
    { type: "text_message_content", data: { messageId: open, delta: ONBOARD_GREETING } },
    { type: "text_message_end", data: { messageId: open } },
    {
      type: "state_snapshot",
      data: { snapshot: { phase: "onboarding", draft: { attributes: {} } } },
    },
  ];
  // Accrete the draft field by field — each delta is a JSON-Patch op array.
  for (const [key, value] of Object.entries(attributes)) {
    events.push({
      type: "state_delta",
      data: { delta: [{ op: "add", path: `/draft/attributes/${escapePointer(key)}`, value }] },
    });
  }
  events.push({
    type: "state_delta",
    data: { delta: [{ op: "replace", path: "/phase", value: "draft_ready" }] },
  });
  events.push({ type: "text_message_start", data: { messageId: close, role: "assistant" } });
  events.push({ type: "text_message_content", data: { messageId: close, delta: ONBOARD_CLOSING } });
  events.push({ type: "text_message_end", data: { messageId: close } });
  events.push({ type: "step_finished", data: { stepName: ONBOARD_STEP } });
  events.push({
    type: "run_finished",
    data: { threadId, runId, outcome: { type: "success", phase: "draft_ready" } },
  });
  return events;
}

/** The Guide's assembled profile-wide attributes, read out of folded shared state
 *  (`state.draft.attributes`). The shape the route submits as a profile version. */
export function draftAttributes(state: Json): Json {
  const draft = (state as { draft?: { attributes?: Json } } | null)?.draft;
  return draft?.attributes ?? {};
}

// ── The résumé-ingest run: streamed 3-phase progress → proposed version ───────
// Wraps the file→draft ingestion (ARC-63 text extraction + ARC-64 LLM structuring)
// in an AG-UI run so the client streams live status while Archer works. Unlike the
// onboarding Guide it never interrupts — there's no mid-run approval; the candidate
// approves the proposed version later on the review screen (Milestone 5). It emits
// three ordered progress phases as `state.phase` flips (also carried as assistant
// text), then finishes on a success outcome carrying the proposed version + proposal
// ids (also folded into shared state so a reconnecting client can jump straight to
// review from history). Pure + deterministic like the other runs: the route does the
// real IO (download/extract/structure/persist), then persists this event log.

const INGEST_STEP = "ingest";

/** The three ordered progress phases an ingest run streams, in emission order —
 *  the live status the mobile processing screen renders (Milestone 4). */
export const INGEST_PHASES = [
  { phase: "reading", message: "Reading your résumé." },
  { phase: "extracting", message: "Extracting your experience." },
  { phase: "building", message: "Building your profile." },
] as const;

export interface ResumeIngestArgs {
  threadId: string;
  runId: string;
  parentRunId?: string | null;
  /** The proposed version this run produced; rides on the terminal outcome + state. */
  versionId: string;
  /** The proposal awaiting the candidate's review; rides on the terminal outcome + state. */
  proposalId: string;
}

/**
 * Produce the ordered event log for one résumé-ingest run. Opens shared state at
 * the first phase, then walks the three phases (each a `/phase` StateDelta plus an
 * assistant status line), and finishes successfully — surfacing the proposed
 * `versionId`/`proposalId` both in the terminal `run_finished` outcome and in
 * shared state. The final folded shared state is
 * `{ phase: "complete", versionId, proposalId }`.
 */
export function resumeIngestRun({
  threadId,
  runId,
  parentRunId = null,
  versionId,
  proposalId,
}: ResumeIngestArgs): AgUiEvent[] {
  const [first, ...rest] = INGEST_PHASES;
  const events: AgUiEvent[] = [
    { type: "run_started", data: { threadId, runId, parentRunId } },
    { type: "step_started", data: { stepName: INGEST_STEP } },
    { type: "state_snapshot", data: { snapshot: { phase: first.phase } } },
  ];
  const say = (n: number, text: string) => {
    const id = `${runId}:m${n}`;
    events.push({ type: "text_message_start", data: { messageId: id, role: "assistant" } });
    events.push({ type: "text_message_content", data: { messageId: id, delta: text } });
    events.push({ type: "text_message_end", data: { messageId: id } });
  };
  say(1, first.message);
  // Each subsequent phase flips `state.phase` (a JSON-Patch delta) then narrates it.
  rest.forEach((p, i) => {
    events.push({
      type: "state_delta",
      data: { delta: [{ op: "replace", path: "/phase", value: p.phase }] },
    });
    say(i + 2, p.message);
  });
  events.push({
    type: "state_delta",
    data: {
      delta: [
        { op: "replace", path: "/phase", value: "complete" },
        { op: "add", path: "/versionId", value: versionId },
        { op: "add", path: "/proposalId", value: proposalId },
      ],
    },
  });
  events.push({ type: "step_finished", data: { stepName: INGEST_STEP } });
  events.push({
    type: "run_finished",
    data: {
      threadId,
      runId,
      outcome: { type: "success", phase: "complete", versionId, proposalId },
    },
  });
  return events;
}

// ── The Scribe run: cover-letter draft assembly into shared state ─────────────
// The Scribe drafts the one thing Archer puts in front of an employer in the
// candidate's name. Like the onboarding Guide, it is a scripted, deterministic
// stub (no live LLM): it opens an empty draft in shared state (StateSnapshot),
// writes the assembled letter into `state.draft.content` (StateDelta), flips the
// phase to `draft_ready`, and finishes successfully. The route folds the run
// (restoreThread → draftContent) and persists the letter as a proposed
// cover-letter VERSION. The proposal/interrupt approve-edit-reject loop lands in
// a later milestone (it consumes this draft; it does not change this run).

const SCRIBE_STEP = "scribe";
const SCRIBE_GREETING = "Drafting your cover letter — one moment.";
const SCRIBE_CLOSING = "Here's your draft cover letter — review and approve it.";

/** The context the Scribe assembles a letter against: the role and company it is
 *  applying to, plus a few candidate highlights folded into the body. */
export interface ScribeContext {
  roleTitle: string;
  companyName?: string | null;
  /** Short candidate highlights (e.g. from the live profile version) woven into
   *  the letter body; an empty list still yields a complete, generic letter. */
  highlights?: string[];
}

/**
 * Assemble a cover-letter draft from its context — the deterministic, network-free
 * stand-in for the real Scribe brain (which the later, non-stubbed implementation
 * drops in here). Pure: the same context always yields the same letter, so the
 * whole draft-assembly run is unit-testable with no live LLM.
 */
export function assembleCoverLetter(ctx: ScribeContext): string {
  const company = ctx.companyName?.trim() || "your team";
  const highlights = (ctx.highlights ?? []).map((h) => h.trim()).filter(Boolean);
  const body =
    highlights.length > 0
      ? `In particular: ${highlights.join("; ")}.`
      : "I bring the focus and ownership the role calls for.";
  return [
    `Dear ${company} Hiring Team,`,
    ``,
    `I'm excited to apply for the ${ctx.roleTitle} role. ${body}`,
    ``,
    `I'd welcome the chance to discuss how I can contribute.`,
    ``,
    `Kind regards,`,
  ].join("\n");
}

export interface ScribeArgs {
  threadId: string;
  runId: string;
  parentRunId?: string | null;
  /** The context the Scribe drafts against (role/company/highlights). */
  context: ScribeContext;
  /** The assembled letter for this run. The route injects real LLM output here
   *  (see ./scribe.ts); falls back to the deterministic assembleCoverLetter when
   *  absent, so the run loop stays a pure, testable stub. */
  content?: string;
}

/**
 * Produce the ordered event log for one Scribe run. Greets, opens an empty draft
 * in shared state, writes the assembled letter into `state.draft.content` with a
 * single StateDelta, flips the phase to `draft_ready`, confirms in text, and
 * finishes successfully. The final folded shared state is
 * `{ phase: "draft_ready", draft: { content: "…" } }`.
 */
export function scribeRun({
  threadId,
  runId,
  parentRunId = null,
  context,
  content: injected,
}: ScribeArgs): AgUiEvent[] {
  const content = injected ?? assembleCoverLetter(context);
  const open = `${runId}:m1`;
  const close = `${runId}:m2`;
  return [
    { type: "run_started", data: { threadId, runId, parentRunId } },
    { type: "step_started", data: { stepName: SCRIBE_STEP } },
    { type: "text_message_start", data: { messageId: open, role: "assistant" } },
    { type: "text_message_content", data: { messageId: open, delta: SCRIBE_GREETING } },
    { type: "text_message_end", data: { messageId: open } },
    { type: "state_snapshot", data: { snapshot: { phase: "drafting", draft: { content: "" } } } },
    {
      type: "state_delta",
      data: { delta: [{ op: "replace", path: "/draft/content", value: content }] },
    },
    {
      type: "state_delta",
      data: { delta: [{ op: "replace", path: "/phase", value: "draft_ready" }] },
    },
    { type: "text_message_start", data: { messageId: close, role: "assistant" } },
    { type: "text_message_content", data: { messageId: close, delta: SCRIBE_CLOSING } },
    { type: "text_message_end", data: { messageId: close } },
    { type: "step_finished", data: { stepName: SCRIBE_STEP } },
    {
      type: "run_finished",
      data: { threadId, runId, outcome: { type: "success", phase: "draft_ready" } },
    },
  ];
}

/** The Scribe's assembled letter, read out of folded shared state
 *  (`state.draft.content`). The text the route persists as a cover-letter version. */
export function draftContent(state: Json): string {
  const draft = (state as { draft?: { content?: string } } | null)?.draft;
  return draft?.content ?? "";
}

// ── The cover-letter submit run: end on an approve/edit/reject interrupt ───────
// The revision loop (ARC-38). Once the Scribe has left a proposed draft, submitting
// it for review re-presents the assembled letter in shared state and ends the run
// on a tool_call INTERRUPT whose responseSchema supports approve / reject /
// approve-with-edits (a full-replacement editedArgs). Mirrors runStub's interrupt
// branch; the route backs the interrupt with a 'cover_letter_version' proposal the
// owner resolves from any client (advancing candidacy in_review → approved | drafting).

const SUBMIT_STEP = "submit";
const SUBMIT_GREETING = "Submitting your cover letter for your approval.";
const SUBMIT_MESSAGE = "Approve this cover letter to use it for your application?";
/** The action the interrupt proposes — the cover-letter approval gate. */
const COVER_LETTER_ACTION = "approveCoverLetter";

export interface CoverLetterSubmitArgs {
  threadId: string;
  runId: string;
  parentRunId?: string | null;
  /** The proposed version being submitted; rides on the interrupt for the client. */
  versionId: string;
  /** The assembled letter, re-presented in shared state for review. */
  content: string;
}

/**
 * Produce the ordered event log for one cover-letter submit run. Re-presents the
 * assembled letter in shared state and finishes on a tool_call interrupt carrying
 * the approve/reject/approve-with-edits responseSchema. The final folded shared
 * state is `{ phase: "awaiting_approval", draft: { content: "…" }, versionId }`.
 */
export function coverLetterSubmitRun({
  threadId,
  runId,
  parentRunId = null,
  versionId,
  content,
}: CoverLetterSubmitArgs): AgUiEvent[] {
  const messageId = `${runId}:m1`;
  const toolCallId = `${runId}:tc1`;
  const interruptId = `${runId}:int1`;
  const proposedArgs = { versionId, content };
  return [
    { type: "run_started", data: { threadId, runId, parentRunId } },
    { type: "step_started", data: { stepName: SUBMIT_STEP } },
    { type: "text_message_start", data: { messageId, role: "assistant" } },
    { type: "text_message_content", data: { messageId, delta: SUBMIT_GREETING } },
    { type: "text_message_end", data: { messageId } },
    {
      type: "tool_call_start",
      data: { toolCallId, toolCallName: COVER_LETTER_ACTION, parentMessageId: messageId },
    },
    { type: "tool_call_args", data: { toolCallId, delta: JSON.stringify(proposedArgs) } },
    { type: "tool_call_end", data: { toolCallId } },
    {
      type: "state_snapshot",
      data: { snapshot: { phase: "awaiting_approval", draft: { content }, versionId } },
    },
    {
      type: "messages_snapshot",
      data: { messages: [{ id: messageId, role: "assistant", content: SUBMIT_GREETING }] },
    },
    { type: "step_finished", data: { stepName: SUBMIT_STEP } },
    {
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
              action: COVER_LETTER_ACTION,
              message: SUBMIT_MESSAGE,
              toolCallId,
              responseSchema: {
                type: "object",
                properties: {
                  approved: { type: "boolean" },
                  editedArgs: {
                    type: "object",
                    description:
                      "Full replacement of the cover-letter fields (content/label). Not merged.",
                  },
                },
                required: ["approved"],
              },
            },
          ],
        },
      },
    },
  ];
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

/** One RFC-6902 JSON Patch operation (the subset the state transport emits). */
export interface StatePatchOp {
  op: "add" | "replace" | "remove";
  path: string;
  value?: Json;
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
 * (the input is cloned, never mutated — so folding can't corrupt the source
 * events). Supports the add/replace/remove subset AG-UI StateDelta events use,
 * over object and array containers. Lenient by design (it's a projection, not a
 * validator): missing intermediate objects are created so a delta never throws.
 */
export function applyStatePatch(state: Json, ops: StatePatchOp[]): Json {
  const root = structuredClone(state ?? {}) as Json;
  for (const op of ops) {
    const tokens = pointerTokens(op.path);
    if (tokens.length === 0) {
      if (op.op !== "remove") return structuredClone(op.value ?? {}) as Json;
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

/**
 * Fold an ordered AG-UI event log into a StateSnapshot + MessagesSnapshot — the
 * history a reconnecting or brand-new client uses to rebuild the conversation.
 * The event log is the source of truth (docs/docs/ag-ui/concepts/02-events.md);
 * this is its projection, so a restored view is identical to the live one a
 * subscriber accumulated. Pure (no DB/IO) and order-only, so it is unit-testable
 * and independent of how the rows were fetched.
 *
 * - state_snapshot replaces the state object (last one wins).
 * - state_delta layers JSON-Patch (RFC-6902) ops onto the current state.
 * - messages_snapshot authoritatively replaces the message list.
 * - text_message_start/content materialize and grow a streamed message.
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
