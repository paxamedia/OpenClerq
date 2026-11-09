import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OpenClerqApp } from '../App';
import { createFixtureClient } from '../fixtures';
import { matchCommands } from '../shell/Palette';
import { automationsModule } from './automations';
import { gatesOf, lineOf, scheduleOf, summarize, TEMPLATE, withSchedule } from './automations/spec';
import { chatModule } from './chat';
import { parseDiff, splitRows } from './runs/Diff';
import { actionLabel } from './inbox/Inbox';
import { gatewayModule, innerPath } from './InstalledModule';
import { parseHash } from '../app/router';

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
