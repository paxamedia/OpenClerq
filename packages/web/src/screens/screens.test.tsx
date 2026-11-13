import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OpenClerqApp } from '../App';
import { createFixtureClient } from '../fixtures';
import { matchCommands } from '../shell/Palette';
import { automationsModule } from './automations';
import { gatesOf, lineOf, scheduleOf, summarize, TEMPLATE, withSchedule } from './automations/spec';
import { chatModule } from './chat';
import { parseDiff, splitRows } from './runs/Diff';
import type { Approval, InboxItem } from '@clerq/gateway-client';
import { actionLabel, keyAction, type KeyState } from './inbox/Inbox';
import { gatewayModule, innerPath } from './InstalledModule';
import { parseHash } from '../app/router';
import { forgetTokens, hasDotSegment, moduleUiUrl, reusableToken } from '../shell/ModuleFrame';

describe('the app', () => {
  it('draws the rail with core pages and the modules it is given', () => {
    const html = renderToStaticMarkup(
      <OpenClerqApp
        client={createFixtureClient()}
        host={{ kind: 'web', version: '0.6.0', openUrl: () => {} }}
        modules={[automationsModule, chatModule]}
      />
    );
    for (const label of ['Home', 'Inbox', 'Automations', 'Runs', 'Chat', 'Developer', 'Settings']) {
      expect(html).toContain(`>${label}<`);
    }
    expect(html).toContain('href="#/m/automations"');
    expect(html).toContain('0.6.0');
  });

  it('draws without a module it was not given', () => {
    const html = renderToStaticMarkup(
      <OpenClerqApp
        client={createFixtureClient()}
        host={{ kind: 'web', version: '0.6.0', openUrl: () => {} }}
        modules={[automationsModule]}
      />
    );
    expect(html).not.toContain('href="#/m/chat"');
  });
});

describe('automation specs', () => {
  it('reads the template', () => {
    const s = summarize(TEMPLATE);
    expect(s.name).toBe('weekly-dependency-bumps');
    expect(s.schedule).toBe('0 8 * * 1');
    expect(s.repo).toBe('~/code/my-app');
    expect(gatesOf(TEMPLATE)).toEqual(['pnpm install --frozen-lockfile', 'pnpm test']);
    expect(s.perMonth).toBe('20');
  });

  it('lists diff assertions among the gates', () => {
    const source =
      "name: x\ngates:\n  - run: pnpm test\n  - assert: diff.files_changed <= 5\n  - assert: 'diff.touches_only [docs/]'\n";
    expect(gatesOf(source)).toEqual([
      'pnpm test',
      'diff.files_changed <= 5',
      'diff.touches_only [docs/]',
    ]);
  });

  it('rewrites only the schedule line', () => {
    const next = withSchedule(TEMPLATE, '30 6 * * 1-5');
    expect(scheduleOf(next)).toBe('30 6 * * 1-5');
    expect(next.split('\n').length).toBe(TEMPLATE.split('\n').length);
    expect(withSchedule('name: x\n', '0 9 * * *')).toContain("schedule: '0 9 * * *'");
  });

  it('finds the line a check points at', () => {
    expect(lineOf('bad indentation at line 4, column 3')).toBe(4);
    expect(lineOf('Missing name')).toBeNull();
  });
});

describe('diffs', () => {
  const diff = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 one
-two
+deux
 three
`;
  it('parses files, counts and line numbers', () => {
    const [f] = parseDiff(diff);
    expect(f.path).toBe('a.txt');
    expect([f.added, f.removed]).toEqual([1, 1]);
    expect(f.lines.find((l) => l.kind === 'add')?.newNo).toBe(2);
  });

  it('pairs removed and added lines side by side', () => {
    const rows = splitRows(parseDiff(diff)[0].lines);
    const changed = rows.find((r) => r.left?.kind === 'del');
    expect(changed?.right?.text).toBe('deux');
  });
});

describe('palette', () => {
  const cmds = ['Runs', 'Settings: Models & keys', 'New automation'].map((label) => ({
    id: label,
    label,
    run: () => {},
  }));
  it('matches every word, label starts first', () => {
    expect(matchCommands(cmds, 'auto').map((c) => c.id)).toEqual(['New automation']);
    expect(matchCommands(cmds, 'set keys').map((c) => c.id)).toEqual(['Settings: Models & keys']);
    expect(matchCommands(cmds, '')).toHaveLength(3);
  });
});

describe('modules from the gateway', () => {
  const info = {
    id: 'crm',
    name: 'CRM',
    version: '1.0.0',
    dir: '',
    status: 'loaded' as const,
    error: null,
    coreEndpoints: [],
    ui: '/api/modules/crm/ui/',
    badge: null,
    permissions: {
      exec: [],
      fs: { read: [], write: [] },
      net: [],
      secrets: [],
      services: [],
      llm: false,
    },
    permissionWarnings: [],
    triggers: [],
  };

  it('turns nav extensions into rail entries under /m/<id>', () => {
    const m = gatewayModule(info, [
      { moduleId: 'crm', id: 'deals', title: 'Deals', path: '/deals', order: 2 },
      { moduleId: 'crm', id: 'main', title: 'CRM', path: '/', order: 1 },
    ]);
    expect(m.rail.map((r) => [r.label, r.path])).toEqual([
      ['CRM', '/m/crm'],
      ['Deals', '/m/crm/deals'],
    ]);
  });

  it('keeps the same module object while nothing changes', () => {
    expect(gatewayModule(info, [])).toBe(gatewayModule({ ...info }, []));
    expect(gatewayModule(info, [])).not.toBe(gatewayModule({ ...info, status: 'failed' }, []));
  });

  it('passes the route inside the module through to its UI', () => {
    const route = parseHash('#/m/crm/deals/7?tab=notes');
    expect(innerPath({ parts: route.segments.slice(2), route })).toBe('/deals/7?tab=notes');
  });
});

describe('inbox', () => {
  it('names actions in plain words', () => {
    expect(actionLabel('git.push')).toBe('push');
    expect(actionLabel('custom.tool')).toBe('custom.tool');
  });
});

describe('inbox keys', () => {
  const item = { id: 'apr_7', kind: 'approval', title: 't' } as InboxItem;
  const plain = { id: 'tsk_1', kind: 'task', title: 't' } as InboxItem;
  const approval = (tier: Approval['tier']) => ({ id: 7, tier, tool: 'git.push' }) as Approval;
  const base = (over: Partial<KeyState> = {}): KeyState => ({
    key: 'a',
    repeat: false,
    now: 10_000,
    lastDecisionAt: 0,
    opened: item,
    approval: approval('low'),
    runLoaded: true,
    armed: null,
    ...over,
  });

  it('decides an opened, loaded approval', () => {
    expect(keyAction(base()).kind).toBe('approve');
    expect(keyAction(base({ key: 'D' })).kind).toBe('deny');
  });

  it('ignores a held key and keys just after a decision', () => {
    expect(keyAction(base({ repeat: true })).kind).toBe('none');
    expect(keyAction(base({ lastDecisionAt: 9_800 })).kind).toBe('none');
    expect(keyAction(base({ lastDecisionAt: 9_000 })).kind).toBe('approve');
  });

  it('does nothing when no item is open or the run has not loaded', () => {
    expect(keyAction(base({ opened: undefined, approval: undefined })).kind).toBe('none');
    expect(keyAction(base({ runLoaded: false })).kind).toBe('none');
  });

  it('asks for a second press to approve high risk, and never to deny', () => {
    const high = approval('high');
    expect(keyAction(base({ approval: high })).kind).toBe('arm');
    expect(keyAction(base({ approval: high, armed: { id: 7, at: 8_000 } })).kind).toBe('approve');
    expect(keyAction(base({ approval: high, armed: { id: 7, at: 1_000 } })).kind).toBe('arm');
    expect(keyAction(base({ approval: high, armed: { id: 8, at: 9_000 } })).kind).toBe('arm');
    expect(keyAction(base({ approval: high, key: 'd' })).kind).toBe('deny');
  });

  it('marks other items done or dismissed', () => {
    expect(keyAction(base({ opened: plain, approval: undefined })).kind).toBe('done');
    expect(keyAction(base({ opened: plain, approval: undefined, key: 'd' })).kind).toBe(
      'dismissed'
    );
  });
});

describe('module frames', () => {
  const base = 'http://127.0.0.1:7777';

  it('serves a path under the module and nowhere else', () => {
    expect(moduleUiUrl(base, 'crm', '/deals/7?tab=notes')).toBe(
      `${base}/api/modules/crm/ui/deals/7?tab=notes`
    );
    expect(moduleUiUrl(base, 'crm', '/')).toBe(`${base}/api/modules/crm/ui/`);
    expect(moduleUiUrl(base, 'crm', '/../other/')).toBeNull();
    expect(moduleUiUrl(base, 'crm', '/a/%2e%2e/%2E%2e/other/')).toBeNull();
    expect(moduleUiUrl(base, 'crm', '/a/..%2fother')).toBeNull();
    expect(moduleUiUrl(base, 'crm', '/a/./b')).toBeNull();
    expect(moduleUiUrl(base, 'crm', '/a/b%2Fc')).not.toBeNull();
    expect(hasDotSegment('/files/v1.2/..x')).toBe(false);
  });

  it('refuses dot segments in a route into a module', () => {
    const route = parseHash('/m/crm/%2e%2e/other');
    expect(innerPath({ parts: route.segments.slice(2), route })).toBe('/');
  });

  it('reuses a token that is not near expiry', async () => {
    forgetTokens();
    let minted = 0;
    const mint = async () => ({
      token: `t${++minted}`,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const [a, b] = await Promise.all([reusableToken('k', mint), reusableToken('k', mint)]);
    expect(a.token).toBe('t1');
    expect(b.token).toBe('t1');
    expect((await reusableToken('k', mint)).token).toBe('t1');
    expect((await reusableToken('k', mint, Date.now() + 580_000)).token).toBe('t2');
    expect(minted).toBe(2);
  });

  it('does not keep a failed mint', async () => {
    forgetTokens();
    await expect(reusableToken('f', () => Promise.reject(new Error('no')))).rejects.toThrow('no');
    const t = await reusableToken('f', async () => ({ token: 'ok', expiresAt: '2999-01-01' }));
    expect(t.token).toBe('ok');
  });
});
