import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { GatewayError, type PluginInfo } from '@clerq/gateway-client';
import { EnvironmentContext } from '../../app/client';
import { LiveProvider, LiveStore } from '../../app/live';
import { createFixtureClient, FIXTURE_NOW } from '../../fixtures';
import { ToastProvider } from '../../ui/Toast';
import {
  approvalNote,
  approveReviewed,
  CHANGED_NOTE,
  changedSince,
  ENFORCE_NOTE,
  EnforceDialog,
  EnforceSwitch,
  PluginList,
  PluginRow,
  PluginsSection,
  ReviewDialog,
  rowActions,
  shortHash,
  stateTone,
  STATE_LABEL,
  wouldStop,
} from './plugins';
import { SETTINGS_SECTIONS } from './Settings';

const client = createFixtureClient({ now: FIXTURE_NOW });
const host = { kind: 'web' as const, version: '1.0.0', openUrl: () => {} };
const noop = () => {};

function html(node: ReactElement, held: Record<string, unknown> = {}): string {
  const store = new LiveStore();
  for (const [key, data] of Object.entries(held)) store.write(key, () => data);
  return renderToStaticMarkup(
    <EnvironmentContext.Provider value={{ client, host }}>
      <LiveProvider client={client} store={store}>
        <ToastProvider>{node}</ToastProvider>
      </LiveProvider>
    </EnvironmentContext.Provider>
  );
}

/** The fixture's plugins: one of each state and each approval. */
async function fixturePlugins(): Promise<Record<string, PluginInfo>> {
  const { plugins } = await createFixtureClient({ now: FIXTURE_NOW }).plugins();
  return Object.fromEntries(plugins.map((p) => [p.id, p]));
}

const row = (p: PluginInfo) =>
  html(
    <ul>
      <PluginRow plugin={p} onReview={noop} onEnable={noop} onDisable={noop} now={FIXTURE_NOW} />
    </ul>
  );

describe('the Plugins section', () => {
  it('is one of Settings’ sections, with words people look for', () => {
    const s = SETTINGS_SECTIONS.find((x) => x.id === 'plugins');
    expect(s?.label).toBe('Plugins');
    expect(s?.keywords).toContain('approve');
    expect(s?.keywords).toContain('enforce');
  });

  it('draws the list, the switch and every state from a primed store', async () => {
    // With enforcement on, the plugin nobody approved waits; every other state is in the fixture.
    const c = createFixtureClient({ now: FIXTURE_NOW });
    await c.setPluginSettings({ enforce: true });
    const data = await c.plugins();
    const out = html(<PluginsSection />, { plugins: data });
    expect(out).toContain('Plugins');
    expect(out).toContain('Enforce plugin permissions');
    for (const name of [
      'Notes',
      'Mailroom',
      'Ledger sync',
      'Old reports',
      'From the future',
      'Broken',
    ]) {
      expect(out).toContain(name);
    }
    for (const label of Object.values(STATE_LABEL)) expect(out).toContain(label);
    expect(out).toMatch(/role="switch"[^>]*aria-checked="true"/);
    // Off by default.
    const off = html(<PluginsSection />, { plugins: await client.plugins() });
    expect(off).toMatch(/role="switch"[^>]*aria-checked="false"/);
  });

  it('shows a skeleton before the list arrives, and an empty list in words', () => {
    expect(html(<PluginsSection />)).toContain('Loading plugins');
    const empty = html(
      <PluginList plugins={[]} onReview={noop} onEnable={noop} onDisable={noop} />
    );
    expect(empty).toContain('No plugins found');
    expect(empty).toContain('found at');
  });
});

describe('a plugin’s row', () => {
  it('says legacy for a module written before manifests had a version', async () => {
    const { notes, mailroom } = await fixturePlugins();
    expect(row(notes)).toContain('Legacy');
    expect(row(mailroom)).not.toContain('Legacy');
  });

  it('shows the state and where the approval stands, in words', async () => {
    const p = await fixturePlugins();
    expect(row(p.notes)).toContain('Enabled');
    expect(row(p.notes)).toContain('Approved');
    expect(row(p.mailroom)).toContain('Changed since you approved it');
    expect(row(p['ledger-sync'])).toContain('Not approved');
    expect(row(p['old-reports'])).toContain('Disabled');
    expect(row(p['from-the-future'])).toContain('Not supported');
    expect(row(p['from-the-future'])).toContain('needs OpenClerq API version 2');
    expect(row(p.broken)).toContain('Failed');
    expect(row(p.broken)).toContain('register() failed: cannot reach the database');
    // A plugin that cannot run has no approval to speak of.
    expect(row(p['from-the-future'])).not.toContain('Not approved');
  });

  it('says when the files on disk are not what is running', async () => {
    const { mailroom, notes } = await fixturePlugins();
    expect(row(mailroom)).toContain('Its files changed on disk');
    expect(row(notes)).not.toContain('Its files changed on disk');
  });

  it('offers Review for what is not approved, Enable for what is off, Disable for what runs', async () => {
    const p = await fixturePlugins();
    expect(rowActions(p.notes)).toEqual(['disable']);
    expect(rowActions(p.mailroom)).toEqual(['review', 'disable']);
    expect(rowActions(p['ledger-sync'])).toEqual(['review', 'disable']);
    expect(rowActions(p['old-reports'])).toEqual(['enable']);
    expect(rowActions(p.broken)).toEqual(['enable']);
    expect(rowActions(p['from-the-future'])).toEqual([]);
    expect(rowActions({ ...p['ledger-sync'], state: 'awaiting_approval' })).toEqual([
      'review',
      'disable',
    ]);
    expect(row(p.broken)).toContain('Try again');
    expect(row(p['old-reports'])).toContain('Enable');
    expect(row(p.notes)).toContain('Disable');
    expect(row(p['ledger-sync'])).toContain('Review');
    // What is approved can still be looked at.
    expect(row(p.notes)).toContain('Permissions');
  });

  it('colours the states', () => {
    expect(stateTone('enabled')).toBe('ok');
    expect(stateTone('failed')).toBe('err');
    expect(stateTone('awaiting_approval')).toBe('warn');
    expect(stateTone('disabled')).toBe('muted');
    expect(stateTone('refused')).toBe('muted');
  });

  it('says a bundled plugin ships with OpenClerq', async () => {
    const { notes } = await fixturePlugins();
    const bundled = { ...notes, approval: { ...notes.approval, approvedBy: 'bundled' } };
    expect(approvalNote(bundled)?.label).toBe('Approved, ships with OpenClerq');
  });
});

describe('reviewing a plugin', () => {
  const dialog = (p: PluginInfo, over: Partial<Parameters<typeof ReviewDialog>[0]> = {}) =>
    html(
      <ReviewDialog plugin={p} enforce={false} open onClose={noop} onApprove={noop} {...over} />
    );

  it('puts each permission in plain words, with what it names', async () => {
    const { mailroom } = await fixturePlugins();
    const out = dialog(mailroom);
    expect(out).toContain('Review · Mailroom');
    expect(out).toContain('Run programs');
    expect(out).toContain('Run these programs on this computer, as you.');
    expect(out).toContain('<code>/usr/bin/git</code>');
    expect(out).toContain('Use the network');
    expect(out).toContain('<code>imap.example.com</code>');
    expect(out).toContain('Use secrets');
    expect(out).toContain('<code>imap-password</code>');
    expect(out).toContain('Read files');
    expect(out).toContain('Call OpenClerq');
    expect(out).toContain('<code>GET /inbox</code>');
    expect(out).not.toContain('Use AI models');
  });

  it('shows what changed since the last approval: version, code and each permission', async () => {
    const { mailroom } = await fixturePlugins();
    const out = dialog(mailroom);
    expect(out).toContain('What changed since you approved it');
    expect(out).toContain('The version went from 1.1.0 to 1.2.0.');
    expect(out).toContain('Its code changed.');
    expect(out).toContain('Can now run /usr/bin/git');
    expect(out).toContain('Can now connect to *.mailroom.example.org');
  });

  it('has nothing about changes for a plugin seen for the first time', async () => {
    const p = (await fixturePlugins())['ledger-sync'];
    const out = dialog(p);
    expect(out).not.toContain('What changed');
    expect(out).toContain('Use AI models');
    expect(out).toContain('Read memory');
    expect(out).toContain('<code>fact</code>');
  });

  it('says so when a plugin asks for nothing', async () => {
    const p = (await fixturePlugins())['old-reports'];
    expect(dialog(p)).toContain('It asks for no permissions.');
  });

  it('has Approve and Cancel for a plugin that is not approved, and only Close for one that is', async () => {
    const p = await fixturePlugins();
    const unapproved = dialog(p['ledger-sync']);
    expect(unapproved).toContain('>Approve<');
    expect(unapproved).toContain('>Cancel<');
    const approved = dialog(p.notes);
    expect(approved).not.toContain('>Approve<');
    expect(approved).toContain('>Close<');
    expect(approved).toContain('Permissions · Notes');
  });

  it('says what approving records, and that a change asks again', async () => {
    const out = dialog((await fixturePlugins()).mailroom);
    expect(out).toContain('Approving records exactly this version and these permissions');
    expect(out).toContain('you will be asked again');
    expect(out).toContain('<code>222222222222</code>');
    expect(out).toContain('<code>111111111111</code>');
  });

  it('says what approval means in each mode, truthfully', async () => {
    const p = (await fixturePlugins())['ledger-sync'];
    expect(dialog(p, { enforce: false })).toContain('runs whether or not you approve it');
    expect(dialog(p, { enforce: true })).toContain('will not run until you approve it');
  });

  it('shows an error where it happened, and a warning the manifest gave', async () => {
    const p = (await fixturePlugins()).notes;
    const out = dialog(
      { ...p, warnings: ['"nonsense" is ignored.'] },
      { error: 'Nothing was approved.' }
    );
    expect(out).toContain('role="alert"');
    expect(out).toContain('Nothing was approved.');
    expect(out).toContain('&quot;nonsense&quot; is ignored.');
  });

  it('draws nothing while it is shut', async () => {
    const p = (await fixturePlugins()).notes;
    expect(dialog(p, { open: false })).not.toContain('What it asks for');
  });

  it('abbreviates a hash for the eye, and a missing one as a dash', () => {
    expect(shortHash('abcdef0123456789')).toBe('abcdef012345');
    expect(shortHash(null)).toBe('—');
  });
});

describe('a plugin that changes under an open review', () => {
  it('is told apart from the one that was opened: by either hash, or by being gone', async () => {
    const { mailroom } = await fixturePlugins();
    expect(changedSince(mailroom, { ...mailroom })).toBe(false);
    expect(changedSince(mailroom, { ...mailroom, checksum: 'f'.repeat(64) })).toBe(true);
    expect(changedSince(mailroom, { ...mailroom, permissionsHash: 'f'.repeat(64) })).toBe(true);
    expect(changedSince(mailroom, undefined)).toBe(true);
  });

  it('says so in the dialog and cannot be approved from it', async () => {
    const { mailroom } = await fixturePlugins();
    const dialog = (changed: boolean) =>
      html(
        <ReviewDialog
          plugin={mailroom}
          enforce={false}
          open
          changed={changed}
          onClose={noop}
          onApprove={noop}
        />
      );
    const changed = dialog(true);
    expect(changed).toContain(CHANGED_NOTE.replace(/'/g, '&#x27;'));
    expect(changed).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>)[\s\S])*Approve/);
    const same = dialog(false);
    expect(same).not.toContain('changed while you were reviewing it');
    expect(same).not.toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>)[\s\S])*Approve/);
  });
});

describe('approving', () => {
  it('sends the hashes it showed, no others', async () => {
    const approvePlugin = vi.fn().mockResolvedValue({});
    const p = (await fixturePlugins()).mailroom;
    expect(await approveReviewed({ approvePlugin }, p)).toEqual({ ok: true });
    expect(approvePlugin).toHaveBeenCalledWith('mailroom', {
      permissionsHash: p.permissionsHash,
      checksum: p.checksum,
    });
  });

  it('asks to review again when the plugin changed in between', async () => {
    const approvePlugin = vi
      .fn()
      .mockRejectedValue(new GatewayError('Gateway 409', 409, { error: 'approval_stale' }));
    const p = (await fixturePlugins()).mailroom;
    const out = await approveReviewed({ approvePlugin }, p);
    expect(out).toMatchObject({ ok: false, stale: true });
    expect((out as { message: string }).message).toContain(
      'Nothing was approved. Review it again.'
    );
  });

  it('says another refusal in the gateway’s words, and does not call without hashes', async () => {
    const approvePlugin = vi
      .fn()
      .mockRejectedValue(
        new GatewayError('Gateway 409', 409, { error: 'not_approvable', message: 'It cannot run.' })
      );
    const p = (await fixturePlugins()).mailroom;
    expect(await approveReviewed({ approvePlugin }, p)).toEqual({
      ok: false,
      stale: false,
      message: 'It cannot run.',
    });
    approvePlugin.mockClear();
    const out = await approveReviewed({ approvePlugin }, { ...p, checksum: null });
    expect(out.ok).toBe(false);
    expect(approvePlugin).not.toHaveBeenCalled();
  });

  it('works against the fixture client: stale is refused, the shown hashes are accepted', async () => {
    const c = createFixtureClient({ now: FIXTURE_NOW });
    const before = (await c.plugins()).plugins.find((p) => p.id === 'ledger-sync') as PluginInfo;
    const stale = await approveReviewed(c, { ...before, checksum: 'f'.repeat(64) });
    expect(stale).toMatchObject({ ok: false });
    expect(await approveReviewed(c, before)).toEqual({ ok: true });
    const after = (await c.plugins()).plugins.find((p) => p.id === 'ledger-sync') as PluginInfo;
    expect(after.approval.status).toBe('approved');
  });
});

describe('the enforcement switch', () => {
  it('is off or on as the gateway says, and has a label', () => {
    const off = html(<EnforceSwitch enforce={false} onChange={noop} />);
    expect(off).toMatch(/role="switch"[^>]*aria-checked="false"/);
    expect(off).toContain('Enforce plugin permissions');
    const on = html(<EnforceSwitch enforce onChange={noop} />);
    expect(on).toMatch(/role="switch"[^>]*aria-checked="true"/);
  });

  it('can be disabled while it saves', () => {
    expect(html(<EnforceSwitch enforce={false} busy onChange={noop} />)).toMatch(
      /role="switch"[^>]*disabled/
    );
  });

  it('says in one paragraph what it does, and what it does not', () => {
    const out = html(<EnforceSwitch enforce={false} onChange={noop} />);
    expect(out.match(/<p /g)).toHaveLength(1);
    expect(ENFORCE_NOTE).toContain('nothing is blocked');
    expect(ENFORCE_NOTE).toContain('does not run');
    expect(ENFORCE_NOTE).toContain('not a sandbox');
    expect(ENFORCE_NOTE).toContain('can still use the computer directly');
    // The page text is that paragraph, apostrophes and all.
    expect(out).toContain('not a sandbox');
  });

  it('asks first, naming the plugins that would stop', async () => {
    const p = await fixturePlugins();
    expect(wouldStop(Object.values(p))).toEqual(['Mailroom', 'Ledger sync']);
    const out = html(
      <EnforceDialog open names={['Mailroom', 'Ledger sync']} onClose={noop} onConfirm={noop} />
    );
    expect(out).toContain('Mailroom, Ledger sync have not been approved, and will stop');
    expect(out).toContain('>Turn on<');
    expect(out).toContain('>Leave it off<');
    const one = html(<EnforceDialog open names={['Mailroom']} onClose={noop} onConfirm={noop} />);
    expect(one).toContain('Mailroom has not been approved, and will stop until you approve it.');
    expect(html(<EnforceDialog open names={[]} onClose={noop} onConfirm={noop} />)).toContain(
      'none will stop'
    );
  });

  it('is changed through the client, and the fixture follows it', async () => {
    const c = createFixtureClient({ now: FIXTURE_NOW });
    expect(await c.pluginSettings()).toEqual({ enforce: false });
    expect(await c.setPluginSettings({ enforce: true })).toEqual({ enforce: true });
    const { plugins, enforce } = await c.plugins();
    expect(enforce).toBe(true);
    expect(plugins.find((p) => p.id === 'ledger-sync')?.state).toBe('awaiting_approval');
    expect(plugins.find((p) => p.id === 'notes')?.state).toBe('enabled');
    await c.setPluginSettings({ enforce: false });
    expect((await c.plugins()).plugins.find((p) => p.id === 'ledger-sync')?.state).toBe('enabled');
  });
});
