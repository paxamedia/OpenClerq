import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initStore, closeStore, getStore } from '../store.js';
import {
  createSession,
  listSessions,
  getSession,
  updateSession,
  deleteSession,
  addMessage,
  listMessages,
  conversation,
  SessionError,
} from './sessions.js';

beforeAll(async () => {
  await initStore(':memory:');
});

afterAll(() => {
  closeStore();
});

beforeEach(() => {
  getStore().exec('DELETE FROM sessions');
});

describe('sessions', () => {
  it('defaults to raw, the mode that adds nothing', () => {
    const s = createSession();
    expect(s.mode).toBe('raw');
    expect(s.title).toBeNull();
    expect(s.messageCount).toBe(0);
  });

  it('keeps the title, model and mode it was given', () => {
    const s = createSession({ title: 'Costs', mode: 'managed', model: 'deepseek/deepseek-chat' });
    expect(getSession(s.id)).toMatchObject({
      title: 'Costs',
      mode: 'managed',
      model: 'deepseek/deepseek-chat',
    });
  });

  it('refuses a mode that is neither raw nor managed', () => {
    expect(() => createSession({ mode: 'yolo' })).toThrow(SessionError);
    expect(() => createSession({ mode: 'yolo' })).toThrow(/must be "raw" or "managed"/);
  });

  it('lists most recently updated first, with message counts', () => {
    const first = createSession({ title: 'first' });
    const second = createSession({ title: 'second' });
    addMessage(first.id, { role: 'user', content: 'bump' });

    const listed = listSessions();
    expect(listed.map((s) => s.id)).toEqual([first.id, second.id]);
    expect(listed[0].messageCount).toBe(1);
  });

  it('updates only what it is given', () => {
    const s = createSession({ title: 'keep', model: 'x' });
    const updated = updateSession(s.id, { mode: 'managed' });
    expect(updated).toMatchObject({ title: 'keep', model: 'x', mode: 'managed' });
  });

  it('returns null for an unknown session rather than throwing', () => {
    expect(getSession('ses_nope')).toBeNull();
    expect(updateSession('ses_nope', { title: 'x' })).toBeNull();
    expect(deleteSession('ses_nope')).toBe(false);
  });

  it('takes the transcript with the session when it is deleted', () => {
    const s = createSession();
    addMessage(s.id, { role: 'user', content: 'hello' });
    expect(deleteSession(s.id)).toBe(true);
    expect(getStore().prepare('SELECT COUNT(*) AS n FROM messages').get()?.n).toBe(0);
  });
});

describe('messages', () => {
  it('round-trips an assistant turn with its metadata', () => {
    const s = createSession();
    addMessage(s.id, {
      role: 'assistant',
      content: 'the answer',
      meta: { provider: 'fake', costUsd: 0.5 },
    });
    const [message] = listMessages(s.id);
    expect(message.content).toBe('the answer');
    expect(message.meta).toMatchObject({ provider: 'fake', costUsd: 0.5 });
  });

  it('does not mistake a user message that starts with a brace for metadata', () => {
    const s = createSession();
    const json = '{"looks": "like json"}';
    addMessage(s.id, { role: 'user', content: json });
    expect(listMessages(s.id)[0].content).toBe(json);
  });

  it('gives the provider the conversation in order', () => {
    const s = createSession();
    addMessage(s.id, { role: 'user', content: 'one' });
    addMessage(s.id, { role: 'assistant', content: 'two', meta: { provider: 'fake' } });
    addMessage(s.id, { role: 'user', content: 'three' });

    expect(conversation(s.id)).toEqual([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
    ]);
  });

  it('touches the session so it sorts to the top', () => {
    const s = createSession();
    const before = getSession(s.id)!.updatedAt;
    addMessage(s.id, { role: 'user', content: 'hi' });
    expect(getSession(s.id)!.updatedAt >= before).toBe(true);
    expect(getSession(s.id)!.messageCount).toBe(1);
  });
});
