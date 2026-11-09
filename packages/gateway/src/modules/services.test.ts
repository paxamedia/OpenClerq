/**
 * Service control against a fake launchctl that keeps its state in a file.
 * No test here may run the real launchctl or name a real agent.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initStore, closeStore } from '../store.js';
import { ModuleServices, ServiceError, servicesOf } from './services.js';

const LABEL = 'test.clerq.fake-worker';
let dir = '';
let log = '';
let saved: string | undefined;

beforeAll(async () => {
  await initStore(':memory:');
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-launchctl-'));
  log = path.join(dir, 'calls.log');
  const state = path.join(dir, 'loaded');
  const fake = path.join(dir, 'launchctl');
  fs.writeFileSync(
    fake,
    `#!/bin/sh
echo "$@" >> "${log}"
case "$1" in
  print)
    if [ -f "${state}" ]; then
      printf '%s = {\\n\\tstate = running\\n\\tpid = 4242\\n\\tlast exit code = 0\\n}\\n' "$2"; exit 0
    fi
    echo "Could not find service" >&2; exit 113 ;;
  bootstrap) touch "${state}"; exit 0 ;;
  kickstart) [ -f "${state}" ] || exit 113; exit 0 ;;
  bootout) rm -f "${state}"; exit 0 ;;
esac
exit 1
`,
    { mode: 0o755 }
  );
  fs.writeFileSync(path.join(dir, `${LABEL}.plist`), '<plist/>');
  saved = process.env.CLERQ_LAUNCHCTL;
  process.env.CLERQ_LAUNCHCTL = fake;
});

afterAll(() => {
  if (saved === undefined) delete process.env.CLERQ_LAUNCHCTL;
  else process.env.CLERQ_LAUNCHCTL = saved;
  fs.rmSync(dir, { recursive: true, force: true });
  closeStore();
});

describe('module services', () => {
  it('reads declarations, defaulting the plist', () => {
    const decls = servicesOf({
      services: ['a.b', { label: 'c.d', plist: '/x.plist' }, { label: 'bad label' }],
    });
    expect(decls.map((d) => d.label)).toEqual(['a.b', 'c.d']);
    expect(decls[0].plist).toBe(path.join(os.homedir(), 'Library', 'LaunchAgents', 'a.b.plist'));
  });

  // Several process spawns; slow on a loaded machine.
  it('starts, reports and stops a declared agent', { timeout: 60_000 }, async () => {
    const s = new ModuleServices('m', [{ label: LABEL, plist: path.join(dir, `${LABEL}.plist`) }]);
    expect(await s.status(LABEL)).toMatchObject({ loaded: false, running: false });
    expect(await s.start(LABEL)).toMatchObject({
      loaded: true,
      running: true,
      pid: 4242,
      lastExitCode: 0,
    });
    expect(await s.stop(LABEL)).toMatchObject({ loaded: false });
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    const uid = process.getuid?.() ?? 0;
    expect(calls).toContain(`bootstrap gui/${uid} ${path.join(dir, `${LABEL}.plist`)}`);
    expect(calls).toContain(`kickstart gui/${uid}/${LABEL}`);
    expect(calls).toContain(`bootout gui/${uid}/${LABEL}`);
  });

  it('refuses a label the manifest does not declare', async () => {
    const s = new ModuleServices('m', [{ label: LABEL, plist: '/nowhere.plist' }]);
    await expect(s.start('com.example.other')).rejects.toBeInstanceOf(ServiceError);
    await expect(s.start(LABEL)).rejects.toThrow(/does not exist/);
  });
});
