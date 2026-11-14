import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GatewayError, type SkillInfo } from '@clerq/gateway-client';
import { EnvironmentContext } from '../../app/client';
import { LiveProvider, LiveStore } from '../../app/live';
import { createFixtureClient, FIXTURE_NOW } from '../../fixtures';
import { ToastProvider } from '../../ui/Toast';
import { ENFORCE_NOTE, EnforceDialog, EnforceSwitch } from './plugins';
import {
  declaresSummary,
  originWords,
  SKILL_CHANGED_NOTE,
  SkillChecksum,
  SkillDialog,
  SkillNeedsList,
  skillActions,
  skillChangedSince,
  SkillsSection,
  SkillsTable,
  SkillWhatChanged,
  TRUST_LABEL,
  trustedByWords,
  trustReviewed,
  trustTone,
  untrustLabel,
  wouldSkip,
} from './skills';
import { SETTINGS_SECTIONS } from './Settings';

const host = { kind: 'web' as const, version: '1.0.0', openUrl: () => {} };
const noop = () => {};

function html(
  node: ReactElement,
  held: Record<string, unknown> = {},
  c = createFixtureClient({ now: FIXTURE_NOW })
) {
  const store = new LiveStore();
  for (const [key, data] of Object.entries(held)) store.write(key, () => data);
  return renderToStaticMarkup(
    <EnvironmentContext.Provider value={{ client: c, host }}>
      <LiveProvider client={c} store={store}>
        <ToastProvider>{node}</ToastProvider>
      </LiveProvider>
    </EnvironmentContext.Provider>
  );
}

async function fixtureSkills(c = createFixtureClient({ now: FIXTURE_NOW })) {
  const r = await c.skills();
  return {
    ...r,
    by: Object.fromEntries(r.skills.map((s) => [s.slug, s])) as Record<string, SkillInfo>,
  };
}

const dialog = (skill: SkillInfo, over: Partial<Parameters<typeof SkillDialog>[0]> = {}) =>
  html(
    <SkillDialog
      skill={skill}
      body="Explain the rule."
      enforce={false}
      open
      onClose={noop}
      onAction={noop}
      {...over}
    />
  );

describe('the Skills section', () => {
  it('is one of Settings’ sections, with words people look for', () => {
    const s = SETTINGS_SECTIONS.find((x) => x.id === 'skills');
    expect(s?.label).toBe('Skills');
    for (const word of ['trust', 'block', 'checksum', 'enforce', 'schema']) {
      expect(s?.keywords).toContain(word);
    }
  });

  it('draws the switch and every skill with its state, from a primed store', async () => {
    const data = await createFixtureClient({ now: FIXTURE_NOW }).skills();
    const out = html(<SkillsSection />, { skills: data });
    expect(out).toContain('Enforce what plugins and skills declare');
    expect(out).toMatch(/role="switch"[^>]*aria-checked="false"/);
    for (const name of ['VAT', 'Payroll', 'Reports', 'Old notes', 'Example', 'Mail triage']) {
      expect(out).toContain(name);
    }
    for (const label of Object.values(TRUST_LABEL)) expect(out).toContain(label);
    expect(out).toContain('Skills folder');
    expect(out).toContain('Plugin mailroom');
    expect(out).toContain('Module ledger-legacy');
  });

  it('shows the switch on when enforcement is on', async () => {
    const c = createFixtureClient({ now: FIXTURE_NOW });
    await c.setPluginSettings({ enforce: true });
    const out = html(<SkillsSection />, { skills: await c.skills() }, c);
    expect(out).toMatch(/role="switch"[^>]*aria-checked="true"/);
  });

  it('shows a skeleton before the list arrives, and an empty list in words', () => {
    expect(html(<SkillsSection />)).toContain('Loading skills');
    expect(html(<SkillsTable skills={[]} onOpen={noop} />)).toContain('No skills here');
  });

  it('says what the switch does and does not do, in one paragraph that covers skills', () => {
    const out = html(<EnforceSwitch enforce={false} onChange={noop} />);
    expect(out).toContain(ENFORCE_NOTE.slice(0, 40));
    for (const part of [
      'what a plugin or a skill declares is shown and recorded',
      'a skill you have blocked is still not used',
      'a skill you have not trusted, or that has changed since you trusted it, is not used',
      'narrow the tools a chat is offered',
      'limit the chat’s file tools to the paths it lists',
      'Sandboxed chat',
      'not a sandbox',
      'A skill is text for the model, not code',
      'commands in a chat that is not Sandboxed are not limited',
    ]) {
      expect(ENFORCE_NOTE, part).toContain(part);
    }
    expect(ENFORCE_NOTE).not.toContain('\n');
  });
});

describe('a skill in the list', () => {
  it('has a state, in words and colour', () => {
    expect(TRUST_LABEL).toEqual({
      untrusted: 'Not trusted',
      trusted: 'Trusted',
      modified: 'Changed',
      blocked: 'Blocked',
    });
    expect(trustTone('trusted')).toBe('ok');
    expect(trustTone('modified')).toBe('warn');
    expect(trustTone('blocked')).toBe('err');
    expect(trustTone('untrusted')).toBe('muted');
  });

  it('says what it declares in a few words', async () => {
    const { by } = await fixtureSkills();
    expect(declaresSummary(by['vat-core'].declared)).toBe('2 tools · 1 host · 2 paths');
    expect(declaresSummary(by['mail-triage'].declared)).toBe('1 host');
    expect(declaresSummary(by.example.declared)).toBe('Nothing');
    expect(declaresSummary({ tools: ['a'], domains: [], paths: [] })).toBe('1 tool');
  });

  it('says where it comes from, and who vouches for it', async () => {
    expect(originWords('directory')).toBe('Skills folder');
    expect(originWords('plugin:mailroom')).toBe('Plugin mailroom');
    expect(originWords('module:old')).toBe('Module old');
    const { by } = await fixtureSkills();
    expect(trustedByWords(by['vat-core'])).toBe('You trusted it');
    expect(trustedByWords(by.example)).toBe('Ships with OpenClerq');
    expect(trustedByWords(by['mail-triage'])).toBe('Approved with its plugin (mailroom)');
    expect(trustedByWords(by['payroll-base'])).toBeNull();
  });

  it('names the skills that would stop being used when enforcement is turned on', async () => {
    const { skills } = await fixtureSkills();
    expect(wouldSkip(skills)).toEqual(['Payroll', 'Reports']);
  });
});

describe('what a skill’s dialog offers', () => {
  it('Trust for what is not trusted, Untrust and Block for what is, and only Unblock for a block', async () => {
    const { by } = await fixtureSkills();
    expect(skillActions(by['payroll-base'])).toEqual(['trust', 'block']);
    expect(skillActions(by.reports)).toEqual(['trust', 'untrust', 'block']);
    expect(skillActions(by['vat-core'])).toEqual(['untrust', 'block']);
    expect(skillActions(by['old-notes'])).toEqual(['untrust']);
    expect(untrustLabel(by['old-notes'])).toBe('Unblock');
    expect(untrustLabel(by['vat-core'])).toBe('Untrust');
  });

  it('never offers Trust for a plugin’s skill, which is approved with the plugin, or one that cannot be hashed', async () => {
    const { by } = await fixtureSkills();
    expect(skillActions(by['mail-triage'])).toEqual(['block']);
    expect(skillActions({ ...by['payroll-base'], computedChecksum: null })).toEqual(['block']);
    expect(skillActions({ ...by['mail-triage'], trust: 'untrusted' })).toEqual(['block']);
  });

  it('puts what it declares in plain words', async () => {
    const { by } = await fixtureSkills();
    const out = html(<SkillNeedsList skill={by['vat-core']} />);
    expect(out).toContain('Use tools');
    expect(out).toContain('Its instructions use these tools.');
    expect(out).toContain('<code>fs.read</code>');
    expect(out).toContain('<code>group:fs</code>');
    expect(out).toContain('Reach websites');
    expect(out).toContain('<code>ecb.europa.eu</code>');
    expect(out).toContain('Use files');
    expect(out).toContain('<code>~/Notes</code>');
    expect(html(<SkillNeedsList skill={by.example} />)).toContain('It declares no needs.');
  });

  it('for Trust, shows what is being trusted: the state, what it declares, its checksum and its instructions', async () => {
    const { by } = await fixtureSkills();
    const out = dialog(by['payroll-base']);
    expect(out).toContain('Payroll');
    expect(out).toContain('Not trusted');
    expect(out).toContain('You have not decided on this skill.');
    expect(out).toContain('<code>shell.exec</code>');
    expect(out).toContain(
      'tools_required: &quot;shell.exec&quot; is not a tool OpenClerq has. Did you mean runtime.shell?'
    );
    expect(out).toContain('Trusting records exactly these files (checksum');
    expect(out).toContain('<code>bbbbbbbbbbbb</code>');
    expect(out).toContain('If any file changes, you will be asked again.');
    expect(out).toContain('Explain the rule.');
    expect(out).toContain('>Trust<');
    expect(out).toContain('>Block<');
    expect(out).not.toContain('>Untrust<');
  });

  it('says what enforcement means for the decision, off and on', async () => {
    const { by } = await fixtureSkills();
    expect(dialog(by['payroll-base'])).toContain(
      'Enforcement is off, so the skill is used whether or not you trust it.'
    );
    expect(dialog(by['payroll-base'], { enforce: true })).toContain(
      'Enforcement is on: the skill is not used until you trust it.'
    );
  });

  it('cannot Trust until its instructions have been read, or after it changed under the dialog', async () => {
    const { by } = await fixtureSkills();
    expect(dialog(by['payroll-base'], { body: null })).toMatch(
      /disabled=""[^>]*>[^<]*(<[^>]*>)*Trust</
    );
    const changed = dialog(by['payroll-base'], { changed: true });
    expect(changed).toContain(SKILL_CHANGED_NOTE);
    expect(changed).toMatch(/disabled=""[^>]*>[^<]*(<[^>]*>)*Trust</);
    expect(dialog(by['payroll-base'], { error: 'Nope.' })).toContain('Nope.');
  });

  it('for a skill that changed, says since when and what: files, what it declares and the version', async () => {
    const { by } = await fixtureSkills();
    const out = dialog(by.reports);
    expect(out).toContain('Changed');
    expect(out).toContain('Its files have changed since you trusted it.');
    expect(out).toContain('What changed since you trusted it');
    expect(out).toContain('The version went from 1.0.0 to 1.1.0.');
    expect(out).toContain('SKILL.md changed.');
    expect(out).toContain('templates/q.md was added.');
    expect(out).toContain('Now says it uses the tool fs.write');
    expect(out).toContain('>Trust<');
    expect(out).toContain('>Untrust<');
    expect(html(<SkillWhatChanged skill={by['vat-core']} />)).toBe('');
    expect(html(<SkillWhatChanged skill={by['payroll-base']} />)).toBe('');
  });

  it('shows its checksum and whether it is the one its author published', async () => {
    const { by } = await fixtureSkills();
    expect(html(<SkillChecksum skill={by['vat-core']} />)).toContain(
      'It matches the checksum in SKILL.md.'
    );
    expect(html(<SkillChecksum skill={by.reports} />)).toContain(
      'It does not match the checksum in SKILL.md, so the files are not what the author published.'
    );
    expect(html(<SkillChecksum skill={by['payroll-base']} />)).toContain(
      'SKILL.md does not declare a checksum.'
    );
    expect(
      html(<SkillChecksum skill={{ ...by['payroll-base'], computedChecksum: null }} />)
    ).toContain('Its files could not be hashed.');
  });

  it('says a plugin’s skill is approved with its plugin, and a blocked one that it was blocked', async () => {
    const { by } = await fixtureSkills();
    const plug = dialog(by['mail-triage']);
    expect(plug).toContain('Approved with its plugin.');
    expect(plug).toContain('approved with it, in Settings → Plugins');
    expect(plug).not.toContain('>Trust<');
    const blocked = dialog(by['old-notes']);
    expect(blocked).toContain('You blocked this skill.');
    expect(blocked).toContain('>Unblock<');
  });

  it('shows what a problem with the files is', async () => {
    const { by } = await fixtureSkills();
    const out = dialog({
      ...by['payroll-base'],
      computedChecksum: null,
      problem: '"link.txt" is a link.',
    });
    expect(out).toContain('&quot;link.txt&quot; is a link.');
    expect(out).not.toContain('>Trust<');
  });
});

describe('deciding', () => {
  it('trusts the checksum it was shown, and the fixture follows', async () => {
    const c = createFixtureClient({ now: FIXTURE_NOW });
    const { by } = await fixtureSkills(c);
    expect(await trustReviewed(c, by['payroll-base'])).toEqual({ ok: true });
    expect((await c.skills()).skills.find((s) => s.slug === 'payroll-base')).toMatchObject({
      trust: 'trusted',
      trustedBy: 'user',
    });
  });

  it('says so, and trusts nothing, when the skill changed since it was shown', async () => {
    const c = createFixtureClient({ now: FIXTURE_NOW });
    const { by } = await fixtureSkills(c);
    const stale = {
      trustSkill: () =>
        Promise.reject(new GatewayError('Gateway 409', 409, { error: 'trust_stale' })),
    };
    const out = await trustReviewed(stale, {
      slug: 'payroll-base',
      computedChecksum: 'sha256:old',
    });
    expect(out).toMatchObject({ ok: false, stale: true });
    expect(out.ok ? '' : out.message).toContain('Nothing was trusted. Look at it again.');
    expect((await c.skills()).skills.find((s) => s.slug === 'payroll-base')?.trust).toBe(
      'untrusted'
    );
    expect(by['payroll-base'].trust).toBe('untrusted');
  });

  it('does not ask for a checksum there is not, and reports any other failure as it is', async () => {
    const c = createFixtureClient({ now: FIXTURE_NOW });
    expect(await trustReviewed(c, { slug: 'x', computedChecksum: null })).toMatchObject({
      ok: false,
      stale: false,
    });
    const failing = {
      trustSkill: () =>
        Promise.reject(new GatewayError('Gateway 500', 500, { error: 'skill_trust_failed' })),
    };
    expect(await trustReviewed(failing, { slug: 'x', computedChecksum: 'sha256:a' })).toMatchObject(
      {
        ok: false,
        stale: false,
      }
    );
  });

  it('blocks and forgets, and the fixture follows', async () => {
    const c = createFixtureClient({ now: FIXTURE_NOW });
    expect((await c.blockSkill('vat-core')).skill.trust).toBe('blocked');
    expect((await c.untrustSkill('vat-core')).skill.trust).toBe('untrusted');
    expect((await c.skills()).skills.find((s) => s.slug === 'vat-core')?.trustedBy).toBeNull();
  });

  it('notices when the list shows something other than what the dialog was opened on', async () => {
    const { by } = await fixtureSkills();
    expect(skillChangedSince(by['vat-core'], by['vat-core'])).toBe(false);
    expect(
      skillChangedSince(by['vat-core'], { ...by['vat-core'], computedChecksum: 'sha256:x' })
    ).toBe(true);
    expect(skillChangedSince(by['vat-core'], undefined)).toBe(true);
  });

  it('asks before turning enforcement on, naming the skills that would stop', () => {
    const out = html(
      <EnforceDialog open skillNames={['Payroll', 'Reports']} onClose={noop} onConfirm={noop} />
    );
    expect(out).toContain('Enforce what plugins and skills declare?');
    expect(out).toContain(
      'Payroll, Reports have not been trusted, and will not be used until you trust them.'
    );
    expect(out).toContain('A plugin you have not approved will stop.');
    expect(html(<EnforceDialog open skillNames={[]} onClose={noop} onConfirm={noop} />)).toContain(
      'Every skill is trusted'
    );
    expect(html(<EnforceDialog open names={[]} onClose={noop} onConfirm={noop} />)).toContain(
      'A skill you have not trusted will stop being used.'
    );
  });
});
