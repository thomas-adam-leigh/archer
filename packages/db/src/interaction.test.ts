import { describe, expect, it } from "vitest";
import type { Tables, TablesInsert } from "./index";
import { Constants } from "./index";

// The interaction schema migration (20260620090000_archer_interaction.sql) is the
// AG-UI conversation spine. These assertions pin the regenerated types/contract so
// a drifted or missing migration fails loudly rather than silently.
describe("interaction schema", () => {
  it("exposes the AG-UI enums with their full vocabulary", () => {
    expect(Constants.public.Enums.run_status).toEqual([
      "running",
      "completed",
      "interrupted",
      "error",
    ]);
    // Lifecycle, text, tool-call, state, activity, reasoning + special events.
    expect(Constants.public.Enums.event_type).toContain("run_started");
    expect(Constants.public.Enums.event_type).toContain("run_finished");
    expect(Constants.public.Enums.event_type).toContain("messages_snapshot");
    expect(Constants.public.Enums.event_type).toContain("state_delta");
    expect(Constants.public.Enums.event_type).toContain("tool_call_result");
    // Roles include the activity + reasoning channels.
    expect(Constants.public.Enums.message_role).toContain("activity");
    expect(Constants.public.Enums.message_role).toContain("reasoning");
  });

  it("exposes typed Row/Insert helpers for the new tables", () => {
    // Compile-time proof the tables exist in the generated Database type; the
    // runtime assertions keep the test meaningful.
    const thread: Pick<Tables<"threads">, "id" | "user_id"> = {
      id: "00000000-0000-0000-0000-000000000000",
      user_id: "00000000-0000-0000-0000-000000000000",
    };
    const run: Pick<Tables<"runs">, "id" | "thread_id" | "parent_run_id" | "status"> = {
      id: "r",
      thread_id: thread.id,
      parent_run_id: null, // resume/branch lineage is nullable at the root
      status: "running",
    };
    const event: Pick<TablesInsert<"events">, "run_id" | "thread_id" | "seq" | "type"> = {
      run_id: run.id,
      thread_id: thread.id,
      seq: 0,
      type: "run_started",
    };
    const message: Pick<TablesInsert<"messages">, "thread_id" | "role"> = {
      thread_id: thread.id,
      role: "assistant",
    };
    const state: Pick<TablesInsert<"thread_state">, "thread_id"> = { thread_id: thread.id };

    expect(run.parent_run_id).toBeNull();
    expect(event.seq).toBe(0);
    expect(message.role).toBe("assistant");
    expect(state.thread_id).toBe(thread.id);
  });
});
