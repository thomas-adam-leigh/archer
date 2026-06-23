import { afterEach, describe, expect, test, vi } from "vitest";

import type { EventRow } from "./event-log.js";
import type { AguiEvent } from "./events.js";
import type { RealtimeSubscription, RealtimeTransport, SubscribeOptions } from "./realtime.js";
import { type AguiHttp, createThreadSession } from "./thread-session.js";

const run1: AguiEvent[] = [
  { type: "run_started", data: { runId: "r1" } },
  {
    type: "text_message_start",
    data: { messageId: "r1:m1", role: "assistant" },
  },
  { type: "text_message_content", data: { messageId: "r1:m1", delta: "Hi" } },
  { type: "state_snapshot", data: { snapshot: { phase: "greeted" } } },
  { type: "run_finished", data: { outcome: { type: "success" } } },
];

function rowsFor(runId: string, events: AguiEvent[]): EventRow[] {
  return events.map((e, seq) => ({
    type: e.type,
    data: e.data,
    seq,
    run_id: runId,
  }));
}

/** A fake transport that hands the test the live `onInsert` to push rows into. */
function fakeTransport() {
  let opts: SubscribeOptions | undefined;
  const sub: RealtimeSubscription = { unsubscribe: vi.fn() };
  const transport: RealtimeTransport = {
    subscribe: vi.fn((o: SubscribeOptions) => {
      opts = o;
      return sub;
    }),
  };
  return {
    transport,
    sub,
    push: (row: EventRow) => opts?.onInsert(row),
    optsRef: () => opts,
  };
}

afterEach(() => vi.clearAllMocks());

describe("createThreadSession", () => {
  test("loadHistory seeds the view from the persisted log", async () => {
    const onChange = vi.fn();
    const http: AguiHttp = {
      get: vi.fn(async () => ({
        threadId: "t1",
        state: {},
        events: rowsFor("r1", run1),
      })),
      post: vi.fn(),
    };
    const session = createThreadSession({
      threadId: "t1",
      accessToken: "tok",
      http,
      transport: fakeTransport().transport,
      onChange,
    });

    const view = await session.loadHistory();

    expect(http.get).toHaveBeenCalledWith("/agui/threads/t1/history");
    expect(view.phase).toBe("completed");
    expect(view.state).toEqual({ phase: "greeted" });
    expect(view.messages).toEqual([{ id: "r1:m1", role: "assistant", content: "Hi" }]);
    expect(onChange).toHaveBeenCalledWith(view);
  });

  test("run posts to /agui/run with the threadId merged and folds the response", async () => {
    const onChange = vi.fn();
    const http: AguiHttp = {
      get: vi.fn(),
      post: vi.fn(async () => ({
        threadId: "t1",
        runId: "r1",
        status: "completed",
        events: run1,
      })),
    };
    const session = createThreadSession({
      threadId: "t1",
      accessToken: "tok",
      http,
      transport: fakeTransport().transport,
      onChange,
    });

    const result = await session.run({
      forwardedProps: { outcome: "success" },
    });

    expect(http.post).toHaveBeenCalledWith("/agui/run", {
      threadId: "t1",
      forwardedProps: { outcome: "success" },
    });
    expect(result.status).toBe("completed");
    expect(session.view().phase).toBe("completed");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("a live Realtime insert advances the view", async () => {
    const onChange = vi.fn();
    const rt = fakeTransport();
    const session = createThreadSession({
      threadId: "t1",
      accessToken: "tok",
      http: { get: vi.fn(), post: vi.fn() },
      transport: rt.transport,
      onChange,
    });

    session.subscribe();
    expect(rt.optsRef()?.threadId).toBe("t1");
    expect(rt.optsRef()?.accessToken).toBe("tok");

    for (const row of rowsFor("r1", run1)) rt.push(row);

    expect(session.view().phase).toBe("completed");
    expect(session.view().state).toEqual({ phase: "greeted" });
    expect(onChange).toHaveBeenCalled();
  });

  test("Realtime redelivery of a run’s own events does not double-apply", async () => {
    const onChange = vi.fn();
    const rt = fakeTransport();
    const http: AguiHttp = {
      get: vi.fn(),
      post: vi.fn(async () => ({
        threadId: "t1",
        runId: "r1",
        status: "completed",
        events: run1,
      })),
    };
    const session = createThreadSession({
      threadId: "t1",
      accessToken: "tok",
      http,
      transport: rt.transport,
      onChange,
    });

    session.subscribe();
    await session.run();
    onChange.mockClear();

    // The same rows now arrive over Realtime — must be ignored.
    for (const row of rowsFor("r1", run1)) rt.push(row);

    expect(onChange).not.toHaveBeenCalled();
    expect(session.view().messages).toHaveLength(1);
  });

  test("an idempotent replay response folds nothing", async () => {
    const onChange = vi.fn();
    const http: AguiHttp = {
      get: vi.fn(),
      post: vi.fn(async () => ({
        threadId: "t1",
        status: "noop",
        replay: true,
      })),
    };
    const session = createThreadSession({
      threadId: "t1",
      accessToken: "tok",
      http,
      transport: fakeTransport().transport,
      onChange,
    });

    const result = await session.resume([{ interruptId: "i1", status: "resolved" }]);

    expect(http.post).toHaveBeenCalledWith("/agui/run", {
      threadId: "t1",
      resume: [{ interruptId: "i1", status: "resolved" }],
    });
    expect(result.replay).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(session.view().phase).toBeNull();
  });

  test("apply folds a run response from another run-producing endpoint", () => {
    const session = createThreadSession({
      threadId: "t1",
      accessToken: "tok",
      http: { get: vi.fn(), post: vi.fn() },
      transport: fakeTransport().transport,
    });

    const view = session.apply({ runId: "r1", events: run1 });
    expect(view.phase).toBe("completed");

    // A streamed endpoint that returns no events is a no-op (Realtime carries it).
    expect(session.apply({ runId: "r2" }).phase).toBe("completed");
  });

  test("close unsubscribes the live transport", () => {
    const rt = fakeTransport();
    const session = createThreadSession({
      threadId: "t1",
      accessToken: "tok",
      http: { get: vi.fn(), post: vi.fn() },
      transport: rt.transport,
    });

    session.subscribe();
    session.close();

    expect(rt.sub.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
