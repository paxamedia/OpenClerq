/**
 * Smaller holes: what ctx.fetch passes on, and a change that arrives while the gateway is closing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  events,
  scratch,
  sleep,
  startGateway,
  writePlugin,
  type Running,
  type Scratch,
} from './plugins.harness.js';
import express from 'express';
import { closeStore, initStore } from '../store.js';
import { ModuleHost } from './host.js';

let s: Scratch;
let running: Running | undefined;

beforeEach(() => {
  s = scratch();
});

afterEach(async () => {
  await running?.close().catch(() => undefined);
  running = undefined;
  s.cleanup();
});

const start = async (config = {}) => (running = await startGateway(s, config));

describe('the small things', () => {
  it('ctx.fetch drops what could carry a request past the host check', async () => {
    const seenInit: Array<Record<string, unknown>> = [];
    const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
      seenInit.push({ ...init });
      return new Response('ok');
    }) as typeof fetch;
    writePlugin(s.modules, {
      id: 'net',
      permissions: { net: ['api.example.com'] },
      hooks: `register(ctx) {
        ctx.routes.get('/go', async (_q, r) => {
          const res = await ctx.fetch('https://api.example.com/x', { method: 'POST', headers: { a: 'b' }, body: 'x', dispatcher: { evil: true }, agent: 1, client: 2 });
          r.json({ status: res.status });
        });
      },`,
    });
    const gw = await start({ plugins: { fetch: fake } });
    expect(await gw.json('/api/modules/net/go')).toEqual({ status: 200 });
    expect(Object.keys(seenInit[0]).sort()).toEqual([
      'body',
      'headers',
      'method',
      'redirect',
      'signal',
    ]);
  });

  it('does not start a plugin that was queued behind the gateway closing', async () => {
    writePlugin(s.modules, {
      id: 'late',
      hooks: `register() { log.push('register'); },
        stop() { return new Promise((r) => setTimeout(r, 250)); },`,
    });
    await initStore(':memory:');
    const host = new ModuleHost(express());
    try {
      await host.loadAll(s.modules);
      expect(host.get('late')?.state).toBe('enabled');
      events('late').length = 0;
      // A disable is under way (its stop takes a while); an enable is in line behind it; then the gateway closes.
      const disabling = host.disable('late', 'test');
      await sleep(30);
      const enabling = host.enable('late', 'test');
      const closing = host.stopAll();
      const [, enable] = await Promise.allSettled([disabling, enabling, closing]);
      expect(enable.status).toBe('rejected');
      expect(events('late')).not.toContain('register');
      expect(host.get('late')?.state).not.toBe('enabled');
      // And nothing at all can be changed afterwards.
      await expect(host.setEnforce(true, 'test')).rejects.toThrow('stopping');
    } finally {
      closeStore();
    }
  });
});
