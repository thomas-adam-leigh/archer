import { describe, expect, test } from "vitest";

import {
  type AguiEvent,
  applyStatePatch,
  foldEvents,
  type Json,
  type StatePatchOp,
} from "./events.js";

describe("applyStatePatch", () => {
  test("add / replace / remove on an object, without mutating the input", () => {
    const state: Json = { a: 1, b: 2 };
    const ops: StatePatchOp[] = [
      { op: "add", path: "/c", value: 3 },
      { op: "replace", path: "/a", value: 10 },
      { op: "remove", path: "/b" },
    ];
    expect(applyStatePatch(state, ops)).toEqual({ a: 10, c: 3 });
    expect(state).toEqual({ a: 1, b: 2 });
  });

  test("creates missing intermediate objects (lenient)", () => {
    expect(applyStatePatch({}, [{ op: "add", path: "/draft/name", value: "Ada" }])).toEqual({
      draft: { name: "Ada" },
    });
  });

  test("append and remove on arrays", () => {
    const after = applyStatePatch({ xs: ["a", "b"] }, [
      { op: "add", path: "/xs/-", value: "c" },
      { op: "remove", path: "/xs/0" },
    ]);
    expect(after).toEqual({ xs: ["b", "c"] });
  });

  test("an empty path replaces the whole document", () => {
    expect(applyStatePatch({ a: 1 }, [{ op: "replace", path: "", value: { b: 2 } }])).toEqual({
      b: 2,
    });
  });
});

describe("foldEvents", () => {
  test("state_snapshot then state_delta accretes a draft", () => {
    const events: AguiEvent[] = [
      { type: "state_snapshot", data: { snapshot: { phase: "greeted" } } },
      {
        type: "state_delta",
        data: { delta: [{ op: "add", path: "/draft", value: {} }] },
      },
      {
        type: "state_delta",
        data: {
          delta: [{ op: "add", path: "/draft/name", value: "Ada Lovelace" }],
        },
      },
    ];
    expect(foldEvents(events).state).toEqual({
      phase: "greeted",
      draft: { name: "Ada Lovelace" },
    });
  });

  test("streams a text message from start/content deltas", () => {
    const events: AguiEvent[] = [
      { type: "run_started", data: {} },
      {
        type: "text_message_start",
        data: { messageId: "m1", role: "assistant" },
      },
      {
        type: "text_message_content",
        data: { messageId: "m1", delta: "Hello " },
      },
      {
        type: "text_message_content",
        data: { messageId: "m1", delta: "Archer" },
      },
      { type: "text_message_end", data: { messageId: "m1" } },
    ];
    expect(foldEvents(events).messages).toEqual([
      { id: "m1", role: "assistant", content: "Hello Archer" },
    ]);
  });

  test("messages_snapshot authoritatively replaces the message list", () => {
    const events: AguiEvent[] = [
      {
        type: "text_message_start",
        data: { messageId: "m1", role: "assistant" },
      },
      {
        type: "text_message_content",
        data: { messageId: "m1", delta: "draft" },
      },
      {
        type: "messages_snapshot",
        data: {
          messages: [
            { id: "u1", role: "user", content: "hi" },
            { id: "a1", role: "assistant", content: "hello" },
          ],
        },
      },
    ];
    expect(foldEvents(events).messages).toEqual([
      { id: "u1", role: "user", content: "hi" },
      { id: "a1", role: "assistant", content: "hello" },
    ]);
  });

  test("a successful run ends in the completed phase with no interrupts", () => {
    const view = foldEvents([
      { type: "run_started", data: {} },
      { type: "run_finished", data: { outcome: { type: "success" } } },
    ]);
    expect(view.phase).toBe("completed");
    expect(view.interrupts).toEqual([]);
    expect(view.error).toBeUndefined();
  });

  test("an interrupt run surfaces the open interrupt for the approval UI", () => {
    const view = foldEvents([
      { type: "run_started", data: {} },
      {
        type: "run_finished",
        data: {
          outcome: {
            type: "interrupt",
            interrupts: [
              {
                id: "int-1",
                reason: "tool_call",
                action: "sendEmail",
                message: "Approve sending?",
                toolCallId: "tc1",
                responseSchema: { type: "object" },
              },
            ],
          },
        },
      },
    ]);
    expect(view.phase).toBe("interrupted");
    expect(view.interrupts).toHaveLength(1);
    expect(view.interrupts[0]).toMatchObject({
      id: "int-1",
      action: "sendEmail",
    });
  });

  test("a fresh run_started clears interrupts from a prior interrupted run", () => {
    const view = foldEvents([
      {
        type: "run_finished",
        data: { outcome: { type: "interrupt", interrupts: [{ id: "int-1" }] } },
      },
      { type: "run_started", data: {} },
    ]);
    expect(view.phase).toBe("running");
    expect(view.interrupts).toEqual([]);
  });

  test("run_error captures the phase and message", () => {
    const view = foldEvents([
      { type: "run_started", data: {} },
      {
        type: "run_error",
        data: { message: "pending interrupts must be resolved" },
      },
    ]);
    expect(view.phase).toBe("error");
    expect(view.error).toBe("pending interrupts must be resolved");
  });

  test("an empty log folds to the initial view", () => {
    expect(foldEvents([])).toEqual({
      state: {},
      messages: [],
      interrupts: [],
      phase: null,
    });
  });
});
