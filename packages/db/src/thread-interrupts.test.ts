import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createCoverLetterVersion,
  createInterruptProposal,
  decideInterruptProposal,
  loadThreadInterrupts,
  submitCoverLetterVersionProposal,
} from "./queries.js";

// Integration test for the interrupt/resume gate's source of truth (ARC-48).
//
// `loadThreadInterrupts` projects every open interrupt on a thread from the
// proposals substrate; the /agui/run route splits those into open vs decided and
// feeds them to classifyRun to enforce pending-interrupts-block-new-input. The bug:
// it only saw kind 'tool_call' with a top-level plan->>'threadId', so cover-letter
// submits — kind 'cover_letter_version', locator nested at plan->'interrupt' — were
// invisible, letting new input slip past the gate. These assertions pin that every
// interrupt-bearing kind on a thread is surfaced, regardless of where its locator
// sits, and that resume/decide still resolves them.
//
// Targets the same migrated Postgres as packages/db/scripts/gen-types.sh builds.
// Point TEST_DATABASE_URL at it to run; skipped otherwise so no-DB CI stays green.
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// One synthetic signup + two threads + a candidacy. UUIDs are fixed + namespaced
// (…048) so reruns are idempotent.
const userId = "cccccccc-0000-4000-8000-000000000048";
const threadId = "dddddddd-0000-4000-8000-000000000048";
const otherThreadId = "dddddddd-0000-4000-8000-000000000049";
const boardSlug = "test-board-048";

describe.skipIf(!TEST_DB_URL)(
  "loadThreadInterrupts — every interrupt-bearing kind on the thread",
  () => {
    let sql: postgres.Sql;
    let candidacyId: string;

    const cleanup = async (db: postgres.Sql) => {
      // Proposals are linked either by candidacy FK (cover_letter_version) or only by a
      // thread locator in plan jsonb (tool_call has candidacy_id = null), so clear both
      // ways before the user cascade. Then users cascades to threads/candidacies/
      // cover_letter_versions; postings hang off the board.
      await db`delete from public.proposals
      where plan->>'threadId' in (${threadId}, ${otherThreadId})
         or plan->'interrupt'->>'threadId' in (${threadId}, ${otherThreadId})
         or candidacy_id in (select id from public.candidacies where user_id = ${userId})`;
      await db`delete from public.users where id = ${userId}`;
      await db`delete from auth.users where id = ${userId}`;
      await db`delete from public.postings where board_slug = ${boardSlug}`;
      await db`delete from public.boards where slug = ${boardSlug}`;
    };

    const seed = async (db: postgres.Sql): Promise<string> => {
      await db`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${userId}, 'arc48@example.com', ${db.json({ full_name: "Ivan Interrupt" })})`;
      await db`insert into public.threads (id, user_id) values (${threadId}, ${userId})`;
      await db`insert into public.threads (id, user_id) values (${otherThreadId}, ${userId})`;
      await db`
      insert into public.boards (slug, name, base_url, cred_env_prefix)
      values (${boardSlug}, 'Test Board', 'https://example.test', 'TEST_BOARD_048')`;
      const posting = await db<{ id: string }[]>`
      insert into public.postings (board_slug, url, title)
      values (${boardSlug}, 'https://example.test/job/1', 'Staff Engineer')
      returning id`;
      const candidacy = await db<{ id: string }[]>`
      insert into public.candidacies (user_id, posting_id, status)
      values (${userId}, ${posting[0].id}, 'drafting')
      returning id`;
      return candidacy[0].id;
    };

    beforeAll(async () => {
      sql = postgres(TEST_DB_URL as string, { prepare: false, max: 1 });
    });

    beforeEach(async () => {
      await cleanup(sql);
      candidacyId = await seed(sql);
    });

    afterAll(async () => {
      await cleanup(sql);
      await sql.end();
    });

    // Back a cover-letter submit interrupt on `threadId`, exactly as /cover-letters/submit
    // does: a draft version + a 'cover_letter_version' proposal whose locator is nested
    // under plan->'interrupt'. Returns the proposal id + the interrupt locator.
    const submitCoverLetterInterrupt = async (
      thread: string,
      runId: string,
    ): Promise<{ proposalId: string; interruptId: string; toolCallId: string }> => {
      const version = await createCoverLetterVersion(sql, {
        candidacyId,
        userId,
        content: "Dear team",
      });
      const interrupt = {
        threadId: thread,
        runId,
        interruptId: `${runId}:int1`,
        toolCallId: `${runId}:tc1`,
      };
      const proposal = await submitCoverLetterVersionProposal(sql, {
        candidacyId,
        userId,
        versionId: version.id,
        title: "Approve your cover letter",
        interrupt,
      });
      return {
        proposalId: proposal.id,
        interruptId: interrupt.interruptId,
        toolCallId: interrupt.toolCallId,
      };
    };

    it("surfaces a cover_letter_version interrupt whose locator is nested under plan->'interrupt'", async () => {
      const { proposalId, interruptId, toolCallId } = await submitCoverLetterInterrupt(
        threadId,
        "run-cl-1",
      );

      const interrupts = await loadThreadInterrupts(sql, threadId);

      expect(interrupts).toHaveLength(1);
      expect(interrupts[0]).toMatchObject({
        proposalId,
        interruptId,
        runId: "run-cl-1",
        toolCallId,
        status: "submitted",
      });
    });

    it("surfaces both a tool_call and a cover_letter_version interrupt on the same thread", async () => {
      await createInterruptProposal(sql, {
        threadId,
        runId: "run-tc-1",
        interruptId: "run-tc-1:int1",
        toolCallId: "run-tc-1:tc1",
        action: "proposeTool",
        title: "Approve tool",
      });
      const cl = await submitCoverLetterInterrupt(threadId, "run-cl-2");

      const interrupts = await loadThreadInterrupts(sql, threadId);
      const open = interrupts.filter((i) => i.status === "submitted").map((i) => i.interruptId);

      expect(open).toHaveLength(2);
      expect(open).toEqual(expect.arrayContaining(["run-tc-1:int1", cl.interruptId]));
    });

    it("scopes to the thread — a cover_letter_version interrupt on another thread is not returned", async () => {
      await submitCoverLetterInterrupt(otherThreadId, "run-cl-other");
      const mine = await submitCoverLetterInterrupt(threadId, "run-cl-mine");

      const interrupts = await loadThreadInterrupts(sql, threadId);

      expect(interrupts).toHaveLength(1);
      expect(interrupts[0].interruptId).toBe(mine.interruptId);
    });

    it("reflects a decided cover-letter interrupt as no longer open (resume/idempotent replay)", async () => {
      const { proposalId, interruptId } = await submitCoverLetterInterrupt(threadId, "run-cl-3");

      // The resume path resolves the open interrupt via decideInterruptProposal.
      const first = await decideInterruptProposal(sql, proposalId, {
        status: "approved",
        note: "ok",
      });
      expect(first?.id).toBe(proposalId);
      // Idempotent replay: a second decide on the now-decided proposal is a no-op.
      const replay = await decideInterruptProposal(sql, proposalId, { status: "approved" });
      expect(replay).toBeUndefined();

      const interrupts = await loadThreadInterrupts(sql, threadId);
      const open = interrupts.filter((i) => i.status === "submitted").map((i) => i.interruptId);
      const decided = interrupts.filter((i) => i.status !== "submitted").map((i) => i.interruptId);

      expect(open).toHaveLength(0);
      expect(decided).toContain(interruptId);
    });
  },
);
