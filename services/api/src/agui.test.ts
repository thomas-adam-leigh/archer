import { describe, expect, it } from "vitest";
import {
  type AgUiEvent,
  applyStatePatch,
  assembleCoverLetter,
  classifyRun,
  draftAttributes,
  draftContent,
  interruptsFromEvents,
  onboardingRun,
  outcomeFromEvents,
  restoreThread,
  runError,
  runStub,
  scribeRun,
  statusFromEvents,
} from "./agui";

const THREAD = "11111111-1111-1111-1111-111111111111";
const RUN = "22222222-2222-2222-2222-222222222222";
const types = (events: AgUiEvent[]) => events.map((e) => e.type);
const success = () => runStub({ threadId: THREAD, runId: RUN, input: { threadId: THREAD } });
const interrupt = () =>
  runStub({
    threadId: THREAD,
    runId: RUN,
    input: { threadId: THREAD, forwardedProps: { outcome: "interrupt" } },
  });

describe("runStub — AG-UI run lifecycle (stubbed agent)", () => {
  it("emits the exact success sequence, bounded by RunStarted/RunFinished", () => {
    const events = success();
    expect(types(events)).toEqual([
      "run_started",
      "step_started",
      "text_message_start",
      "text_message_content",
      "text_message_end",
      "state_snapshot",
      "step_finished",
      "run_finished",
    ]);
    // Every run is bounded: first RunStarted, last RunFinished, exactly one each.
    expect(events[0].type).toBe("run_started");
    expect(events.at(-1)?.type).toBe("run_finished");
    expect(types(events).filter((t) => t === "run_started")).toHaveLength(1);
    expect(types(events).filter((t) => t === "run_finished")).toHaveLength(1);
  });

  it("carries a success outcome on the terminal RunFinished", () => {
    const events = success();
    expect(events.at(-1)?.data).toMatchObject({
      threadId: THREAD,
      runId: RUN,
      outcome: { type: "success" },
    });
    expect(statusFromEvents(events)).toBe("completed");
    expect(outcomeFromEvents(events)).toEqual({ type: "success" });
  });

  it("streams one TextMessage start→content→end triplet sharing a messageId with non-empty delta", () => {
    const text = success().filter((e) => e.type.startsWith("text_message"));
    expect(text.map((e) => e.type)).toEqual([
      "text_message_start",
      "text_message_content",
      "text_message_end",
    ]);
    const ids = new Set(text.map((e) => (e.data as { messageId: string }).messageId));
    expect(ids.size).toBe(1);
    expect((text[1].data as { delta: string }).delta.length).toBeGreaterThan(0);
  });

  it("emits at least one StateSnapshot before RunFinished", () => {
    const events = success();
    const snap = events.findIndex((e) => e.type === "state_snapshot");
    const fin = events.findIndex((e) => e.type === "run_finished");
    expect(snap).toBeGreaterThanOrEqual(0);
    expect(snap).toBeLessThan(fin);
  });

  it("can be scripted to end in an interrupt outcome with a single interrupt", () => {
    const events = interrupt();
    expect(events[0].type).toBe("run_started");
    expect(events.at(-1)?.type).toBe("run_finished");
    const outcome = outcomeFromEvents(events) as { type: string; interrupts: unknown[] };
    expect(outcome.type).toBe("interrupt");
    expect(outcome.interrupts).toHaveLength(1);
    expect(statusFromEvents(events)).toBe("interrupted");
  });

  it("snapshots state + messages before the interrupt (resume contract)", () => {
    const events = interrupt();
    const state = events.findIndex((e) => e.type === "state_snapshot");
    const msgs = events.findIndex((e) => e.type === "messages_snapshot");
    const fin = events.findIndex((e) => e.type === "run_finished");
    expect(state).toBeGreaterThanOrEqual(0);
    expect(msgs).toBeGreaterThanOrEqual(0);
    expect(state).toBeLessThan(fin);
    expect(msgs).toBeLessThan(fin);
  });

  it("proposes a tool call whose interrupt is bound to the toolCallId and carries a responseSchema", () => {
    const events = interrupt();
    expect(events.filter((e) => e.type.startsWith("tool_call")).map((e) => e.type)).toEqual([
      "tool_call_start",
      "tool_call_args",
      "tool_call_end",
    ]);
    const start = events.find((e) => e.type === "tool_call_start")?.data as { toolCallId: string };
    const outcome = outcomeFromEvents(events) as {
      interrupts: Array<{
        toolCallId: string;
        reason: string;
        responseSchema: { required: string[] };
      }>;
    };
    const int = outcome.interrupts[0];
    expect(int.toolCallId).toBe(start.toolCallId);
    expect(int.reason).toBe("tool_call");
    expect(int.responseSchema.required).toContain("approved");
  });

  it("derives ids from the runId so events are deterministic and run-scoped", () => {
    const a = runStub({ threadId: THREAD, runId: "run-a", input: { threadId: THREAD } });
    const b = runStub({ threadId: THREAD, runId: "run-b", input: { threadId: THREAD } });
    const idOf = (events: AgUiEvent[]) =>
      (events.find((e) => e.type === "text_message_start")?.data as { messageId: string })
        .messageId;
    expect(idOf(a)).toBe("run-a:m1");
    expect(idOf(b)).toBe("run-b:m1");
  });
});

describe("restoreThread — history restore projection", () => {
  const GREETING = "Hi — I'm Archer. Let's get your job hunt set up.";

  it("rebuilds StateSnapshot + MessagesSnapshot from the success event log", () => {
    const events = success();
    const { state, messages } = restoreThread(events);
    expect(state).toEqual({ phase: "greeted" });
    expect(messages).toEqual([{ id: `${RUN}:m1`, role: "assistant", content: GREETING }]);
  });

  it("rebuilds the interrupt thread (state at awaiting_approval, snapshot messages)", () => {
    const events = interrupt();
    const { state, messages } = restoreThread(events);
    expect(state).toEqual({ phase: "awaiting_approval" });
    expect(messages).toEqual([{ id: `${RUN}:m1`, role: "assistant", content: GREETING }]);
  });

  it("restored == live: the projection depends only on seq order, not fetch order", () => {
    // What a subscriber saw live (emission order) vs. what a reconnecting client
    // restores from the persisted log. Shuffle the persisted rows, then replay in
    // the recorded seq order — restore must match the live view exactly.
    const live = restoreThread(success());
    const persisted = success().map((e, seq) => ({ ...e, seq }));
    const shuffled = [
      persisted[4],
      persisted[0],
      persisted[6],
      persisted[2],
      persisted[1],
      persisted[3],
      persisted[5],
      persisted[7],
    ];
    const restored = restoreThread([...shuffled].sort((a, b) => a.seq - b.seq));
    expect(restored).toEqual(live);
  });

  it("a later state_snapshot wins (last-write replace)", () => {
    const events: AgUiEvent[] = [
      { type: "state_snapshot", data: { snapshot: { phase: "a" } } },
      { type: "state_snapshot", data: { snapshot: { phase: "b" } } },
    ];
    expect(restoreThread(events).state).toEqual({ phase: "b" });
  });

  it("returns empty state and no messages for a thread with no events", () => {
    expect(restoreThread([])).toEqual({ state: {}, messages: [] });
  });
});

describe("runStub — autonomy gates the proposed tool call", () => {
  const base = { threadId: THREAD, runId: RUN };

  it("interrupts when the action needs approval (default fail-closed policy)", () => {
    const events = runStub({
      ...base,
      input: { threadId: THREAD, forwardedProps: { outcome: "interrupt" } },
    });
    expect(statusFromEvents(events)).toBe("interrupted");
    const int = interruptsFromEvents(events)[0];
    expect(int.action).toBe("sendEmail");
    expect(int.toolCallId).toBe(`${RUN}:tc1`);
  });

  it("auto-executes in the same run when the policy grants autonomy", () => {
    const events = runStub({
      ...base,
      input: { threadId: THREAD, forwardedProps: { outcome: "interrupt" } },
      policy: { sendEmail: "auto" },
    });
    expect(statusFromEvents(events)).toBe("completed");
    expect(events.some((e) => e.type === "messages_snapshot")).toBe(false);
    const result = events.find((e) => e.type === "tool_call_result")?.data as {
      result: { status: string; auto?: boolean };
    };
    expect(result.result).toMatchObject({ status: "executed", auto: true });
    expect(outcomeFromEvents(events)).toEqual({ type: "success" });
  });
});

describe("runStub — resume continuation (the human's decision)", () => {
  const resumeInput = {
    threadId: THREAD,
    resume: [
      { interruptId: `${RUN}:int1`, status: "resolved" as const, payload: { approved: true } },
    ],
  };

  it("consumes an approval: emits a ToolCallResult(executed) and finishes success", () => {
    const events = runStub({
      threadId: THREAD,
      runId: "child-run",
      parentRunId: RUN,
      input: resumeInput,
      resolved: [
        {
          interruptId: `${RUN}:int1`,
          toolCallId: `${RUN}:tc1`,
          approved: true,
          editedArgs: { to: "a@b.c" },
        },
      ],
    });
    expect(events[0].type).toBe("run_started");
    expect((events[0].data as { parentRunId: string }).parentRunId).toBe(RUN);
    const result = events.find((e) => e.type === "tool_call_result")?.data as {
      toolCallId: string;
      result: { status: string; args: unknown };
    };
    expect(result.toolCallId).toBe(`${RUN}:tc1`);
    expect(result.result).toEqual({ status: "executed", args: { to: "a@b.c" } });
    expect(statusFromEvents(events)).toBe("completed");
    expect(restoreThread(events).state).toEqual({ phase: "completed" });
  });

  it("consumes a rejection: skips the tool and declines", () => {
    const events = runStub({
      threadId: THREAD,
      runId: "child-run",
      parentRunId: RUN,
      input: { threadId: THREAD, resume: [{ interruptId: `${RUN}:int1`, status: "cancelled" }] },
      resolved: [{ interruptId: `${RUN}:int1`, toolCallId: `${RUN}:tc1`, approved: false }],
    });
    const result = events.find((e) => e.type === "tool_call_result")?.data as {
      result: { status: string };
    };
    expect(result.result).toEqual({ status: "skipped" });
    expect(statusFromEvents(events)).toBe("completed");
    expect(restoreThread(events).state).toEqual({ phase: "declined" });
  });
});

describe("runError — a bounded, persisted RunError run", () => {
  it("emits run_started then run_error and reports status 'error'", () => {
    const events = runError(THREAD, RUN, "pending interrupts must be resolved before new input");
    expect(events.map((e) => e.type)).toEqual(["run_started", "run_error"]);
    expect((events[1].data as { message: string }).message).toContain("pending interrupts");
    expect(statusFromEvents(events)).toBe("error");
  });
});

describe("classifyRun — the interrupt/resume contract", () => {
  it("start: no resume, no open interrupts → a fresh run", () => {
    expect(classifyRun({ state: { open: [], decided: [] } })).toEqual({ action: "start" });
  });

  it("pending-interrupts-block-new-input: a non-resume request while open → RunError", () => {
    const d = classifyRun({ state: { open: ["i1"], decided: [] } });
    expect(d).toMatchObject({ action: "error" });
    expect((d as { reason: string }).reason).toContain("pending interrupts");
  });

  it("same-thread: a resume targeting an unknown interrupt → RunError", () => {
    // "other:int" belongs to another thread, so it is in neither open nor decided.
    const d = classifyRun({
      resume: [{ interruptId: "other:int", status: "resolved" }],
      state: { open: ["i1"], decided: [] },
    });
    expect(d).toMatchObject({ action: "error" });
    expect((d as { reason: string }).reason).toContain("unknown interrupt");
  });

  it("cover-all-open-interrupts: resolving some but not all open → RunError", () => {
    const d = classifyRun({
      resume: [{ interruptId: "i1", status: "resolved" }],
      state: { open: ["i1", "i2"], decided: [] },
    });
    expect(d).toMatchObject({ action: "error" });
    expect((d as { reason: string }).reason).toContain("cover all open interrupts");
  });

  it("resume: a request covering every open interrupt → resume", () => {
    const resume = [
      { interruptId: "i1", status: "resolved" as const },
      { interruptId: "i2", status: "cancelled" as const },
    ];
    expect(classifyRun({ resume, state: { open: ["i1", "i2"], decided: [] } })).toEqual({
      action: "resume",
      resolves: resume,
    });
  });

  it("idempotent replay: a resume referencing only already-decided interrupts → replay", () => {
    const d = classifyRun({
      resume: [{ interruptId: "i1", status: "resolved" }],
      state: { open: [], decided: ["i1"] },
    });
    expect(d).toEqual({ action: "replay" });
  });
});

describe("applyStatePatch — JSON-Patch (RFC-6902) state deltas", () => {
  it("adds, replaces, and removes object members without mutating the input", () => {
    const before = { a: 1, nested: { keep: true } };
    const after = applyStatePatch(before as never, [
      { op: "add", path: "/b", value: 2 },
      { op: "replace", path: "/a", value: 9 },
      { op: "remove", path: "/nested/keep" },
    ]);
    expect(after).toEqual({ a: 9, b: 2, nested: {} });
    // The source object is cloned, never mutated — folding can't corrupt events.
    expect(before).toEqual({ a: 1, nested: { keep: true } });
  });

  it("creates missing intermediate objects (lenient projection, never throws)", () => {
    expect(
      applyStatePatch({} as never, [{ op: "add", path: "/draft/attributes/x", value: 1 }]),
    ).toEqual({ draft: { attributes: { x: 1 } } });
  });

  it("unescapes JSON Pointer tokens (~1 → /, ~0 → ~)", () => {
    const out = applyStatePatch({} as never, [{ op: "add", path: "/a~1b", value: "v" }]);
    expect(out).toEqual({ "a/b": "v" });
  });

  it("supports array append (-) and indexed insert", () => {
    const out = applyStatePatch({ list: ["a"] } as never, [
      { op: "add", path: "/list/-", value: "c" },
      { op: "add", path: "/list/1", value: "b" },
    ]);
    expect(out).toEqual({ list: ["a", "b", "c"] });
  });
});

describe("onboardingRun — shared-state draft assembly → version proposal", () => {
  const args = { threadId: THREAD, runId: RUN };

  it("opens an empty draft snapshot then accretes it with one delta per field", () => {
    const events = onboardingRun({ ...args, draft: { ideal_job: "staff eng", why: "impact" } });
    const seq = types(events);
    expect(seq[0]).toBe("run_started");
    expect(seq.at(-1)).toBe("run_finished");
    // A single StateSnapshot opens the draft; deltas (not snapshots) accrete it.
    expect(seq.filter((t) => t === "state_snapshot")).toHaveLength(1);
    // one delta per field + one phase flip
    expect(seq.filter((t) => t === "state_delta")).toHaveLength(3);
    expect(statusFromEvents(events)).toBe("completed");
  });

  it("folds to the assembled draft in shared state (draft_ready)", () => {
    const draft = { ideal_job: "staff eng", ai_fluency: "high" };
    const events = onboardingRun({ ...args, draft });
    const restore = events.map((e) => ({ type: e.type, data: e.data }));
    const { state } = restoreThread(restore);
    expect((state as { phase: string }).phase).toBe("draft_ready");
    expect(draftAttributes(state)).toEqual(draft);
  });

  it("uses a default draft when the caller supplies none", () => {
    const events = onboardingRun(args);
    const { state } = restoreThread(events.map((e) => ({ type: e.type, data: e.data })));
    expect(Object.keys(draftAttributes(state) as object).length).toBeGreaterThan(0);
  });
});

describe("assembleCoverLetter — deterministic Scribe stand-in", () => {
  it("addresses the company and names the role, weaving in highlights", () => {
    const letter = assembleCoverLetter({
      roleTitle: "Staff Engineer",
      companyName: "Acme Corp",
      highlights: ["shipped product end to end", "comfortable with LLMs"],
    });
    expect(letter).toContain("Dear Acme Corp Hiring Team,");
    expect(letter).toContain("Staff Engineer");
    expect(letter).toContain("shipped product end to end; comfortable with LLMs");
  });

  it("is deterministic — same context yields the same letter", () => {
    const ctx = { roleTitle: "Designer", companyName: "Globex", highlights: ["a"] };
    expect(assembleCoverLetter(ctx)).toBe(assembleCoverLetter(ctx));
  });

  it("still produces a complete letter with no company or highlights", () => {
    const letter = assembleCoverLetter({ roleTitle: "Analyst" });
    expect(letter).toContain("Dear your team Hiring Team,");
    expect(letter).toContain("Analyst");
    expect(letter).toContain("Kind regards,");
  });
});

describe("scribeRun — shared-state cover-letter draft assembly", () => {
  const args = { threadId: THREAD, runId: RUN };

  it("opens an empty draft snapshot then writes the letter with one delta", () => {
    const events = scribeRun({
      ...args,
      context: { roleTitle: "Staff Engineer", companyName: "Acme" },
    });
    const seq = types(events);
    expect(seq[0]).toBe("run_started");
    expect(seq.at(-1)).toBe("run_finished");
    expect(seq.filter((t) => t === "state_snapshot")).toHaveLength(1);
    // one delta to write the content + one to flip the phase
    expect(seq.filter((t) => t === "state_delta")).toHaveLength(2);
    expect(statusFromEvents(events)).toBe("completed");
  });

  it("folds to the assembled letter in shared state (draft_ready)", () => {
    const context = { roleTitle: "Staff Engineer", companyName: "Acme", highlights: ["impact"] };
    const events = scribeRun({ ...args, context });
    const { state } = restoreThread(events.map((e) => ({ type: e.type, data: e.data })));
    expect((state as { phase: string }).phase).toBe("draft_ready");
    expect(draftContent(state)).toBe(assembleCoverLetter(context));
    expect(draftContent(state)).toContain("Acme");
  });

  it("draftContent is empty for state with no draft", () => {
    expect(draftContent({})).toBe("");
  });
});
