import { describe, expect, test } from 'vitest';

import {
  EventLog,
  type EventRow,
  fromRows,
  fromRunResponse,
} from './event-log.js';
import type { AguiEvent } from './events.js';

/** A whole run's worth of events, as `POST /agui/run` returns them (no seq). */
const run1: AguiEvent[] = [
  { type: 'run_started', data: { runId: 'r1' } },
  {
    type: 'text_message_start',
    data: { messageId: 'r1:m1', role: 'assistant' },
  },
  {
    type: 'text_message_content',
    data: { messageId: 'r1:m1', delta: 'Hello' },
  },
  { type: 'text_message_end', data: { messageId: 'r1:m1' } },
  { type: 'state_snapshot', data: { snapshot: { phase: 'greeted' } } },
  { type: 'run_finished', data: { outcome: { type: 'success' } } },
];

/** The same run as persisted rows (history / Realtime carry run_id + seq). */
function rowsFor(runId: string, events: AguiEvent[]): EventRow[] {
  return events.map((e, seq) => ({
    type: e.type,
    data: e.data,
    seq,
    run_id: runId,
  }));
}

describe('normalizers', () => {
  test('fromRunResponse tags a run batch with index-as-seq', () => {
    const keyed = fromRunResponse('r1', run1);
    expect(keyed[0]).toMatchObject({
      runId: 'r1',
      seq: 0,
      type: 'run_started',
    });
    expect(keyed[5]).toMatchObject({
      runId: 'r1',
      seq: 5,
      type: 'run_finished',
    });
  });

  test('fromRows maps snake-case run_id', () => {
    const keyed = fromRows([
      { type: 'run_started', data: {}, seq: 0, run_id: 'r1' },
    ]);
    expect(keyed[0]).toMatchObject({ runId: 'r1', seq: 0 });
  });
});

describe('EventLog', () => {
  test('folds a single run into the rendered view', () => {
    const log = new EventLog();
    log.add(fromRunResponse('r1', run1));
    const view = log.view();
    expect(view.phase).toBe('completed');
    expect(view.state).toEqual({ phase: 'greeted' });
    expect(view.messages).toEqual([
      { id: 'r1:m1', role: 'assistant', content: 'Hello' },
    ]);
  });

  test('deduplicates the run response against the same rows redelivered over Realtime', () => {
    const fromResponse = new EventLog();
    fromResponse.add(fromRunResponse('r1', run1));

    const reconciled = new EventLog();
    reconciled.add(fromRunResponse('r1', run1));
    // Realtime now pushes the same persisted rows — must not double-apply.
    const second = reconciled.add(fromRows(rowsFor('r1', run1)));

    expect(second).toBe(false);
    expect(reconciled.events()).toHaveLength(run1.length);
    expect(reconciled.view()).toEqual(fromResponse.view());
  });

  test('add reports whether the view changed', () => {
    const log = new EventLog();
    expect(log.add(fromRunResponse('r1', run1))).toBe(true);
    expect(log.add(fromRunResponse('r1', run1))).toBe(false);
  });

  test('reconnect == live: history seed + out-of-order live events fold identically', () => {
    const run2: AguiEvent[] = [
      { type: 'run_started', data: { runId: 'r2' } },
      {
        type: 'text_message_start',
        data: { messageId: 'r2:m1', role: 'assistant' },
      },
      {
        type: 'text_message_content',
        data: { messageId: 'r2:m1', delta: 'reading résumé' },
      },
      {
        type: 'state_delta',
        data: { delta: [{ op: 'replace', path: '/phase', value: 'done' }] },
      },
      { type: 'run_finished', data: { outcome: { type: 'success' } } },
    ];

    // A subscriber that saw everything live, in order.
    const live = new EventLog();
    live.add(fromRows(rowsFor('r1', run1)));
    live.add(fromRows(rowsFor('r2', run2)));

    // A reconnecting client: seed from history (run1 + the first 2 rows of run2),
    // then receive the rest over Realtime out of order.
    const r2rows = rowsFor('r2', run2);
    const reconnect = new EventLog();
    reconnect.add(fromRows(rowsFor('r1', run1)));
    reconnect.add(fromRows(r2rows.slice(0, 2)));
    reconnect.add(fromRows([r2rows[4], r2rows[3], r2rows[2]])); // shuffled

    expect(reconnect.view()).toEqual(live.view());
    expect(reconnect.view().state).toEqual({ phase: 'done' });
  });

  test('orders runs by first-seen even when a later run arrives first', () => {
    const log = new EventLog();
    log.add(fromRows(rowsFor('r2', run1))); // seen first → ordered first
    log.add(fromRows(rowsFor('r1', run1)));
    expect(log.events().map((e) => e.runId)).toEqual([
      ...Array(run1.length).fill('r2'),
      ...Array(run1.length).fill('r1'),
    ]);
  });
});
