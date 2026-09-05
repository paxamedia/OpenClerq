import { describe, it, expect, beforeEach } from 'vitest';
import { emit, subscribeEvents, recentEvents, resetEvents } from './events.js';

beforeEach(() => resetEvents());

describe('event bus', () => {
  it('delivers to every subscriber with correlation ids', () => {
    const seen: unknown[] = [];
    subscribeEvents((e) => seen.push(e));
    subscribeEvents((e) => seen.push(e));
    emit('run.started', { a: 1 }, { runId: 'r1' });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ name: 'run.started', context: { runId: 'r1' } });
  });

  it('unsubscribes cleanly', () => {
    let n = 0;
    const off = subscribeEvents(() => n++);
    emit('run.started', {});
    off();
    emit('run.started', {});
    expect(n).toBe(1);
  });

  it('does not let a throwing subscriber break the emitter or its peers', () => {
    let reached = 0;
    subscribeEvents(() => {
      throw new Error('bad subscriber');
    });
    subscribeEvents(() => reached++);
    expect(() => emit('run.started', {})).not.toThrow();
    expect(reached).toBe(1);
  });

  it('keeps a bounded backlog for priming a new stream', () => {
    for (let i = 0; i < 600; i++) emit('run.started', { i });
    const recent = recentEvents();
    expect(recent.length).toBe(500);
    // Oldest dropped, newest retained.
    expect((recent[recent.length - 1].payload as { i: number }).i).toBe(599);
  });

  it('stamps an ISO timestamp', () => {
    const e = emit('gateway.started', {});
    expect(e.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
