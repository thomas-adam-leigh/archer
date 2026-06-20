import { describe, expect, it } from "vitest";
import {
  type AgUiEvent,
  outcomeFromEvents,
  restoreThread,
  runStub,
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
